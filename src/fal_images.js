'use strict';
// fal.ai image generation and editing ('falimg'; the 'fal'
// provider is the video upscaler). The catalog and each model's request schema
// come from fal's public Platform API; prices need the saved fal.ai key.
// Customers pay the USD source price x fal_customer_credits_per_usd.
const { FalClient } = require('./provider/fal.js');
const { readBounded, checkOutputUrl, imageMime, IMAGE_LIMIT } = require('./provider/vercel.js');
const { imageDimensions } = require('./vercel_models.js');

const API = 'https://api.fal.ai/v1';
const PROVIDER = 'falimg';
const RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9', '4:5', '5:4'];
const PRESETS = { '1:1': 'square_hd', '16:9': 'landscape_16_9', '9:16': 'portrait_16_9', '4:3': 'landscape_4_3', '3:4': 'portrait_4_3' };
const REFERENCE_FIELDS = ['image_urls', 'input_image_urls', 'reference_image_urls', 'image_url', 'input_image_url'];
const REFERENCE_LIMIT = 10;
const REFERENCE_BYTES = 10 * 1024 * 1024;
// These schemas omit maxItems. fal documents the limits on the model pages.
const DOCUMENTED_REFERENCE_LIMITS = {
  'fal-ai/nano-banana-pro/edit': 14,
  'fal-ai/nano-banana-2/edit': 14,
  'fal-ai/bytedance/seedream/v4.5/edit': 10,
};

// fal bills OpenAI's GPT image models by tokens, which its pricing API does
// not express per image. Prices per image by quality, from each model's fal
// page (25 Oct 2026): the dearest size is used for every aspect ratio, plus
// prompt tokens, rounded up as fal rounds (1.x to the cent).
const GPT_QUALITIES = ['low', 'medium', 'high'];
const gpt2 = (label, low, medium, high) => ({ label, prices: { low, medium, high }, prompt: 0.003 });
const gpt1 = (label, low, medium, high) => ({ label, prices: { low, medium, high }, prompt: 0.002, cent: true,
  values: { '1:1': '1024x1024', '3:2': '1536x1024', '2:3': '1024x1536' } });
const GPT_IMAGE = {
  'openai/gpt-image-2': gpt2('GPT Image 2', 0.006, 0.053, 0.211),
  'openai/gpt-image-2.5/flare/text-to-image': gpt2('GPT Image 2.5 Flare', 0.00588, 0.01317, 0.05268),
  'openai/gpt-image-2.5/sunburst/text-to-image': gpt2('GPT Image 2.5 Sunburst', 0.00588, 0.01317, 0.05268),
  'fal-ai/gpt-image-1.5': gpt1('GPT Image 1.5', 0.013, 0.051, 0.200),
  'fal-ai/gpt-image-1/text-to-image': gpt1('GPT Image 1', 0.016, 0.063, 0.25),
  'fal-ai/gpt-image-1-mini': gpt1('GPT Image 1 Mini', 0.006, 0.015, 0.052),
};
// fal.ai/gpt-image-2.5 and the GPT Image edit pricing pages document input
// token costs. Estimate one reference, with the same output tiers as text.
const GPT_EDITS = {
  'openai/gpt-image-2': { endpoint: 'openai/gpt-image-2/edit', imageUsd: 0.012 },
  'openai/gpt-image-2.5/flare/text-to-image': { endpoint: 'openai/gpt-image-2.5/flare/edit', imageUsd: 0.012 },
  'openai/gpt-image-2.5/sunburst/text-to-image': { endpoint: 'openai/gpt-image-2.5/sunburst/edit', imageUsd: 0.012 },
  'fal-ai/gpt-image-1.5': { endpoint: 'fal-ai/gpt-image-1.5/edit', imageUsd: 3050 * 0.008 / 1000, inputFidelity: 'high' },
  'fal-ai/gpt-image-1-mini': { endpoint: 'fal-ai/gpt-image-1-mini/edit', imageUsd: 135 * 0.0025 / 1000 },
};
function gptCost(gpt, quality, imageUsd = 0) {
  const usd = gpt.prices[quality] + gpt.prompt + imageUsd;
  return gpt.cent ? Math.ceil(usd * 100 - 1e-9) / 100 : Math.round(usd * 1e5) / 1e5;
}

