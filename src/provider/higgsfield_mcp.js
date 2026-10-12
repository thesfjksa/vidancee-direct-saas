const crypto = require('node:crypto');
const { appUrl: currentAppUrl, currentUrl } = require('../app_url.js');
const dns = require('node:dns');

// Hostinger/Linux VPS environments can resolve Cloudflare-fronted MCP hosts to
// IPv6 first even when outbound IPv6 is unavailable. In Node this surfaces only
// as "TypeError: fetch failed". Prefer IPv4 for the Higgsfield MCP transport.
// This affects lookup order only; HTTPS/TLS and OAuth validation remain intact.
try {
  if (typeof dns.setDefaultResultOrder === 'function') dns.setDefaultResultOrder('ipv4first');
} catch {}
const {
  Client,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  IssuerMismatchError,
} = require('@modelcontextprotocol/client');
const {
  getProviderSettings,
  getSettingValue,
  setSettingValue,
  deleteSettingValue,
} = require('../settings.js');
const { getPool, dbConfigured } = require('../db.js');
const {
  humanizeModelId,
  canonicalPublicModelId,
  syncProviderModels,
  getProviderModelByPublicId,
  quarantineProviderUtilityModels,
} = require('../provider_models.js');

const PROVIDER = 'higgsfield';
const AUTH_KEYS = {
  tokens: 'higgsfield_oauth_tokens',
  clientInfo: 'higgsfield_oauth_client_info',
  verifier: 'higgsfield_oauth_code_verifier',
  discovery: 'higgsfield_oauth_discovery_state',
  state: 'higgsfield_oauth_state',
  redirect: 'higgsfield_oauth_redirect_url',
  jobsWait: 'higgsfield_jobs_wait_tool',
  lastSync: 'higgsfield_last_sync_at',
};

function parseJson(value, fallback = null) {
  if (!value) return fallback;
  try { return JSON.parse(String(value)); }
  catch { return fallback; }
}

function schemaProperties(schema) {
  return schema && typeof schema === 'object' && schema.properties && typeof schema.properties === 'object'
    ? schema.properties
    : {};
}

function enumEntries(schema) {
  if (!schema || typeof schema !== 'object') return [];
  const out = [];

  if (Array.isArray(schema.enum)) {
    const labels = Array.isArray(schema['x-enumNames']) ? schema['x-enumNames'] : [];
    schema.enum.forEach((value, index) => out.push({ value, label: labels[index] || null }));
  }
  if (schema.const !== undefined) out.push({ value: schema.const, label: schema.title || null });

  for (const key of ['oneOf', 'anyOf']) {
    if (!Array.isArray(schema[key])) continue;
    for (const item of schema[key]) {
      if (!item || typeof item !== 'object') continue;
      if (item.const !== undefined) out.push({ value: item.const, label: item.title || item.description || null });
      else if (Array.isArray(item.enum)) {
        for (const value of item.enum) out.push({ value, label: item.title || item.description || null });
      }
    }
  }

  const seen = new Set();
  return out.filter(item => {
    const k = JSON.stringify(item.value);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function propertyByNames(schema, names) {
  const props = schemaProperties(schema);
  for (const name of names) if (props[name]) return { name, schema: props[name] };
  return null;
}

function numberOptions(prop) {
  if (!prop) return [];
  const values = enumEntries(prop.schema).map(item => Number(item.value)).filter(Number.isFinite);
  if (values.length) return [...new Set(values)].sort((a, b) => a - b);

  const min = Number(prop.schema.minimum);
  const max = Number(prop.schema.maximum);
  if (Number.isInteger(min) && Number.isInteger(max) && min >= 0 && max >= min && max - min <= 30) {
    const out = [];
    for (let n = min; n <= max; n += 1) out.push(n);
    return out;
  }

  const def = Number(prop.schema.default);
  return Number.isFinite(def) ? [def] : [];
}

function stringOptions(prop) {
  if (!prop) return [];
  return enumEntries(prop.schema)
    .map(item => String(item.value == null ? '' : item.value).trim())
    .filter(Boolean);
}

function defaultValue(prop) {
  if (!prop || !prop.schema || prop.schema.default === undefined) return null;
  return prop.schema.default;
}

function inferModelMedia(modelId, toolText) {
  const hay = String(modelId || '').toLowerCase();

  // Prefer recognizable model-family semantics before generic tool wording.
  // A unified tool description may mention both images and videos.
  if (/seedance|kling|veo|sora|wan|hailuo|video|pixverse|runway|luma|pika/.test(hay)) return 'video';
  if (/nano.?banana|seedream|flux|recraft|ideogram|gpt.?image|imagen|soul|image/.test(hay)) return 'image';

  const toolHay = String(toolText || '').toLowerCase();
  if (/\baudio\b|music|speech|voice/.test(toolHay) && !/video|image/.test(toolHay)) return null;
  if (/\bvideo\b|animate|motion/.test(toolHay) && !/\bimage\b|photo|picture/.test(toolHay)) return 'video';
  if (/\bimage\b|photo|picture/.test(toolHay) && !/\bvideo\b|animate|motion/.test(toolHay)) return 'image';
  return null;
}

function inferMode(mediaType, toolText) {
  const hay = String(toolText || '').toLowerCase();
  if (mediaType === 'video') {
    if (/image.?to.?video|reference.?to.?video|animate.?image|image reference/.test(hay)) return 'image-to-video';
    if (/text.?to.?video/.test(hay)) return 'text-to-video';
    return 'video';
  }
  if (/reference.?to.?image|image.?to.?image|edit|reference image/.test(hay)) return 'reference-to-image';
  if (/text.?to.?image/.test(hay)) return 'text-to-image';
  return 'image';
}

function knownCreativeModelFamily(value) {
  const hay = String(value || '').toLowerCase().replace(/[._/-]+/g, ' ');
  return /\b(seedance|kling|veo|sora|wan|hailuo|minimax|grok|omni flash|nano banana|seedream|flux|recraft|ideogram|gpt image|imagen|soul|qwen|pixverse|runway|luma|pika)\b/.test(hay);
}

function isUtilityTool(tool) {
  const hay = [tool?.name, tool?.title, tool?.description].filter(Boolean).join(' ').toLowerCase();
  return /\b(analysis|analy[sz]e|predictor|virality|preset|presets|action|actions|jobs?|history|balance|credits?|status|list|search|upscale|audio|music|speech|voice|marketing|studio|workflow|template|templates)\b/.test(hay)
    && !/\b(generate|generation|create|render)\b/.test(hay);
}

function isLikelyGenerationTool(tool) {
  if (!tool || isUtilityTool(tool)) return false;
  const hay = [tool?.name, tool?.title, tool?.description].filter(Boolean).join(' ').toLowerCase();
  const schema = tool?.inputSchema || {};
  const props = schemaProperties(schema);
  const directNames = Object.keys(props).map(x => x.toLowerCase());
  const hasPromptish = directNames.some(name => ['prompt','text','description','params','input','arguments'].includes(name));
  const hasGenerateVerb = /\b(generate|generation|create|render)\b/.test(hay);
  const hasCreativeMedia = /\b(video|image|photo|picture|animate|motion)\b/.test(hay);
  return (hasGenerateVerb && hasCreativeMedia) || hasPromptish;
}

function selectTool(model, mode) {
  const tools = Array.isArray(model.tools) ? model.tools : [];
  if (!tools.length) {
    return { name: model.toolName, schema: model.inputSchema || {}, mode: mode || model.mediaType };
  }

  const desired = String(mode || '');
  const exact = tools.find(tool => tool.mode === desired);
  if (exact) return exact;

  if (model.mediaType === 'video') {
    if (desired === 'image-to-video') {
      const ref = tools.find(tool => /image|reference/.test(String(tool.mode)));
      if (ref) return ref;
    }
    const text = tools.find(tool => tool.mode === 'text-to-video');
    if (text) return text;
    const generic = tools.find(tool => tool.mode === 'video');
    if (generic) return generic;
  } else {
    if (desired === 'reference-to-image') {
      const ref = tools.find(tool => /reference|image-to-image/.test(String(tool.mode)));
      if (ref) return ref;
    }
    const text = tools.find(tool => tool.mode === 'text-to-image');
    if (text) return text;
    const generic = tools.find(tool => tool.mode === 'image');
    if (generic) return generic;
  }

  return tools[0];
}

function appendIfSupported(args, props, names, value) {
  if (value === undefined || value === null || value === '') return false;
  for (const name of names) {
    if (!props[name]) continue;
    args[name] = value;
    return true;
  }
  return false;
}

function canonicalToolName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function findTool(tools, name) {
  const wanted = canonicalToolName(name);
  return (Array.isArray(tools) ? tools : []).find(tool => {
    const current = canonicalToolName(tool?.name);
    return current === wanted || current.endsWith('_' + wanted);
  }) || null;
}

function wrapToolPayload(tool, payload) {
  const schema = tool?.inputSchema || {};
  const props = schemaProperties(schema);

  // Higgsfield's generation tools expose one params object. Some MCP clients
  // render that object as one JSON field, so support object and JSON-string forms.
  for (const name of ['params', 'arguments', 'input']) {
    if (!props[name]) continue;
    if (props[name].type === 'string') return { [name]: JSON.stringify(payload) };
    return { [name]: payload };
  }

  return payload;
}

function appendMediaReferences(params, mediaReferences) {
  const medias = (Array.isArray(mediaReferences) ? mediaReferences : [])
    .filter(item => item && item.value)
    .map(item => ({
      value: String(item.value),
      role: String(item.role || 'image'),
    }));
  if (medias.length) params.medias = medias;
}

function buildToolArguments(model, input = {}, mediaReferences = [], { getCost = false } = {}) {
  const tool = selectTool(model, input.mode);
  if (!tool?.name) throw new Error('This model does not have a generation tool.');

  const params = {
    model: model.providerModelId,
  };

  const prompt = String(input.prompt || '').trim();
  if (prompt) params.prompt = prompt;

  const duration = Number(input.duration);
  if (Number.isFinite(duration) && duration > 0) params.duration = duration;

  if (input.resolution) params.resolution = String(input.resolution);
  const ratio = input.aspectRatio || input.aspect_ratio;
  if (ratio) params.aspect_ratio = String(ratio);

  appendMediaReferences(params, mediaReferences);

  const modes = Array.isArray(model.modes) ? model.modes : [];
  if (mediaReferences.length && modes.includes('omni_reference')) {
    params.mode = 'omni_reference';
  } else if (!mediaReferences.length && modes.includes('t2v')) {
    params.mode = 't2v';
  } else if (model.defaultMode) {
    params.mode = model.defaultMode;
  }

  params.count = 1;
  if (getCost) params.get_cost = true;

  const args = wrapToolPayload(tool, params);
  return { tool, args };
}

function resultObjects(result) {
  const out = [];
  if (result && typeof result.structuredContent === 'object' && result.structuredContent !== null) {
    out.push(result.structuredContent);
  }
  for (const block of Array.isArray(result?.content) ? result.content : []) {
    if (!block || block.type !== 'text' || !block.text) continue;
    const text = String(block.text).trim();
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object') out.push(parsed);
    } catch {
      let parsedEmbedded = null;
      const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
      const candidate = fenced ? fenced[1] : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
      if (candidate && candidate.trim()) {
        try { parsedEmbedded = JSON.parse(candidate); } catch {}
      }
      if (parsedEmbedded && typeof parsedEmbedded === 'object') out.push(parsedEmbedded);
      else out.push({ __text: text });
    }
  }
  return out;
}

function recursiveValues(value, callback, depth = 0) {
  if (depth > 6 || value == null) return;
  if (typeof value !== 'object') return;
  callback(value);
  if (Array.isArray(value)) {
    for (const item of value) recursiveValues(item, callback, depth + 1);
  } else {
    for (const child of Object.values(value)) recursiveValues(child, callback, depth + 1);
  }
}

function firstByKeys(objects, keys) {
  let found = null;
  for (const root of objects) {
    recursiveValues(root, obj => {
      if (found !== null || !obj || Array.isArray(obj)) return;
      for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== null && obj[key] !== undefined) {
          found = obj[key];
          return;
        }
      }
    });
    if (found !== null) break;
  }
  return found;
}


