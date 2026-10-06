const crypto = require('node:crypto');
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
const {
  humanizeModelId,
  canonicalPublicModelId,
  syncProviderModels,
  getProviderModelByPublicId,
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

function appendReferenceImages(args, props, urls) {
  const list = Array.isArray(urls) ? urls.filter(Boolean) : [];
  if (!list.length) return;

  const arrayNames = [
    'reference_images', 'reference_image_urls', 'image_urls', 'images',
    'input_images', 'referenceImages', 'imageUrls',
  ];
  for (const name of arrayNames) {
    if (!props[name]) continue;
    const type = props[name].type;
    args[name] = type === 'string' ? list[0] : list;
    return;
  }

  const scalarNames = [
    'image_url', 'start_image_url', 'first_frame_url', 'input_image',
    'reference_image', 'image', 'startImageUrl',
  ];
  for (const name of scalarNames) {
    if (!props[name]) continue;
    args[name] = list[0];
    return;
  }
}

function buildToolArguments(model, input = {}, referenceImageUrls = [], { getCost = false } = {}) {
  const tool = selectTool(model, input.mode);
  if (!tool?.name) throw new Error('This model does not have a generation tool.');

  const schema = tool.schema || {};
  const props = schemaProperties(schema);
  const args = {};

  appendIfSupported(args, props, ['model', 'model_id', 'modelId'], model.providerModelId);
  appendIfSupported(args, props, ['prompt', 'text', 'description'], String(input.prompt || '').trim());

  const duration = Number(input.duration);
  if (Number.isFinite(duration) && duration > 0) {
    appendIfSupported(args, props, ['duration', 'seconds', 'length'], duration);
  }

  appendIfSupported(args, props, ['resolution', 'quality'], input.resolution || '');
  appendIfSupported(args, props, ['aspect_ratio', 'aspectRatio', 'ratio'], input.aspectRatio || input.aspect_ratio || '');
  appendReferenceImages(args, props, referenceImageUrls);

  if (getCost) {
    if (!props.get_cost) {
      const error = new Error('Live cost estimation is not exposed for this model.');
      error.statusCode = 503;
      throw error;
    }
    args.get_cost = true;
  }

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
      out.push({ __text: text });
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

function extractCost(result) {
  const objects = resultObjects(result);
  const direct = firstByKeys(objects, [
    'cost_credits', 'credit_cost', 'credits_cost', 'estimated_credits',
    'estimated_cost', 'cost', 'credits', 'price',
  ]);
  const n = Number(direct);
  if (Number.isFinite(n) && n > 0) return n;

  for (const obj of objects) {
    const text = String(obj?.__text || '');
    const match = text.match(/(?:cost|price)\s*[:=]?\s*([0-9]+(?:\.[0-9]+)?)\s*(?:credits?)?/i)
      || text.match(/([0-9]+(?:\.[0-9]+)?)\s*credits?/i);
    if (match && Number(match[1]) > 0) return Number(match[1]);
  }
  return null;
}

function extractJobId(result) {
  const objects = resultObjects(result);
  const direct = firstByKeys(objects, ['job_id', 'jobId', 'request_id', 'requestId', 'task_id', 'taskId']);
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
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), { authProvider: provider });
  return { client, transport };
}

async function storedRedirectUrl() {
  const saved = String(await getSettingValue(AUTH_KEYS.redirect, '') || '').trim();
  if (saved) return saved;

  const appUrl = String(process.env.APP_URL || '').replace(/\/$/, '');
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

async function withAuthenticatedClient(callback) {
  const settings = await getProviderSettings();
  const redirectUrl = await storedRedirectUrl();
  const provider = new HiggsfieldOAuthProvider({ redirectUrl });
  const { client, transport } = makeClient(provider, settings.higgsfieldMcpUrl);

  try {
    await client.connect(transport);
    return await callback(client);
  } catch (error) {
    if (error instanceof UnauthorizedError || provider.authorizationUrl) {
      const authError = new Error('Higgsfield connection needs to be authorized again in Admin.');
      authError.code = 'HIGGSFIELD_AUTH_REQUIRED';
      throw authError;
    }
    throw error;
  } finally {
    try { await client.close(); } catch {}
  }
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
    const models = discoverModelsFromTools(tools);
    if (!models.length) {
      throw new Error('Connected successfully, but model IDs were not exposed as enums/examples/described slugs in the '+tools.length+' MCP tools returned by this account. The existing catalog was left unchanged. Use Inspect MCP tools in Admin so we can map the live schema without guessing.');
    }
    const jobsWait = tools.find(tool => String(tool.name).toLowerCase() === 'jobs_wait')
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
    if (!Number.isFinite(Number(cost)) || Number(cost) <= 0) {
      const error = new Error('The generation cost could not be read from the model provider.');
      error.statusCode = 502;
      throw error;
    }
    return Number(cost);
  });
}

async function submitHiggsfieldGeneration(model, input = {}, referenceImageUrls = []) {
  const { tool, args } = buildToolArguments(model, input, referenceImageUrls, { getCost: false });
  return withAuthenticatedClient(async client => {
    const result = await client.callTool({ name: tool.name, arguments: args }, { timeout: 60000 });
    return {
      jobId: extractJobId(result),
      status: extractStatus(result),
      outputUrl: extractOutputUrl(result),
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
  waitForHiggsfieldJob,
  buildToolArguments,
};