const slug = value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 90);
const publicId = endpoint => 'fal_' + slug(endpoint);
const isFalImageModel = id => /^fal_/.test(String(id || ''));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function platform(path, { apiKey = '', fetchImpl = fetch, attempts = 6 } = {}) {
  for (let attempt = 1; ; attempt++) {
    const response = await fetchImpl(API + path, {
      headers: { accept: 'application/json', ...(apiKey ? { authorization: 'Key ' + apiKey } : {}) },
      signal: AbortSignal.timeout(60000),
    });
    if (response.status === 429 && attempt < attempts) { await response.body?.cancel?.().catch(() => {}); await sleep(2000 * attempt); continue; }
    const body = await response.json().catch(() => null);
    if (!response.ok) throw Object.assign(new Error('fal.ai catalog request failed (HTTP ' + response.status + ').'), { providerStatus: response.status });
    return body;
  }
}

// The schema of the POST body, from a model's expanded OpenAPI document.
function inputSchema(entry) {
  const o = entry?.openapi, schemas = o?.components?.schemas || {};
  const post = o?.paths && Object.values(o.paths).find(p => p?.post)?.post;
  const body = post?.requestBody?.content?.['application/json']?.schema || {};
  const schema = schemas[String(body.$ref || '').split('/').pop()] || body;
  return { props: schema.properties || {}, required: schema.required || [] };
}
const enumOf = prop => prop?.enum || (prop?.anyOf || []).flatMap(x => x?.enum || []);
const customImageSize = prop => Boolean(prop?.$ref || prop?.anyOf?.some(v => v?.$ref));

function referenceInput(endpoint, props, required, edit) {
  const fields = REFERENCE_FIELDS.map(field => {
    const prop = props[field];
    const variants = [prop, ...(prop?.anyOf || [])];
    const array = variants.find(v => v?.type === 'array' && v.items?.type === 'string');
    if (array) {
      const max = Math.min(REFERENCE_LIMIT, array.maxItems ?? prop.maxItems ?? DOCUMENTED_REFERENCE_LIMITS[endpoint] ?? 1);
      const minItems = Math.max(1, array.minItems ?? prop.minItems ?? 1);
      const mustSupply = edit || required.includes(field);
      if (!mustSupply && minItems > 1) return null;
      const min = mustSupply ? minItems : 0;
      return max > 0 && min <= max ? { field, array: true, min, max } : null;
    }
    if (variants.some(v => v?.type === 'string')) return { field, array: false, min: edit || required.includes(field) ? 1 : 0, max: 1 };
    return null;
  }).filter(Boolean);
  return fields.find(ref => required.includes(ref.field)) || fields[0] || null;
}

function gptEditSettings(fal, entry) {
  const spec = GPT_EDITS[fal.endpoint];
  if (!spec || entry?.endpoint_id !== spec.endpoint || !fal.hasQuality || fal.sizeParam !== 'image_size') return null;
  const { props, required } = inputSchema(entry);
  const ref = referenceInput(spec.endpoint, props, required, true);
  if (!props.prompt || ref?.field !== 'image_urls' || !ref.array || ref.min !== 1 ||
      required.some(field => !['prompt', 'image_urls', 'image_size', 'quality'].includes(field))) return null;
  const sizes = enumOf(props.image_size);
  if (Object.values(fal.values).some(size => size === 'custom' ? !customImageSize(props.image_size) : !sizes.includes(size))) return null;
  const qualities = enumOf(props.quality);
  if (GPT_QUALITIES.some(quality => !qualities.includes(quality))) return null;
  if (spec.inputFidelity && !enumOf(props.input_fidelity).includes(spec.inputFidelity)) return null;
  return {
    endpoint: spec.endpoint, reference: { ...ref, max: 1 }, hasNumImages: Boolean(props.num_images),
    ...(spec.inputFidelity ? { inputFidelity: spec.inputFidelity } : {}),
  };
}