function collectCatalogItems(value, expectedType, out = [], depth = 0) {
  if (depth > 7 || value == null) return out;

  if (Array.isArray(value)) {
    for (const item of value) collectCatalogItems(item, expectedType, out, depth + 1);
    return out;
  }

  if (typeof value !== 'object') return out;

  const id = value.id ?? value.model_id ?? value.modelId;
  const outputType = String(value.output_type || value.type || '').toLowerCase();
  const looksLikeModel = id != null && (
    value.name != null ||
    value.provider_name != null ||
    value.parameters != null ||
    value.aspect_ratios != null ||
    value.durations != null ||
    value.duration_range != null
  );
  const typeOkay = !expectedType || !outputType || outputType === expectedType;

  if (looksLikeModel && typeOkay) {
    out.push(value);
    return out;
  }

  for (const child of Object.values(value)) collectCatalogItems(child, expectedType, out, depth + 1);
  return out;
}

function uniqueCatalogItems(items) {
  const seen = new Set();
  const out = [];
  for (const item of items || []) {
    const id = String(item?.id ?? item?.model_id ?? item?.modelId ?? '').trim();
    if (!id) continue;
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function parameterEntries(parameters) {
  if (!parameters) return [];
  if (Array.isArray(parameters)) {
    return parameters
      .filter(item => item && typeof item === 'object')
      .map(item => ({
        name: String(item.name || item.id || item.key || '').trim(),
        ...item,
      }))
      .filter(item => item.name);
  }
  if (typeof parameters === 'object') {
    return Object.entries(parameters).map(([name, spec]) => ({
      name,
      ...(spec && typeof spec === 'object' ? spec : { value: spec }),
    }));
  }
  return [];
}

function parameterByName(parameters, names) {
  const wanted = new Set(names.map(name => String(name).toLowerCase()));
  return parameterEntries(parameters).find(item => wanted.has(String(item.name).toLowerCase())) || null;
}

function parameterChoices(parameter) {
  if (!parameter || typeof parameter !== 'object') return [];
  const candidates = [];
  for (const key of ['enum', 'values', 'options', 'choices', 'allowed_values']) {
    const value = parameter[key];
    if (Array.isArray(value)) candidates.push(...value);
  }
  return candidates
    .map(value => {
      if (value && typeof value === 'object') return value.value ?? value.id ?? value.name;
      return value;
    })
    .filter(value => value !== undefined && value !== null && String(value).trim() !== '');
}

function parameterDefault(parameter) {
  if (!parameter || typeof parameter !== 'object') return null;
  for (const key of ['default', 'default_value', 'value']) {
    if (parameter[key] !== undefined && parameter[key] !== null && parameter[key] !== '') return parameter[key];
  }
  return null;
}

function continuousDurationRange(range) {
  if (!range || typeof range !== 'object') return [];
  const min = Number(range.min ?? range.minimum ?? range.from);
  const max = Number(range.max ?? range.maximum ?? range.to);
  if (!Number.isInteger(min) || !Number.isInteger(max) || min <= 0 || max < min || max - min > 60) return [];
  const out = [];
  for (let n = min; n <= max; n += 1) out.push(n);
  return out;
}

function catalogMediaRoles(medias) {
  const out = [];
  const push = value => {
    const role = String(value || '').trim();
    if (role && !out.includes(role)) out.push(role);
  };

  const walk = value => {
    if (!value) return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (typeof value === 'string') {
      push(value);
      return;
    }
    if (typeof value !== 'object') return;
    if (value.role) push(value.role);
    if (Array.isArray(value.roles)) value.roles.forEach(push);
    for (const child of Object.values(value)) {
      if (child !== value.role && child !== value.roles && (Array.isArray(child) || (child && typeof child === 'object'))) {
        walk(child);
      }
    }
  };

  walk(medias);
  return out;
}

function catalogModelFromItem(item, mediaType, generationTool) {
  const providerModelId = String(item.id ?? item.model_id ?? item.modelId ?? '').trim();
  if (!providerModelId) return null;

  const label = String(item.name || humanizeModelId(providerModelId)).trim();
  const parameters = item.parameters || {};
  const durationParam = parameterByName(parameters, ['duration', 'seconds', 'length']);
  const resolutionParam = parameterByName(parameters, ['resolution']);
  const aspectParam = parameterByName(parameters, ['aspect_ratio', 'aspectRatio', 'ratio']);
  const modeParam = parameterByName(parameters, ['mode']);

  let durations = Array.isArray(item.durations)
    ? item.durations.map(Number).filter(Number.isFinite)
    : parameterChoices(durationParam).map(Number).filter(Number.isFinite);
  if (!durations.length) durations = continuousDurationRange(item.duration_range);

  const resolutions = parameterChoices(resolutionParam).map(String).filter(Boolean);
  const aspectRatios = (
    Array.isArray(item.aspect_ratios) && item.aspect_ratios.length
      ? item.aspect_ratios
      : parameterChoices(aspectParam)
  ).map(String).filter(Boolean);

  const mode = mediaType === 'video' ? 'video' : 'image';

  return {
    providerModelId,
    publicModelId: canonicalPublicModelId(providerModelId, label, mediaType),
    label,
    mediaType,
    toolName: generationTool.name,
    inputSchema: generationTool.inputSchema || {},
    options: {
      catalogVerified: true,
      providerName: item.provider_name ? String(item.provider_name) : null,
      durations: [...new Set(durations)].sort((a, b) => a - b),
      resolutions: [...new Set(resolutions)],
      aspectRatios: [...new Set(aspectRatios)],
      defaultDuration: Number(parameterDefault(durationParam)) || null,
      defaultResolution: parameterDefault(resolutionParam) == null ? null : String(parameterDefault(resolutionParam)),
      defaultAspectRatio: parameterDefault(aspectParam) == null ? null : String(parameterDefault(aspectParam)),
      mediaRoles: catalogMediaRoles(item.medias),
      referenceCapabilities: catalogReferenceCapabilities(item, mediaType, catalogMediaRoles(item.medias)),
      modes: parameterChoices(modeParam).map(String).filter(Boolean),
      defaultMode: parameterDefault(modeParam) == null ? null : String(parameterDefault(modeParam)),
      tools: [{
        name: generationTool.name,
        mode,
        schema: generationTool.inputSchema || {},
        description: generationTool.description || '',
      }],
    },
  };
}

async function exploreCatalogType(client, modelsTool, mediaType) {
  const payload = { action: 'list', type: mediaType, limit: 100 };
  const args = wrapToolPayload(modelsTool, payload);
  const result = await client.callTool({ name: modelsTool.name, arguments: args }, { timeout: 30000 });
  const objects = resultObjects(result);
  const items = [];
  for (const obj of objects) collectCatalogItems(obj, mediaType, items);
  return uniqueCatalogItems(items);
}


const OFFICIAL_IMAGE_MODELS = [
  ['gpt_image_2_5','GPT Image 2.5',['image_references'],['1:1','3:2','2:3','4:3','3:4','16:9','9:16','21:9','4:5','5:4'],['1k','2k','4k']],
  ['gpt_image_2','GPT Image 2',['image_references'],['1:1','4:3','3:4','16:9','21:9','9:16','3:2','2:3','4:5','5:4'],['1k','2k','4k']],
  ['nano_banana_flash','Nano Banana 2',['image_references'],['1:1','3:2','2:3','4:3','3:4','4:5','5:4','9:16','16:9','21:9'],['1k','2k','4k']],
  ['nano_banana_2','Nano Banana Pro',['image_references'],['1:1','3:2','2:3','4:3','3:4','4:5','5:4','9:16','16:9','21:9'],['1k','2k','4k']],
  ['nano_banana_2_lite','Nano Banana 2 Lite',['image_references'],['auto','1:1','3:2','2:3','4:3','3:4','4:5','5:4','9:16','16:9','21:9'],['1k']],
  ['nano_banana','Nano Banana',['image_references'],['1:1','3:2','2:3','4:3','3:4','4:5','5:4','9:16','16:9','21:9'],[]],
  ['seedream_v5_pro','Seedream 5.0 Pro',['image_references'],['1:1','4:3','3:4','16:9','9:16','3:2','2:3'],['1k','1.5k','2k']],
  ['seedream_v5_lite','Seedream V5 Lite',['image_references'],['1:1','4:3','3:4','16:9','9:16'],[]],
  ['seedream_v4_5','Seedream 4.5',['image_references'],['1:1','4:3','16:9','3:2','21:9','3:4','9:16','2:3'],[]],
  ['text2image_soul_v2','Higgsfield Soul V2',['image_references'],['1:1','16:9','9:16','4:3','3:4','3:2','2:3'],[]],
  ['soul_cinematic','Soul Cinematic',['image_references'],['1:1','16:9','9:16','4:3','3:4','3:2','2:3','21:9'],[]],
  ['soul_cinema_studio','Soul Cinema Studio',['image_references'],['1:1','16:9','9:16','4:3','3:4','3:2','2:3','21:9'],[]],
  ['soul_cast','Soul Cast',[],['16:9'],[]],
  ['soul_location','Soul Location',[],['1:1','16:9','9:16','4:3','3:4','3:2','2:3','21:9','9:21'],[]],
  ['flux_2','FLUX.2',['image_references'],['1:1','4:3','3:4','16:9','9:16'],['1k','2k']],
  ['flux_kontext','Flux Kontext',['image_references'],['1:1','4:3','3:4','16:9','9:16'],[]],
  ['recraft_v4_1','Recraft V4.1',[],['1:1','3:4','4:3','4:5','5:4','3:2','2:3','16:9','9:16'],['1k','2k']],
  ['kling_omni_image','Kling O1 Image',['image_references'],['1:1','auto','16:9','9:16','4:3','3:4','3:2','2:3','21:9'],['1k','2k']],
  ['grok_image','Grok Image',['image_references'],['1:1','auto','1:2','2:1','3:2','2:3','4:3','3:4','16:9','9:16'],['1k','2k']],
  ['cinematic_studio_2_5','Cinema Studio Image 2.5',['image_references'],['1:1','3:2','2:3','4:3','3:4','4:5','5:4','16:9','9:16','21:9'],['1k','2k','4k']],
  ['marketing_studio_image','Marketing Studio Image',['image_references'],['auto','1:1','3:2','2:3','4:3','3:4','4:5','5:4','9:16','16:9','21:9'],['1k','2k','4k']],
  ['image_auto','Image Auto',['image_references'],['1:1','4:3','3:4','16:9','9:16'],[]],
  ['openai_hazel','OpenAI Hazel',['image_references'],['1:1','3:2','2:3','auto'],[]],
  ['z_image','Z Image',[],['1:1','4:3','3:4','16:9','9:16'],[]],
];

const OFFICIAL_VIDEO_MODELS = [
  ['seedance_2_5','Seedance 2.5',[4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30],['480p','720p','1080p'],['auto','21:9','16:9','4:3','1:1','3:4','9:16'],['start_image','end_image','image_references'],['t2v','omni_reference','video_edit','video_extension'],'t2v'],
  ['seedance_2_0','Seedance 2.0',[4,5,6,7,8,9,10,11,12,13,14,15],['480p','720p','1080p','4k'],['auto','16:9','9:16','4:3','3:4','1:1','21:9'],['image','start_image','end_image'],['std','fast'],'std'],
  ['seedance_2_0_mini','Seedance 2.0 Mini',[4,5,6,7,8,9,10,11,12,13,14,15],['480p','720p'],['auto','16:9','9:16','4:3','3:4','1:1','21:9'],['image','start_image','end_image'],[],null],
  ['seedance1_5','Seedance 1.5 Pro',[4,8,12],['480p','720p','1080p'],['auto','16:9','9:16','4:3','3:4','1:1','21:9'],['start_image','end_image'],[],null],
  ['kling3_0','Kling 3.0',[3,4,5,6,7,8,9,10,11,12,13,14,15],[],['16:9','9:16','1:1'],['start_image','end_image'],['std','pro','4k'],'std'],
  ['kling3_0_turbo','Kling 3.0 Turbo',[3,4,5,6,7,8,9,10,11,12,13,14,15],['720p','1080p'],['16:9','9:16','1:1'],['start_image'],[],null],
  ['kling2_6','Kling 2.6 Video',[5,10],[],['16:9','9:16','1:1'],['start_image'],[],null],
  ['veo3_1','Google Veo 3.1',[4,6,8],[],['16:9','9:16'],['start_image'],[],null],
  ['veo3_1_lite','Google Veo 3.1 Lite',[4,6,8],[],['16:9','9:16','auto'],['start_image','end_image'],[],null],
  ['veo3','Google Veo 3',[8],[],['16:9','9:16'],['start_image'],[],null],
  ['gemini_omni','Gemini Omni Flash',[4,6,8,10],['720p'],['16:9','9:16'],['image_references'],[],null],
  ['wan2_7','Wan 2.7',[5,6,7,8,9,10,11,12,13,14,15],['720p','1080p'],['16:9','9:16','1:1','4:3','3:4'],['start_image','end_image'],[],null],
  ['wan2_6','Wan 2.6 Video',[5,10,15],[],['16:9','9:16','1:1'],['image_references'],[],null],
  ['minimax_hailuo','Minimax Hailuo',[6,10],['512','768','1080'],['16:9','9:16','1:1'],['start_image','end_image'],[],null],
  ['minimax_h3','MiniMax H3',[4,5,6,7,8,9,10,11,12,13,14,15],['480p','768p'],['16:9','9:16','1:1','4:3'],['start_image'],[],null],
  ['minimax_h3_max','MiniMax H3 Max',[4,5,6,7,8,9,10,11,12,13,14,15],[],['16:9','9:16','1:1'],['start_image'],[],null],
  ['grok_video','Grok Video',[5,6,7,8,9,10],[],['16:9','9:16','1:1'],['start_image'],[],null],
  ['grok_video_v15','Grok Video 1.5',[2,3,4,5,6,7,8,9,10,11,12,13,14,15],['480p','720p'],['16:9','9:16'],['start_image'],[],null],
  ['cinematic_studio_video_4_0','Cinema Studio 4.0',[5,10,15,20,25,30],['480p','720p','1080p'],['auto','21:9','16:9','4:3','1:1','3:4','9:16'],['start_image','end_image','image_references'],['t2v','omni_reference','video_edit','video_extension'],'t2v'],
  ['cinematic_studio_video_3_5','Cinema Studio Video 3.5',[5,10,15,20,25,30],['480p','720p','1080p'],['auto','21:9','16:9','4:3','1:1','3:4','9:16'],['start_image','end_image','image_references'],[],null],
  ['cinematic_studio_3_0','Cinema Studio 3.0',[5,10,15],['480p','720p','1080p','4k'],['auto','21:9','16:9','4:3','1:1','3:4','9:16'],['start_image','end_image','image_references'],[],null],
  ['cinematic_studio_video','Cinema Studio Video',[5,10],[],['1:1','4:3','3:4','16:9','9:16'],['start_image','end_image'],[],null],
  ['cinematic_studio_video_v2','Cinema Studio Video V2',[5,10],[],['1:1','4:3','3:4','16:9','9:16'],['start_image','end_image','image_references'],['std','pro'],'std'],
  ['marketing_studio_video','Marketing Studio Video',[5,10,15,20,25,30],['480p','720p','1080p'],['auto','21:9','16:9','4:3','1:1','3:4','9:16'],['image','start_image','end_image'],[],null],
  ['wan3_0','Wan 3.0',[5,10],[],['16:9','9:16','1:1'],['image_references'],[],null],
  ['wan3_0_prime','Wan 3.0 Prime',[5,10],[],['16:9','9:16','1:1'],['image_references'],[],null],
  ['flux_3_video','FLUX.3 Video',[5,10],[],['16:9','9:16','1:1'],['start_image'],[],null],
];


const OFFICIAL_REFERENCE_LIMITS = {
  // Image models
  cinematic_studio_2_5:{image:{max:14,roles:['image_references']},totalMax:14},
  flux_2:{image:{max:8,roles:['image_references']},totalMax:8},
  flux_kontext:{image:{max:4,roles:['image_references']},totalMax:4},
  gpt_image_2:{image:{max:16,roles:['image_references']},totalMax:16},
  gpt_image_2_5:{image:{max:16,roles:['image_references']},totalMax:16},
  grok_image:{image:{max:8,roles:['image_references']},totalMax:8},
  image_auto:{image:{max:14,roles:['image_references']},totalMax:14},
  kling_omni_image:{image:{max:10,roles:['image_references']},totalMax:10},
  marketing_studio_image:{image:{max:14,roles:['image_references']},totalMax:14},
  nano_banana:{image:{max:8,roles:['image_references']},totalMax:8},
  nano_banana_2:{image:{max:14,roles:['image_references']},totalMax:14},
  nano_banana_2_lite:{image:{max:14,roles:['image_references']},totalMax:14},
  nano_banana_flash:{image:{max:14,roles:['image_references']},totalMax:14},
  openai_hazel:{image:{max:16,roles:['image_references']},totalMax:16},
  seedream_v4_5:{image:{max:14,roles:['image_references']},totalMax:14},
  seedream_v5_lite:{image:{max:14,roles:['image_references']},totalMax:14},
  seedream_v5_pro:{image:{max:14,roles:['image_references']},totalMax:14},
  soul_cinematic:{image:{max:1,roles:['image_references']},totalMax:1},
  soul_cinema_studio:{image:{max:1,roles:['image_references']},totalMax:1},
  text2image_soul_v2:{image:{max:1,roles:['image_references']},totalMax:1},

  // Video models
  seedance_2_5:{
    image:{max:9,roles:['start_image','end_image','image_references']},
    totalMax:9,
  },
  seedance_2_0:{
    image:{max:9,roles:['start_image','end_image','image_references']},
    video:{max:3,roles:['video_references']},
    audio:{max:3,roles:['audio_references']},
    totalMax:12,
  },
  seedance_2_0_mini:{
    image:{max:9,roles:['start_image','end_image','image_references']},
    video:{max:3,roles:['video_references']},
    audio:{max:3,roles:['audio_references']},
    totalMax:12,
  },
  seedance1_5:{image:{max:2,roles:['start_image','end_image']},totalMax:2},
  kling3_0:{image:{max:2,roles:['start_image','end_image']},totalMax:2},
  kling3_0_turbo:{image:{max:1,roles:['start_image']},totalMax:1},
  kling2_6:{image:{max:1,roles:['start_image']},totalMax:1},
  veo3_1:{image:{max:1,roles:['start_image']},totalMax:1},
  veo3_1_lite:{image:{max:2,roles:['start_image','end_image']},totalMax:2},
  veo3:{image:{max:1,min:1,roles:['start_image'],requiredRoles:['start_image']},totalMax:1},
  gemini_omni:{
    image:{max:7,roles:['image_references']},
    video:{max:1,roles:['video_references']},
    totalMax:8,
  },
  wan2_7:{
    image:{max:2,roles:['start_image','end_image']},
    audio:{max:1,roles:['audio_references']},
    totalMax:3,
  },
  wan2_6:{
    image:{max:6,roles:['image_references']},
    video:{max:3,roles:['video_references']},
    audio:{max:3,roles:['audio_references']},
    totalMax:8,
  },
  minimax_hailuo:{image:{max:2,roles:['start_image','end_image']},totalMax:2},
  minimax_h3:{image:{max:1,roles:['start_image']},totalMax:1},
  minimax_h3_max:{image:{max:1,roles:['start_image']},totalMax:1},
  grok_video:{image:{max:1,roles:['start_image']},totalMax:1},
  grok_video_v15:{image:{max:1,min:1,roles:['start_image'],requiredRoles:['start_image']},totalMax:1},
  cinematic_studio_video_4_0:{
    image:{max:9,roles:['start_image','end_image','image_references']},
    video:{max:3,roles:['video_references']},
    audio:{max:3,roles:['audio_references']},
    totalMax:15,
  },
  cinematic_studio_video_3_5:{
    image:{max:15,roles:['start_image','end_image','image_references']},
    video:{max:3,roles:['video_references']},
    audio:{max:3,roles:['audio_references']},
    totalMax:15,
  },
  cinematic_studio_3_0:{
    image:{max:15,roles:['start_image','end_image','image_references']},
    video:{max:3,roles:['video_references']},
    audio:{max:3,roles:['audio_references']},
    totalMax:15,
  },
  cinematic_studio_video:{image:{max:2,roles:['start_image','end_image']},totalMax:2},
  cinematic_studio_video_v2:{image:{max:6,roles:['start_image','end_image','image_references']},totalMax:6},
  marketing_studio_video:{image:{max:6,roles:['start_image','end_image','image_references']},totalMax:6},
  wan3_0:{image:{max:6,roles:['image_references']},video:{max:2,roles:['video_references']},totalMax:8},
  wan3_0_prime:{image:{max:6,roles:['image_references']},video:{max:2,roles:['video_references']},totalMax:8},
  flux_3_video:{image:{max:1,roles:['start_image']},totalMax:1},
};

function normalizeReferenceCapabilities(source, mediaType, fallbackRoles = []) {
  const raw = source && typeof source === 'object' ? source : {};
  const normalize = (kind, roles) => {
    const spec = raw[kind] && typeof raw[kind] === 'object' ? raw[kind] : {};
    const normalizedRoles = Array.isArray(spec.roles) && spec.roles.length ? spec.roles.map(String) : roles;
    return {
      supported: normalizedRoles.length > 0 || Number(spec.max || 0) > 0,
      max: Math.max(0, Number(spec.max || 0)),
      min: Math.max(0, Number(spec.min || 0)),
      roles: [...new Set(normalizedRoles)],
      requiredRoles: Array.isArray(spec.requiredRoles) ? [...new Set(spec.requiredRoles.map(String))] : [],
    };
  };

  const fallbackImageRoles = fallbackRoles.filter(role => ['image','image_references','input_images','start_image','end_image','reference_image'].includes(role));
  const fallbackVideoRoles = fallbackRoles.filter(role => ['video','video_references','input_videos','reference_video'].includes(role));
  const fallbackAudioRoles = fallbackRoles.filter(role => ['audio','audio_references','input_audio','reference_audio'].includes(role));

  const image = normalize('image', fallbackImageRoles);
  const video = normalize('video', fallbackVideoRoles);
  const audio = normalize('audio', fallbackAudioRoles);
  const totalMax = Math.max(0, Number(raw.totalMax || 0));

  return {
    textOnly: !image.supported && !video.supported && !audio.supported,
    totalMax,
    image,
    video,
    audio,
  };
}

function catalogReferenceCapabilities(item, mediaType, mediaRoles) {
  const caps = { image:{}, video:{}, audio:{} };
  const inspect = value => {
    if (!value || typeof value !== 'object') return;
    const role = String(value.role || value.name || '').trim();
    if (role) {
      let kind = '';
      if (/video/i.test(role)) kind = 'video';
      else if (/audio/i.test(role)) kind = 'audio';
      else if (/image|frame/i.test(role)) kind = 'image';
      if (kind) {
        const spec = caps[kind];
        const max = Number(value.max ?? value.max_count ?? value.maximum ?? value.limit);
        const min = Number(value.min ?? value.min_count ?? value.minimum ?? (value.required ? 1 : 0));
        if (Number.isFinite(max) && max > 0) spec.max = Math.max(Number(spec.max || 0), max);
        if (Number.isFinite(min) && min > 0) spec.min = Math.max(Number(spec.min || 0), min);
        spec.roles = [...new Set([...(spec.roles || []), role])];
        if (value.required === true) spec.requiredRoles = [...new Set([...(spec.requiredRoles || []), role])];
      }
    }
    for (const child of Object.values(value)) {
      if (child && typeof child === 'object') inspect(child);
    }
  };
  inspect(item?.medias);

  const official = OFFICIAL_REFERENCE_LIMITS[String(item?.id ?? item?.model_id ?? item?.modelId ?? '')] || {};
  const merged = {
    totalMax: Number(caps.totalMax || official.totalMax || 0),
    image: {...(official.image || {}), ...(caps.image || {})},
    video: {...(official.video || {}), ...(caps.video || {})},
    audio: {...(official.audio || {}), ...(caps.audio || {})},
  };
  return normalizeReferenceCapabilities(merged, mediaType, mediaRoles);
}

function officialFallbackModels(tools) {
  const imageTool = findTool(tools, 'generate_image');
  const videoTool = findTool(tools, 'generate_video');
  const models = [];

  if (imageTool) {
    for (const [providerModelId,label,mediaRoles,aspectRatios,resolutions] of OFFICIAL_IMAGE_MODELS) {
      models.push({
        providerModelId,
        publicModelId: canonicalPublicModelId(providerModelId,label,'image'),
        label,
        mediaType:'image',
        toolName:imageTool.name,
        inputSchema:imageTool.inputSchema||{},
        options:{
          catalogVerified:true,
          catalogSource:'official-cli-fallback',
          durations:[],
          resolutions,
          aspectRatios,
          defaultDuration:null,
          defaultResolution:resolutions[0]||null,
          defaultAspectRatio:aspectRatios.includes('1:1')?'1:1':(aspectRatios[0]||null),
          mediaRoles,
          referenceCapabilities:normalizeReferenceCapabilities(OFFICIAL_REFERENCE_LIMITS[providerModelId], 'image', mediaRoles),
          modes:[],
          defaultMode:null,
          tools:[{name:imageTool.name,mode:'image',schema:imageTool.inputSchema||{},description:imageTool.description||''}],
        },
      });
    }
  }

  if (videoTool) {
    for (const [providerModelId,label,durations,resolutions,aspectRatios,mediaRoles,modes,defaultMode] of OFFICIAL_VIDEO_MODELS) {
      models.push({
        providerModelId,
        publicModelId: canonicalPublicModelId(providerModelId,label,'video'),
        label,
        mediaType:'video',
        toolName:videoTool.name,
        inputSchema:videoTool.inputSchema||{},
        options:{
          catalogVerified:true,
          catalogSource:'official-cli-fallback',
          durations,
          resolutions,
          aspectRatios,
          defaultDuration:durations[0]||null,
          defaultResolution:resolutions[0]||null,
          defaultAspectRatio:aspectRatios.includes('16:9')?'16:9':(aspectRatios[0]||null),
          mediaRoles,
          referenceCapabilities:normalizeReferenceCapabilities(OFFICIAL_REFERENCE_LIMITS[providerModelId], 'video', mediaRoles),
          modes,
          defaultMode,
          tools:[{name:videoTool.name,mode:'video',schema:videoTool.inputSchema||{},description:videoTool.description||''}],
        },
      });
    }
  }

  return models;
}

async function exploreCatalogModel(client, modelsTool, modelId, mediaType, generationTool) {
  const args = wrapToolPayload(modelsTool, { action:'get', model_id:String(modelId) });
  const result = await client.callTool({ name:modelsTool.name, arguments:args }, { timeout:30000 });
  const objects = resultObjects(result);
  const items = [];
  for (const obj of objects) collectCatalogItems(obj, mediaType, items);
  const item = uniqueCatalogItems(items).find(entry =>
    String(entry.id ?? entry.model_id ?? entry.modelId ?? '') === String(modelId)
  ) || uniqueCatalogItems(items)[0];
  return item ? catalogModelFromItem(item, mediaType, generationTool) : null;
}

async function enrichOfficialFallbackModels(client, tools, models) {
  const modelsTool = findTool(tools, 'models_explore');
  const imageTool = findTool(tools, 'generate_image');
  const videoTool = findTool(tools, 'generate_video');
  if (!modelsTool || !imageTool || !videoTool || !Array.isArray(models) || !models.length) {
    return { models, enrichedCount:0 };
  }

  const output = new Array(models.length);
  let nextIndex = 0;
  let enrichedCount = 0;

  async function worker() {
    while (true) {
      const index = nextIndex++;
      if (index >= models.length) return;
      const seed = models[index];
      try {
        const generationTool = seed.mediaType === 'image' ? imageTool : videoTool;
        const live = await exploreCatalogModel(client, modelsTool, seed.providerModelId, seed.mediaType, generationTool);
        if (live) {
          // Keep our stable neutral public ID, but prefer the account's live
          // model name/parameters/media constraints.
          live.publicModelId = seed.publicModelId;
          output[index] = live;
          enrichedCount += 1;
          continue;
        }
      } catch (error) {
        console.warn('Higgsfield model capability refresh failed for', seed.providerModelId, networkErrorDetails(error) || error?.message || error);
      }
      output[index] = seed;
    }
  }

  await Promise.all([worker(),worker(),worker(),worker()]);
  return { models:output.filter(Boolean), enrichedCount };
}

async function discoverModelsFromCatalog(client, tools) {
  const modelsTool = findTool(tools, 'models_explore');
  const imageTool = findTool(tools, 'generate_image');
  const videoTool = findTool(tools, 'generate_video');
  if (!modelsTool || !imageTool || !videoTool) return [];

  const [imageItems, videoItems] = await Promise.all([
    exploreCatalogType(client, modelsTool, 'image'),
    exploreCatalogType(client, modelsTool, 'video'),
  ]);

  const models = [];
  for (const item of imageItems) {
    const model = catalogModelFromItem(item, 'image', imageTool);
    if (model) models.push(model);
  }
  for (const item of videoItems) {
    const model = catalogModelFromItem(item, 'video', videoTool);
    if (model) models.push(model);
  }
  return models;
}

function extractUploadInfo(result) {
  const objects = resultObjects(result);
  const mediaId = firstByKeys(objects, ['media_id', 'mediaId', 'id']);
  const uploadUrl = firstByKeys(objects, ['upload_url', 'uploadUrl', 'presigned_url', 'presignedUrl']);
  return {
    mediaId: mediaId == null ? null : String(mediaId),
    uploadUrl: typeof uploadUrl === 'string' ? uploadUrl : null,
  };
}

async function uploadHiggsfieldMedia(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  if (!list.length) return [];

  return withAuthenticatedClient(async client => {
    const listed = await client.listTools();
    const tools = Array.isArray(listed?.tools) ? listed.tools : [];
    const uploadTool = findTool(tools, 'media_upload');
    const confirmTool = findTool(tools, 'media_confirm');
    if (!uploadTool || !confirmTool) {
      throw new Error('Reference upload tools are unavailable from this account.');
    }

    const ids = [];
    for (const file of list) {
      const filename = String(file.filename || 'reference-media').slice(0, 255);
      const mimeType = String(file.mimeType || file.mime_type || 'application/octet-stream');
      const mediaKind = String(
        file.mediaKind ||
        file.media_kind ||
        (mimeType.startsWith('video/') ? 'video' : mimeType.startsWith('audio/') ? 'audio' : 'image')
      );
      const data = file.data || file.media_data || file.image_data;
      if (!Buffer.isBuffer(data)) throw new Error('Reference media data is missing.');

      const uploadArgs = wrapToolPayload(uploadTool, {
        filename,
        content_type: mimeType,
      });
      const uploadResult = await client.callTool(
        { name: uploadTool.name, arguments: uploadArgs },
        { timeout: 30000 },
      );
      const info = extractUploadInfo(uploadResult);
      if (!info.mediaId || !info.uploadUrl) throw new Error('Reference upload did not return a media ID and upload URL.');

      const response = await fetch(info.uploadUrl, {
        method: 'PUT',
        headers: { 'content-type': mimeType },
        body: data,
      });
      if (!response.ok) throw new Error('Reference upload failed with HTTP ' + response.status + '.');

      const confirmArgs = wrapToolPayload(confirmTool, {
        media_id: info.mediaId,
        type: mediaKind,
      });
      await client.callTool(
        { name: confirmTool.name, arguments: confirmArgs },
        { timeout: 30000 },
      );
      ids.push(info.mediaId);
    }
    return ids;
  });
}

async function uploadHiggsfieldImages(files) {
  return uploadHiggsfieldMedia(
    (Array.isArray(files) ? files : []).map(file => ({...file, mediaKind:'image'}))
  );
}

function mediaReferencesForModel(model, mediaIds) {
  const ids = Array.isArray(mediaIds) ? mediaIds.filter(Boolean) : [];
  if (!ids.length) return [];
  const roles = Array.isArray(model?.mediaRoles) ? model.mediaRoles : [];

  if (model.mediaType === 'image') {
    const role = roles.includes('image')
      ? 'image'
      : (roles.includes('image_references') ? 'image_references' : (roles.includes('input_images') ? 'input_images' : null));
    if (!role) throw new Error('This image model does not support reference images.');
    return ids.map(value => ({ value, role }));
  }

  const refs = [];
  let index = 0;
  if (roles.includes('start_image') && ids[index]) {
    refs.push({ value: ids[index++], role: 'start_image' });
  }
  if (roles.includes('end_image') && ids[index]) {
    refs.push({ value: ids[index++], role: 'end_image' });
  }

  const repeatedRole = roles.includes('image')
    ? 'image'
    : (roles.includes('image_references')
      ? 'image_references'
      : (roles.includes('input_images') ? 'input_images' : null));
  while (repeatedRole && ids[index]) {
    refs.push({ value: ids[index++], role: repeatedRole });
  }

  if (!refs.length) throw new Error('This video model does not support image references.');
  return refs;
}

function extractCost(result) {
  const objects = resultObjects(result);

  const direct = firstByKeys(objects, [
    'credits_exact', 'cost_credits', 'credit_cost', 'credits_cost',
    'estimated_credits', 'estimated_cost', 'total_credits', 'credits_required',
    'credits', 'price',
  ]);
  const directNumber = Number(direct);
  if (Number.isFinite(directNumber) && directNumber >= 0) return directNumber;

  const costValue = firstByKeys(objects, ['cost']);
  if (costValue && typeof costValue === 'object') {
    const nested = firstByKeys([costValue], [
      'credits_exact', 'credits', 'total_credits', 'credits_required',
      'amount', 'value', 'price',
    ]);
    const nestedNumber = Number(nested);
    if (Number.isFinite(nestedNumber) && nestedNumber >= 0) return nestedNumber;
  } else {
    const costNumber = Number(costValue);
    if (Number.isFinite(costNumber) && costNumber >= 0) return costNumber;
  }

  // MCP implementations sometimes wrap their JSON result in a nested string.
  // Inspect all strings, not only top-level text blocks.
  const strings = [];
  const collectStrings = (value, depth = 0) => {
    if (depth > 8 || value == null) return;
    if (typeof value === 'string') {
      strings.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) collectStrings(item, depth + 1);
      return;
    }
    if (typeof value === 'object') {
      for (const child of Object.values(value)) collectStrings(child, depth + 1);
    }
  };
  collectStrings(result);

  for (const textValue of strings) {
    const text = String(textValue || '');
    const keyed = text.match(/["']?(?:credits_exact|cost_credits|credit_cost|credits_cost|estimated_credits|estimated_cost|total_credits|credits_required|credits|price)["']?\s*[:=]\s*["']?([0-9]+(?:\.[0-9]+)?)/i);
    if (keyed && Number(keyed[1]) >= 0) return Number(keyed[1]);

    const match = text.match(/(?:cost|price)\s*[:=]?\s*([0-9]+(?:\.[0-9]+)?)\s*(?:credits?)?/i)
      || text.match(/([0-9]+(?:\.[0-9]+)?)\s*credits?/i);
    if (match && Number(match[1]) >= 0) return Number(match[1]);
  }
  return null;
}

function extractJobId(result) {
  const objects = resultObjects(result);
  const direct = firstByKeys(objects, ['job_id', 'jobId', 'request_id', 'requestId', 'task_id', 'taskId', 'id']);
  if (direct !== null && String(direct).trim()) return String(direct);

  for (const obj of objects) {
    const text = String(obj?.__text || '');
    const match = text.match(/(?:job|request|task)(?:\s+id)?\s*[:=]\s*([A-Za-z0-9._:-]+)/i);
    if (match) return match[1];
  }
  return null;
}

function extractStatus(result) {
  const objects = resultObjects(result);
  const direct = firstByKeys(objects, ['status', 'state']);
  if (direct !== null) return String(direct).toLowerCase();
  const text = objects.map(obj => String(obj?.__text || '')).join(' ').toLowerCase();
  if (/completed|succeeded|success|done/.test(text)) return 'completed';
  if (/failed|error|cancelled|canceled|nsfw/.test(text)) return 'failed';
  return 'processing';
}

function extractOutputUrl(result) {
  const objects = resultObjects(result);
  const direct = firstByKeys(objects, [
    'output_url', 'result_url', 'video_url', 'image_url', 'asset_url',
    'download_url', 'url',
  ]);
  if (typeof direct === 'string' && /^https?:\/\//i.test(direct)) return direct;

  for (const obj of objects) {
    const text = String(obj?.__text || '');
    const match = text.match(/https?:\/\/[^\s<>"']+/i);
    if (match) return match[0].replace(/[),.;]+$/, '');
  }
  return null;
}

class HiggsfieldOAuthProvider {
  constructor({ redirectUrl }) {
    this.redirectUrl = String(redirectUrl);
    this.authorizationUrl = null;
    this.clientMetadata = {
      client_name: 'Mehroz AI',
      redirect_uris: [this.redirectUrl],
      application_type: 'web',
    };
  }

  async clientInformation(ctx) {
    const stored = parseJson(await getSettingValue(AUTH_KEYS.clientInfo, ''), {});
    if (!ctx?.issuer) return undefined;
    return stored[ctx.issuer];
  }

  async saveClientInformation(info, ctx) {
    const stored = parseJson(await getSettingValue(AUTH_KEYS.clientInfo, ''), {});
    const issuer = ctx?.issuer || info?.issuer || 'default';
    stored[issuer] = info;
    await setSettingValue(AUTH_KEYS.clientInfo, JSON.stringify(stored), { secret: true });
  }

  async tokens(ctx) {
    const tokens = parseJson(await getSettingValue(AUTH_KEYS.tokens, ''), null);
    if (!tokens) return undefined;
    if (ctx?.issuer && tokens.issuer && String(tokens.issuer) !== String(ctx.issuer)) return undefined;
    return tokens;
  }

  async saveTokens(tokens) {
    await setSettingValue(AUTH_KEYS.tokens, JSON.stringify(tokens), { secret: true });
  }

  async state() {
    const value = crypto.randomUUID();
    await setSettingValue(AUTH_KEYS.state, value, { secret: true });
    return value;
  }

  async saveDiscoveryState(state) {
    await setSettingValue(AUTH_KEYS.discovery, JSON.stringify(state), { secret: true });
  }

  async discoveryState() {
    return parseJson(await getSettingValue(AUTH_KEYS.discovery, ''), undefined);
  }

  async redirectToAuthorization(url) {
    this.authorizationUrl = url.toString();
  }

  async saveCodeVerifier(value) {
    await setSettingValue(AUTH_KEYS.verifier, value, { secret: true });
  }

  async codeVerifier() {
    const value = await getSettingValue(AUTH_KEYS.verifier, '');
    if (!value) throw new Error('Higgsfield OAuth code verifier is missing. Start the connection again.');
    return value;
  }
}

function makeClient(provider, mcpUrl) {
  const client = new Client(
    { name: 'mehroz-ai', version: '1.0.0' },
    { versionNegotiation: { mode: 'auto' } },
  );
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    authProvider: provider,
    requestInit: {
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 MehrozAI/1.0',
      },
    },
  });
  return { client, transport };
}