// One catalog entry plus its price ({unit_price, unit}) as a provider model.
function describeFalImageModel(entry, price = null, editEntry = null) {
  const endpoint = entry.endpoint_id;
  const { props, required } = inputSchema(entry);
  const name = entry.metadata?.display_name || endpoint;
  const edit = entry.metadata?.category === 'image-to-image' || /\/(edit|image-to-image)$/.test(endpoint);
  const unit = String(price?.unit || '').toLowerCase(), rate = Number(price?.unit_price);
  const fixedImagePrice = /^(images?|generations?)$/.test(unit) && Number.isFinite(rate) && rate > 0 &&
    String(price?.currency || 'USD').toUpperCase() === 'USD' && !props.quality;
  const candidate = referenceInput(endpoint, props, required, edit);
  // Optional reference fields must not disable an existing text-only model
  // when we cannot safely quote the edit.
  let reference = fixedImagePrice || edit || candidate?.min ? candidate : null;
  let setupReason = '';
  const fal = { endpoint, sizeParam: null, values: {}, ...(reference ? { reference } : {}) };
  if (props.image_size) {
    fal.sizeParam = 'image_size';
    const presets = enumOf(props.image_size);
    const custom = customImageSize(props.image_size);
    for (const ratio of RATIOS) {
      if (presets.includes(PRESETS[ratio])) fal.values[ratio] = PRESETS[ratio];
      else if (custom) fal.values[ratio] = 'custom';
    }
  } else if (props.aspect_ratio) {
    fal.sizeParam = 'aspect_ratio';
    const allowed = enumOf(props.aspect_ratio);
    for (const ratio of RATIOS) if (allowed.includes(ratio)) fal.values[ratio] = ratio;
  }
  // GPT 1.x takes a fixed list of WxH sizes rather than presets.
  const gpt = GPT_IMAGE[endpoint];
  if (gpt?.values && props.image_size) fal.values = { ...gpt.values };
  const extra = required.filter(r => !['prompt', reference?.field].includes(r));
  if (!props.prompt) setupReason = 'This fal.ai model has no text prompt.';
  else if (extra.length) setupReason = 'This fal.ai model needs extra inputs (' + extra.join(', ') + ').';
  else if (edit && !reference) setupReason = 'No supported reference image input.';
  else if (reference && !fixedImagePrice) setupReason = 'Reference generation requires a verified fixed USD price per image.';
  else if (/vector/i.test(endpoint)) setupReason = 'Vector (SVG) output is not supported.';
  else if (!fal.sizeParam) setupReason = 'This fal.ai model has no size or aspect-ratio setting.';
  // Sizes as the app computes them, so quotes and requests agree.
  const sizes = {};
  for (const ratio of Object.keys(fal.values)) {
    let size = null;
    try { size = imageDimensions({ providerModelId: endpoint }, { aspectRatio: ratio }); } catch {}
    if (/^\d+x\d+$/.test(String(size || ''))) sizes[ratio] = size; else delete fal.values[ratio];
  }
  const aspectRatios = Object.keys(fal.values);
  if (!setupReason && !aspectRatios.length) setupReason = 'No supported aspect ratio.';
  fal.hasQuality = Boolean(gpt && props.quality);
  const gptEdit = !setupReason && gpt ? gptEditSettings(fal, editEntry) : null;
  if (gptEdit) {
    fal.edit = gptEdit;
    reference = { ...gptEdit.reference, min: 0 };
  }
  // Price per image: per-image units directly; per-megapixel units by the
  // output area in fal's megapixels (1024 x 1024 px), rounded up.
  const tiers = [];
  if (gpt) { for (const quality of GPT_QUALITIES) tiers.push({ quality, cost: gptCost(gpt, quality) }); }
  else if (!(rate > 0) || String(price?.currency || 'USD').toUpperCase() !== 'USD') { if (!setupReason) setupReason = 'No published USD price for this fal.ai model.'; }
  else if (/^(images?|generations?)$/.test(unit)) for (const ratio of aspectRatios) tiers.push({ size: sizes[ratio], cost: rate });
  // Some edit endpoints also bill for input pixels. Do not reuse the output-only quote.
  else if (!reference && /megapixel/.test(unit)) for (const ratio of aspectRatios) {
    const [w, h] = sizes[ratio].split('x').map(Number);
    tiers.push({ size: sizes[ratio], cost: Math.round(rate * Math.max(1, Math.ceil(w * h / (1024 * 1024) - 1e-9)) * 1e6) / 1e6 });
  } else if (!setupReason) setupReason = 'fal.ai bills this model per ' + unit + ', which is not supported.';
  const promptMax = Number(props.prompt?.maxLength) || 4000;
  const label = gpt ? gpt.label : name.replace(/\s+(Text to Image|Text-to-Image|API)$/i, '').slice(0, 120);
  const image = reference
    ? { supported: true, max: reference.max, min: reference.min, roles: ['image_references'], maxBytes: REFERENCE_BYTES, formats: ['jpeg', 'png', 'webp'] }
    : { supported: false, max: 0, min: 0, roles: [] };
  return {
    providerModelId: endpoint, publicModelId: publicId(endpoint),
    label: edit ? label + ' · Image Edit' : reference ? label + ' · References' : label, mediaType: 'image',
    options: {
      catalogVerified: true, adapterSupported: !setupReason, setupReason, gatewayType: 'image',
      pricing: {
        ...(tiers.length ? { image_dimension_quality_pricing: tiers } : {}),
        ...(gptEdit ? { reference_image_dimension_quality_pricing: GPT_QUALITIES.map(quality =>
          ({ quality, cost: gptCost(gpt, quality, GPT_EDITS[endpoint].imageUsd) })) } : {}),
      },
      aspectRatios, defaultAspectRatio: aspectRatios.includes('1:1') ? '1:1' : aspectRatios[0] || null,
      falImage: { ...fal, sizes, hasNumImages: Boolean(props.num_images), hasMaxImages: Boolean(reference && props.max_images?.type === 'integer') },
      supportedOperations: [...(!reference?.min ? ['text-to-image'] : []), ...(reference ? ['image-to-image'] : [])], imageSizes: [],
      qualities: gpt && props.quality ? GPT_QUALITIES : [], defaultQuality: gpt && props.quality ? 'high' : undefined,
      referenceCapabilities: { textOnly: !reference, totalMax: image.max, image, video: { supported: false, max: 0 }, audio: { supported: false, max: 0 } },
      inputLimits: { text: { max_chars: Math.min(promptMax, 8000) } },
    },
  };
}

// "fal-ai/flux-lora/stream" -> "Flux Lora Stream" (vendor and "text-to-image" dropped).
const endpointTokens = endpoint => String(endpoint).split('/').slice(1).filter(s => s !== 'text-to-image').join('/').split(/[\/_-]+/).filter(Boolean);
const titleWords = tokens => tokens.map(t => t[0].toUpperCase() + t.slice(1)).join(' ');

// fal names some models only by endpoint, and gives variants one name
// ("Wan" x3). Raw names are made readable; variants get the part of their
// endpoint that differs; plain aliases (flux/dev and flux-1/dev at one
// price) are kept once.
function distinctLabels(models) {
  for (const m of models) if (m.label.includes('/') || !m.label.trim()) m.label = titleWords(endpointTokens(m.providerModelId)) || m.providerModelId;
  const groups = new Map();
  for (const m of models) if (m.options.adapterSupported) groups.set(m.label, [...(groups.get(m.label) || []), m]);
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => a.providerModelId.length - b.providerModelId.length);
    const kept = [];
    for (const m of group) {
      const tokens = new Set(endpointTokens(m.providerModelId)), price = JSON.stringify(m.options.pricing);
      const alias = kept.find(k => { const other = new Set(endpointTokens(k.providerModelId));
        const diff = [...tokens].filter(t => !other.has(t)).concat([...other].filter(t => !tokens.has(t)));
        return JSON.stringify(k.options.pricing) === price &&
          JSON.stringify(k.options.referenceCapabilities) === JSON.stringify(m.options.referenceCapabilities) &&
          diff.every(t => /^\d$/.test(t)); });
      if (alias) Object.assign(m.options, { adapterSupported: false, setupReason: 'Same model as ' + alias.providerModelId + '.' });
      else kept.push(m);
    }
    if (kept.length < 2) continue;
    const common = kept.map(m => new Set(endpointTokens(m.providerModelId))).reduce((a, b) => new Set([...a].filter(t => b.has(t))));
    for (const m of kept) { const extra = titleWords(endpointTokens(m.providerModelId).filter(t => !common.has(t))); if (extra) m.label += ' · ' + extra; }
  }
  return models;
}