async function storedRedirectUrl() {
  // A callback saved on the old domain is moved to the current one.
  const saved = currentUrl(await getSettingValue(AUTH_KEYS.redirect, '') || '');
  if (saved) return saved;

  const appUrl = currentAppUrl();
  if (!appUrl) throw new Error('APP_URL is required before connecting Higgsfield MCP.');
  return appUrl + '/admin/higgsfield/oauth/callback';
}

async function clearHiggsfieldAuth({ keepClientRegistration = true } = {}) {
  await Promise.all([
    deleteSettingValue(AUTH_KEYS.tokens),
    deleteSettingValue(AUTH_KEYS.verifier),
    deleteSettingValue(AUTH_KEYS.discovery),
    deleteSettingValue(AUTH_KEYS.state),
    keepClientRegistration ? Promise.resolve() : deleteSettingValue(AUTH_KEYS.clientInfo),
  ]);
}

async function beginHiggsfieldAuthorization({ redirectUrl, force = false } = {}) {
  const settings = await getProviderSettings();
  const callback = String(redirectUrl || await storedRedirectUrl());
  await setSettingValue(AUTH_KEYS.redirect, callback);

  if (force) await clearHiggsfieldAuth({ keepClientRegistration: true });

  const provider = new HiggsfieldOAuthProvider({ redirectUrl: callback });
  const { client, transport } = makeClient(provider, settings.higgsfieldMcpUrl);

  try {
    await client.connect(transport);
    await client.close();
    return { connected: true, authorizationUrl: null };
  } catch (error) {
    try { await client.close(); } catch {}
    if (error instanceof UnauthorizedError || provider.authorizationUrl) {
      if (!provider.authorizationUrl) throw new Error('Higgsfield authorization is required but no authorization URL was returned.');
      return { connected: false, authorizationUrl: provider.authorizationUrl };
    }
    throw error;
  }
}