// Both fal image categories, with the schema and price of the exact endpoint.
async function fetchFalImageCatalog({ apiKey, fetchImpl = fetch } = {}) {
  if (!apiKey) throw Object.assign(new Error('Save a fal.ai API key in Admin first.'), { statusCode: 400 });
  const list = async category => {
    const models = [];
    let cursor = '';
    for (let page = 0; page < 30; page++) {
      const r = await platform('/models?category=' + category + '&status=active&limit=100' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), { apiKey, fetchImpl });
      for (const m of r?.models || []) if (m?.endpoint_id && m.metadata?.status !== 'deprecated') {
        models.push([m.endpoint_id, { ...m.metadata, category }]);
      }
      if (!r?.has_more || !r.next_cursor) break;
      cursor = r.next_cursor;
    }
    return models;
  };
  const [textModels, editModels] = await Promise.all([list('text-to-image'), list('image-to-image')]);
  const metadata = new Map(textModels);
  for (const [id, info] of editModels) if (!metadata.has(id)) metadata.set(id, info);
  const ids = [...metadata.keys()];
  const entries = [], prices = new Map();
  // Schemas: the expanded listing is requested without the key (with the key
  // fal answered without the OpenAPI document, so every model looked like it
  // had no prompt). Missing documents fall back to fal's per-model file.
  for (let i = 0; i < ids.length; i += 10) {
    const q = ids.slice(i, i + 10).map(id => 'endpoint_id=' + encodeURIComponent(id)).join('&');
    try { entries.push(...((await platform('/models?' + q + '&expand=openapi-3.0', { fetchImpl }))?.models || [])); } catch {}
  }
  const byId = new Map(entries.map(e => [e.endpoint_id, e]));
  for (const id of ids) {
    const entry = byId.get(id);
    if (entry?.openapi?.paths) continue;
    try {
      const r = await fetchImpl('https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=' + encodeURIComponent(id), { signal: AbortSignal.timeout(30000) });
      if (!r.ok) continue;
      const openapi = await r.json();
      if (entry) entry.openapi = openapi; else { const e = { endpoint_id: id, metadata: {}, openapi }; entries.push(e); byId.set(id, e); }
    } catch {}
  }
  const priceErrors = [];
  const loadPrices = async batch => {
    const q = batch.map(id => 'endpoint_id=' + encodeURIComponent(id)).join('&');
    try { for (const p of (await platform('/models/pricing?' + q, { apiKey, fetchImpl }))?.prices || []) prices.set(p.endpoint_id, p); return true; }
    catch (error) { priceErrors.push(error.providerStatus || error.message); return false; }
  };
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    // One unknown endpoint can fail a whole batch: retry those one by one.
    if (!(await loadPrices(batch)) && batch.length > 1) for (const id of batch) await loadPrices([id]);
  }
  if (!entries.length) throw Object.assign(new Error('fal.ai returned no image models.'), { statusCode: 502 });
  const described = ids.filter(id => byId.has(id)).map(id => {
    const entry = byId.get(id);
    const editEndpoint = GPT_EDITS[id]?.endpoint;
    return describeFalImageModel({ ...entry, metadata: { ...entry.metadata, ...metadata.get(id) } }, prices.get(id),
      metadata.has(editEndpoint) ? byId.get(editEndpoint) : null);
  });
  const paired = new Set(described.map(model => model.options.falImage.edit?.endpoint).filter(Boolean));
  const models = distinctLabels(described.filter(model => !paired.has(model.providerModelId)));
  // Why models were left off, for the sync log and Admin.
  const reasons = {}, units = {};
  for (const m of models) if (!m.options.adapterSupported) { const r = m.options.setupReason.replace(/\(.*\)/, '(…)'); reasons[r] = (reasons[r] || 0) + 1; }
  for (const p of prices.values()) units[p.unit + ' ' + p.currency] = (units[p.unit + ' ' + p.currency] || 0) + 1;
  models.diagnostics = { listed: ids.length, described: entries.length, priced: prices.size, priceErrors: [...new Set(priceErrors)].slice(0, 5), reasons, units };
  return models;
}