async function finishHiggsfieldAuthorization({ params, redirectUrl } = {}) {
  const settings = await getProviderSettings();
  const callback = String(redirectUrl || await storedRedirectUrl());
  const expectedState = String(await getSettingValue(AUTH_KEYS.state, '') || '');
  const returnedState = String(params?.get?.('state') || '');

  if (!expectedState || !returnedState || expectedState !== returnedState) {
    const error = new Error('Higgsfield authorization state did not match. Start the connection again.');
    error.statusCode = 400;
    throw error;
  }

  const provider = new HiggsfieldOAuthProvider({ redirectUrl: callback });
  const first = makeClient(provider, settings.higgsfieldMcpUrl);

  try {
    await first.transport.finishAuth(params);
  } catch (error) {
    if (IssuerMismatchError && error instanceof IssuerMismatchError) {
      throw new Error('Higgsfield authorization failed because the authorization issuer did not match.');
    }
    throw error;
  } finally {
    try { await first.client.close(); } catch {}
  }

  const second = makeClient(provider, settings.higgsfieldMcpUrl);
  try {
    await second.client.connect(second.transport);
    const { tools } = await second.client.listTools();
    await deleteSettingValue(AUTH_KEYS.state);
    await deleteSettingValue(AUTH_KEYS.verifier);
    return { connected: true, toolCount: Array.isArray(tools) ? tools.length : 0 };
  } finally {
    try { await second.client.close(); } catch {}
  }
}

function networkErrorDetails(error) {
  const parts = [];
  const seen = new Set();
  let current = error;
  while (current && !seen.has(current) && parts.length < 6) {
    seen.add(current);
    const code = current.code || current.errno;
    const message = current.message;
    if (code && !parts.includes(String(code))) parts.push(String(code));
    if (message && !parts.includes(String(message))) parts.push(String(message));
    current = current.cause;
  }
  return parts.join(' · ');
}

function isRetryableNetworkError(error) {
  const text = networkErrorDetails(error).toLowerCase();
  return /fetch failed|econnreset|econnrefused|etimedout|enetwork|ehostunreach|enetunreach|socket|network|other side closed|headers timeout/.test(text);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withHiggsfieldOAuthLock(callback) {
  // Higgsfield rotates refresh tokens. Two app processes (or two concurrent
  // requests) must never refresh the same token at the same time.
  if (!dbConfigured()) return callback();

  const db = getPool();
  const conn = await db.getConnection();
  let locked = false;
  try {
    const [[row]] = await conn.query("SELECT GET_LOCK('mehroz_higgsfield_oauth', 20) AS acquired");
    locked = Number(row?.acquired) === 1;
    if (!locked) {
      const error = new Error('Higgsfield authentication is busy. Please retry in a moment.');
      error.code = 'HIGGSFIELD_AUTH_BUSY';
      throw error;
    }
    return await callback();
  } finally {
    if (locked) {
      try { await conn.query("SELECT RELEASE_LOCK('mehroz_higgsfield_oauth')"); } catch {}
    }
    conn.release();
  }
}

function isInvalidGrantError(error) {
  const text = networkErrorDetails(error).toLowerCase();
  return /invalid_grant|refresh token was already used|refresh token is invalid|refresh token.*expired|server returned 401 after re-authentication/.test(text);
}

async function withAuthenticatedClient(callback) {
  return withHiggsfieldOAuthLock(async () => {
  const settings = await getProviderSettings();
  const redirectUrl = await storedRedirectUrl();
  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const provider = new HiggsfieldOAuthProvider({ redirectUrl });
    const { client, transport } = makeClient(provider, settings.higgsfieldMcpUrl);

    try {
      await client.connect(transport);
      return await callback(client);
    } catch (error) {
      if (isInvalidGrantError(error)) {
        // Another process may have rotated the refresh token just before this
        // lock was acquired. Re-read the stored token set once before requiring
        // manual authorization.
        if (attempt < 3) {
          lastError = error;
          await delay(250);
          continue;
        }
        const authError = new Error('Higgsfield authorization expired or its refresh token was rotated. Reconnect the account once in Admin.');
        authError.code = 'HIGGSFIELD_AUTH_REQUIRED';
        throw authError;
      }

      if (error instanceof UnauthorizedError || provider.authorizationUrl) {
        const authError = new Error('Higgsfield connection needs to be authorized again in Admin.');
        authError.code = 'HIGGSFIELD_AUTH_REQUIRED';
        throw authError;
      }

      lastError = error;
      if (!isRetryableNetworkError(error) || attempt >= 3) {
        const details = networkErrorDetails(error);
        if (isRetryableNetworkError(error) && details) {
          const networkError = new Error('Higgsfield MCP network request failed after retries: ' + details);
          networkError.code = 'HIGGSFIELD_NETWORK';
          throw networkError;
        }
        throw error;
      }

      await delay(attempt === 1 ? 350 : 900);
    } finally {
      try { await client.close(); } catch {}
    }
  }

  throw lastError || new Error('Higgsfield MCP request failed.');
  });
}