// Generation: submit to fal's queue, wait for the result, download the image.
class FalImageClient {
  constructor({ apiKey = '', fetchImpl = fetch, pollMs = 1500, timeoutMs = 240000 } = {}) {
    this.fal = new FalClient({ apiKey, fetchImpl }); this.fetch = fetchImpl; this.pollMs = pollMs; this.timeoutMs = timeoutMs;
  }
  input(model, options, references = []) {
    const settings = model.falImage || {};
    const fal = references.length && settings.edit ? { ...settings, ...settings.edit } : settings;
    const ratio = String(options.aspectRatio || model.defaultAspectRatio || '1:1');
    const value = fal.values?.[ratio];
    if (!value) throw new Error('Unsupported aspect ratio for this image model.');
    const input = { prompt: String(options.prompt || '') };
    if (fal.sizeParam === 'image_size') {
      if (value === 'custom') { const [width, height] = String(fal.sizes[ratio]).split('x').map(Number); input.image_size = { width, height }; }
      else input.image_size = value;
    } else input.aspect_ratio = value;
    if (fal.hasNumImages) input.num_images = 1;
    if (fal.hasMaxImages) input.max_images = 1;
    if (fal.hasQuality && options.quality) input.quality = String(options.quality);
    if (fal.inputFidelity) input.input_fidelity = fal.inputFidelity;
    const ref = fal.reference;
    if (references.length < (ref?.min || 0) || references.length > (ref?.max || 0)) {
      throw new Error('Invalid reference image count for this model.');
    }
    if (references.length) {
      const urls = references.map(image => image.url);
      if (urls.some(url => typeof url !== 'string' || !url)) throw new Error('A reference image is unavailable.');
      input[ref.field] = ref.array ? urls : urls[0];
    }
    return input;
  }
  async generateImage(model, options, references) {
    const fal = model.falImage;
    const endpoint = references?.length && fal.edit ? fal.edit.endpoint : fal.endpoint;
    const op = await this.fal.submit(endpoint, this.input(model, options, references));
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      const st = await this.fal.status(op);
      if (st?.status === 'COMPLETED') {
        if (st.error) throw new Error('The image service could not create this image: ' + String(st.error).slice(0, 200));
        break;
      }
      if (Date.now() > deadline) throw new Error('The image took too long to generate. Credits were refunded.');
      await sleep(this.pollMs);
    }
    const result = await this.fal.result(op);
    const url = result?.images?.[0]?.url || result?.image?.url;
    if (!url) throw new Error('The image service returned no image.');
    const response = await this.fetch(checkOutputUrl(url), { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error('The generated image could not be downloaded.');
    const data = await readBounded(response, IMAGE_LIMIT);
    const mimeType = imageMime(data);
    if (!mimeType) throw new Error('The image service returned an unsupported file.');
    return { data, mimeType };
  }
}

module.exports = { PROVIDER, RATIOS, isFalImageModel, publicId, describeFalImageModel, distinctLabels, fetchFalImageCatalog, FalImageClient, inputSchema };