function likelyModelToken(value) {
  const token = String(value == null ? '' : value).trim();
  if (!token || token.length > 120 || /\s/.test(token)) return false;
  if (/^https?:\/\//i.test(token)) return false;
  if (/^(true|false|null|undefined|prompt|model|duration|resolution|aspect_ratio|get_cost|image|video)$/i.test(token)) return false;
  if (!/[a-z]/i.test(token)) return false;
  // Higgsfield model IDs shown in their MCP docs use compact slugs such as
  // soul_2. Accept underscore/hyphen/dot/slash slugs and tokens containing a
  // version digit, while rejecting ordinary prose words.
  return /[_./-]/.test(token) || /\d/.test(token);
}

function entriesFromExamples(schema) {
  if (!schema || typeof schema !== 'object') return [];
  const values = [];
  if (schema.example !== undefined) values.push(schema.example);
  if (Array.isArray(schema.examples)) values.push(...schema.examples);
  return values
    .map(value => typeof value === 'object' && value !== null ? (value.model ?? value.model_id ?? value.modelId) : value)
    .filter(value => likelyModelToken(value))
    .map(value => ({ value: String(value), label: null }));
}

function entriesFromText(text) {
  const source = String(text || '');
  if (!source) return [];
  const values = [];

  // Prefer quoted/backticked values and slug-shaped tokens. This supports MCP
  // schemas where "model" is a plain string whose valid IDs are documented in
  // the field/tool description instead of exposed as a JSON-Schema enum.
  const quoted = /["'`]([A-Za-z0-9][A-Za-z0-9_.\/-]{1,119})["'`]/g;
  let match;
  while ((match = quoted.exec(source))) {
    if (likelyModelToken(match[1])) values.push(match[1]);
  }

  const slugLike = /\b([A-Za-z][A-Za-z0-9]*(?:[_./-][A-Za-z0-9]+)+)\b/g;
  while ((match = slugLike.exec(source))) {
    if (likelyModelToken(match[1])) values.push(match[1]);
  }

  const seen = new Set();
  return values
    .filter(value => {
      const key = String(value).toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(value => ({ value, label: null }));
}

function modelEntriesFromTool(tool) {
  const schema = tool?.inputSchema || {};
  const modelProp = propertyByNames(schema, ['model', 'model_id', 'modelId']);
  const entries = enumEntries(modelProp?.schema);

  if (entries.length) return entries;

  const fromExamples = [
    ...entriesFromExamples(modelProp?.schema),
    ...entriesFromExamples(schema),
  ];
  if (fromExamples.length) return fromExamples;

  const def = modelProp?.schema?.default;
  if (def !== undefined && def !== null && String(def).trim()) {
    return [{ value: def, label: modelProp.schema.title || null }];
  }

  if (modelProp) {
    const described = entriesFromText([
      modelProp.schema?.description,
      modelProp.schema?.title,
      tool?.description,
      tool?.title,
    ].filter(Boolean).join('\n'));
    if (described.length) {
      const filtered = described.filter(entry => knownCreativeModelFamily(entry.value));
      if (filtered.length) return filtered;
    }
  }

  // Some MCP servers expose one generation tool per model and therefore do not
  // need a model parameter. Only accept that shape when the tool itself names a
  // recognizable creative model family. Generic workflow/analysis tools must
  // never become customer-facing model options.
  const toolText = [tool?.name, tool?.title, tool?.description].filter(Boolean).join(' ');
  const mediaHint = inferModelMedia(tool?.name || tool?.title || '', toolText);
  if (
    !modelProp &&
    mediaHint &&
    isLikelyGenerationTool(tool) &&
    knownCreativeModelFamily(tool?.name || tool?.title || '')
  ) {
    return [{ value: String(tool.name), label: tool.title || null }];
  }

  return [];
}

function deriveToolOptions(schema) {
  const durationProp = propertyByNames(schema, ['duration', 'seconds', 'length']);
  const resolutionProp = propertyByNames(schema, ['resolution', 'quality']);
  const aspectProp = propertyByNames(schema, ['aspect_ratio', 'aspectRatio', 'ratio']);

  return {
    durations: numberOptions(durationProp),
    resolutions: stringOptions(resolutionProp),
    aspectRatios: stringOptions(aspectProp),
    defaultDuration: defaultValue(durationProp),
    defaultResolution: defaultValue(resolutionProp),
    defaultAspectRatio: defaultValue(aspectProp),
  };
}

function mergeUnique(target, values) {
  for (const value of values || []) if (!target.includes(value)) target.push(value);
}

function discoverModelsFromTools(tools) {
  const grouped = new Map();

  for (const tool of Array.isArray(tools) ? tools : []) {
    if (!isLikelyGenerationTool(tool)) continue;
    const toolText = [tool.name, tool.title, tool.description].filter(Boolean).join(' ');
    const entries = modelEntriesFromTool(tool);
    if (!entries.length) continue;

    for (const entry of entries) {
      const providerModelId = String(entry.value || '').trim();
      if (!providerModelId) continue;
      const mediaType = inferModelMedia(providerModelId, toolText);
      if (!mediaType) continue;

      const key = mediaType + '|' + providerModelId;
      if (!grouped.has(key)) {
        const label = String(entry.label || humanizeModelId(providerModelId)).trim();
        grouped.set(key, {
          providerModelId,
          publicModelId: canonicalPublicModelId(providerModelId, label, mediaType),
          label,
          mediaType,
          toolName: tool.name,
          inputSchema: tool.inputSchema || {},
          options: {
            durations: [],
            resolutions: [],
            aspectRatios: [],
            defaultDuration: null,
            defaultResolution: null,
            defaultAspectRatio: null,
            tools: [],
          },
        });
      }

      const model = grouped.get(key);
      const mode = inferMode(mediaType, toolText);
      const toolOptions = deriveToolOptions(tool.inputSchema || {});
      mergeUnique(model.options.durations, toolOptions.durations);
      mergeUnique(model.options.resolutions, toolOptions.resolutions);
      mergeUnique(model.options.aspectRatios, toolOptions.aspectRatios);
      if (model.options.defaultDuration == null && toolOptions.defaultDuration != null) model.options.defaultDuration = toolOptions.defaultDuration;
      if (model.options.defaultResolution == null && toolOptions.defaultResolution != null) model.options.defaultResolution = toolOptions.defaultResolution;
      if (model.options.defaultAspectRatio == null && toolOptions.defaultAspectRatio != null) model.options.defaultAspectRatio = toolOptions.defaultAspectRatio;
      model.options.tools.push({
        name: tool.name,
        mode,
        schema: tool.inputSchema || {},
        description: tool.description || '',
      });

      const preferred = mediaType === 'video'
        ? (mode === 'text-to-video' || mode === 'video')
        : (mode === 'text-to-image' || mode === 'image');
      if (preferred) {
        model.toolName = tool.name;
        model.inputSchema = tool.inputSchema || {};
      }
    }
  }

  return [...grouped.values()].map(model => {
    model.options.durations = [...new Set(model.options.durations.map(Number).filter(Number.isFinite))].sort((a, b) => a - b);
    model.options.resolutions = [...new Set(model.options.resolutions.map(String))];
    model.options.aspectRatios = [...new Set(model.options.aspectRatios.map(String))];
    return model;
  });
}

async function getHiggsfieldToolDiagnostics() {
  return withAuthenticatedClient(async client => {
    const result = await client.listTools();
    const tools = Array.isArray(result?.tools) ? result.tools : [];
    return tools.map(tool => {
      const schema = tool?.inputSchema || {};
      const props = schemaProperties(schema);
      const modelProp = propertyByNames(schema, ['model', 'model_id', 'modelId']);
      return {
        name: String(tool?.name || ''),
        title: String(tool?.title || ''),
        description: String(tool?.description || '').slice(0, 1200),
        propertyNames: Object.keys(props),
        modelField: modelProp ? {
          name: modelProp.name,
          type: modelProp.schema?.type || null,
          default: modelProp.schema?.default ?? null,
          enum: Array.isArray(modelProp.schema?.enum) ? modelProp.schema.enum.slice(0, 100) : [],
          examples: Array.isArray(modelProp.schema?.examples)
            ? modelProp.schema.examples.slice(0, 50)
            : (modelProp.schema?.example !== undefined ? [modelProp.schema.example] : []),
          description: String(modelProp.schema?.description || '').slice(0, 2000),
        } : null,
        discoveredModels: modelEntriesFromTool(tool).slice(0, 100),
      };
    });
  });
}

async function syncHiggsfieldModels() {
  return withAuthenticatedClient(async client => {
    const result = await client.listTools();
    const tools = Array.isArray(result?.tools) ? result.tools : [];
    await quarantineProviderUtilityModels(PROVIDER);

    let models = [];
    let catalogSource = 'models_explore';
    let catalogError = null;
    try {
      models = await discoverModelsFromCatalog(client, tools);
    } catch (error) {
      catalogError = error;
      console.error('Higgsfield models_explore sync failed:', networkErrorDetails(error) || error?.message || error);
    }

    // Higgsfield's public CLI/Skills repository is generated from the live
    // model list and documents the current image/video job_set_type IDs. Some
    // MCP deployments expose models_explore as recommend/get only and return no
    // entries for list, so use the current official generation catalog as a
    // safe fallback rather than turning unrelated MCP utility tools into models.
    if (!models.length) {
      catalogSource = 'official-cli-fallback';
      models = officialFallbackModels(tools);
      if (models.length) {
        const enriched = await enrichOfficialFallbackModels(client, tools, models);
        models = enriched.models;
        if (enriched.enrichedCount > 0) {
          catalogSource = 'official-cli+live-model-get';
        }
      }
    }

    // Last-resort compatibility path for an older MCP schema.
    if (!models.length) {
      catalogSource = 'tool-schema-fallback';
      models = discoverModelsFromTools(tools);
    }

    if (!models.length) {
      const reason = catalogError ? (networkErrorDetails(catalogError) || catalogError.message) : 'No catalog entries were returned.';
      throw new Error('Higgsfield model catalog sync failed: ' + reason + ' The existing catalog was left unchanged.');
    }

    const jobsWait = findTool(tools, 'jobs_wait')
      || tools.find(tool => /jobs?.?wait|wait.?jobs?/i.test([tool.name, tool.title, tool.description].filter(Boolean).join(' ')));

    if (jobsWait) {
      await setSettingValue(AUTH_KEYS.jobsWait, JSON.stringify({
        name: jobsWait.name,
        schema: jobsWait.inputSchema || {},
      }));
    }

    const synced = await syncProviderModels(PROVIDER, models);
    await setSettingValue(AUTH_KEYS.lastSync, new Date().toISOString());
    return {
      modelCount: synced.filter(model => model.available).length,
      videoCount: synced.filter(model => model.available && model.mediaType === 'video').length,
      imageCount: synced.filter(model => model.available && model.mediaType === 'image').length,
      toolCount: tools.length,
      catalogSource,
      jobsWaitConfigured: Boolean(jobsWait),
      models: synced,
    };
  });
}

async function getHiggsfieldConnectionStatus() {
  const settings = await getProviderSettings();
  const lastSync = await getSettingValue(AUTH_KEYS.lastSync, '');
  return {
    connected: Boolean(settings.higgsfieldOauthTokens),
    enabled: Boolean(settings.higgsfieldEnabled),
    active: Boolean(settings.higgsfieldEnabled && settings.higgsfieldOauthTokens),
    mcpUrl: settings.higgsfieldMcpUrl,
    maxInflight: settings.higgsfieldMaxInflight,
    lastSync: lastSync || null,
  };
}

async function estimateHiggsfieldCost(publicModelId, mediaType, input = {}) {
  const model = await getProviderModelByPublicId(PROVIDER, publicModelId, mediaType);
  if (!model) {
    const error = new Error('This model is not currently available.');
    error.statusCode = 404;
    throw error;
  }
  const { tool, args } = buildToolArguments(model, input, [], { getCost: true });

  return withAuthenticatedClient(async client => {
    const result = await client.callTool({ name: tool.name, arguments: args }, { timeout: 30000 });
    const cost = extractCost(result);
    if (!Number.isFinite(Number(cost)) || Number(cost) < 0) {
      const error = new Error('The generation cost could not be read from the model provider.');
      error.statusCode = 502;
      throw error;
    }
    return Number(cost);
  });
}

async function submitHiggsfieldGeneration(model, input = {}, mediaReferences = []) {
  const { tool, args } = buildToolArguments(model, input, mediaReferences, { getCost: false });
  return withAuthenticatedClient(async client => {
    const result = await client.callTool({ name: tool.name, arguments: args }, { timeout: 60000 });
    const outputUrl = extractOutputUrl(result);
    let status = extractStatus(result);
    if (outputUrl && status === 'processing') status = 'completed';
    return {
      jobId: extractJobId(result),
      status,
      outputUrl,
      cost: extractCost(result),
    };
  });
}

function waitArgsFromSchema(schema, jobId) {
  const props = schemaProperties(schema);
  const args = {};
  for (const name of ['job_id', 'jobId', 'id', 'request_id', 'requestId', 'task_id', 'taskId']) {
    if (!props[name]) continue;
    args[name] = String(jobId);
    return args;
  }
  for (const name of ['job_ids', 'ids', 'request_ids', 'task_ids']) {
    if (!props[name]) continue;
    args[name] = [String(jobId)];
    return args;
  }
  return { job_id: String(jobId) };
}

async function waitForHiggsfieldJob(jobId, timeoutMs = 5000) {
  const stored = parseJson(await getSettingValue(AUTH_KEYS.jobsWait, ''), null);
  if (!stored?.name) {
    const sync = await syncHiggsfieldModels();
    if (!sync.jobsWaitConfigured) throw new Error('Higgsfield jobs_wait tool is unavailable.');
  }

  const tool = parseJson(await getSettingValue(AUTH_KEYS.jobsWait, ''), null);
  const args = waitArgsFromSchema(tool?.schema || {}, jobId);

  try {
    return await withAuthenticatedClient(async client => {
      const result = await client.callTool(
        { name: tool.name, arguments: args },
        { timeout: Math.max(1500, Number(timeoutMs) || 5000) },
      );
      return {
        status: extractStatus(result),
        outputUrl: extractOutputUrl(result),
        cost: extractCost(result),
      };
    });
  } catch (error) {
    if (/timeout|timed out|request timeout/i.test(String(error?.message || ''))) {
      return { status: 'processing', outputUrl: null, cost: null };
    }
    throw error;
  }
}

module.exports = {
  PROVIDER,
  beginHiggsfieldAuthorization,
  finishHiggsfieldAuthorization,
  clearHiggsfieldAuth,
  syncHiggsfieldModels,
  getHiggsfieldConnectionStatus,
  getHiggsfieldToolDiagnostics,
  estimateHiggsfieldCost,
  submitHiggsfieldGeneration,
  uploadHiggsfieldMedia,
  uploadHiggsfieldImages,
  mediaReferencesForModel,
  waitForHiggsfieldJob,
  buildToolArguments,
};
