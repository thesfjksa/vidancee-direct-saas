'use strict';
// fal.ai text-to-image models as a priced image source ('falimg'; the 'fal'
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
// Inputs that need a file or account-specific value: not a plain text-to-image model.
const EXTRA_INPUTS = /image|mask|control|finetune|model_name|lora_path|reference/i;

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
  const ref = post?.requestBody?.content?.['application/json']?.schema?.$ref;
  const schema = schemas[String(ref || '').split('/').pop()] || {};
  return { props: schema.properties || {}, required: schema.required || [] };
}
const enumOf = prop => prop?.enum || (prop?.anyOf || []).flatMap(x => x?.enum || []);

// One catalog entry plus its price ({unit_price, unit}) as a provider model.
function describeFalImageModel(entry, price = null) {
  const endpoint = entry.endpoint_id;
  const { props, required } = inputSchema(entry);
  const name = entry.metadata?.display_name || endpoint;
  let setupReason = '';
  const fal = { endpoint, sizeParam: null, values: {} };
  if (props.image_size) {
    fal.sizeParam = 'image_size';
    const presets = enumOf(props.image_size);
    const custom = (props.image_size.anyOf || []).some(x => x?.$ref) || props.image_size.$ref;
    for (const ratio of RATIOS) {
      if (presets.includes(PRESETS[ratio])) fal.values[ratio] = PRESETS[ratio];
      else if (custom) fal.values[ratio] = 'custom';
    }
  } else if (props.aspect_ratio) {
    fal.sizeParam = 'aspect_ratio';
    const allowed = enumOf(props.aspect_ratio);
    for (const ratio of RATIOS) if (allowed.includes(ratio)) fal.values[ratio] = ratio;
  }
  const extra = required.filter(r => r !== 'prompt');
  if (!props.prompt) setupReason = 'This fal.ai model has no text prompt.';
  else if (extra.length || Object.keys(props).some(k => required.includes(k) && EXTRA_INPUTS.test(k))) setupReason = 'This fal.ai model needs extra inputs (' + extra.join(', ') + ').';
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
  // Price per image: per-image units directly; per-megapixel units by the
  // output area in fal's megapixels (1024 x 1024 px), rounded up.
  const unit = String(price?.unit || '').toLowerCase(), rate = Number(price?.unit_price);
  const tiers = [];
  if (!(rate > 0) || String(price?.currency || 'USD').toUpperCase() !== 'USD') { if (!setupReason) setupReason = 'No published USD price for this fal.ai model.'; }
  else if (/^(images?|generations?)$/.test(unit)) for (const ratio of aspectRatios) tiers.push({ size: sizes[ratio], cost: rate });
  else if (/megapixel/.test(unit)) for (const ratio of aspectRatios) {
    const [w, h] = sizes[ratio].split('x').map(Number);
    tiers.push({ size: sizes[ratio], cost: Math.round(rate * Math.max(1, Math.ceil(w * h / (1024 * 1024) - 1e-9)) * 1e6) / 1e6 });
  } else if (!setupReason) setupReason = 'fal.ai bills this model per ' + unit + ', which is not supported.';
  const promptMax = Number(props.prompt?.maxLength) || 4000;
  return {
    providerModelId: endpoint, publicModelId: publicId(endpoint), label: name.replace(/\s+(Text to Image|Text-to-Image|API)$/i, '').slice(0, 120), mediaType: 'image',
    options: {
      catalogVerified: true, adapterSupported: !setupReason, setupReason, gatewayType: 'image',
      pricing: tiers.length ? { image_dimension_quality_pricing: tiers } : {},
      aspectRatios, defaultAspectRatio: aspectRatios.includes('1:1') ? '1:1' : aspectRatios[0] || null,
      falImage: { ...fal, sizes, hasNumImages: Boolean(props.num_images) },
      supportedOperations: ['text-to-image'], qualities: [], imageSizes: [],
      referenceCapabilities: { textOnly: true, totalMax: 0, image: { supported: false, max: 0, min: 0, roles: [] }, video: { supported: false, max: 0 }, audio: { supported: false, max: 0 } },
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
        return JSON.stringify(k.options.pricing) === price && diff.every(t => /^\d$/.test(t)); });
      if (alias) Object.assign(m.options, { adapterSupported: false, setupReason: 'Same model as ' + alias.providerModelId + '.' });
      else kept.push(m);
    }
    if (kept.length < 2) continue;
    const common = kept.map(m => new Set(endpointTokens(m.providerModelId))).reduce((a, b) => new Set([...a].filter(t => b.has(t))));
    for (const m of kept) { const extra = titleWords(endpointTokens(m.providerModelId).filter(t => !common.has(t))); if (extra) m.label += ' · ' + extra; }
  }
  return models;
}

// Every text-to-image model fal lists, with its schema and price.
async function fetchFalImageCatalog({ apiKey, fetchImpl = fetch } = {}) {
  if (!apiKey) throw Object.assign(new Error('Save a fal.ai API key in Admin first.'), { statusCode: 400 });
  const ids = [];
  let cursor = '';
  for (let page = 0; page < 30; page++) {
    const r = await platform('/models?category=text-to-image&status=active&limit=100' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), { apiKey, fetchImpl });
    for (const m of r?.models || []) if (m?.endpoint_id && m.metadata?.status !== 'deprecated') ids.push(m.endpoint_id);
    if (!r?.has_more || !r.next_cursor) break;
    cursor = r.next_cursor;
  }
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
  const models = distinctLabels(entries.map(entry => describeFalImageModel(entry, prices.get(entry.endpoint_id))));
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
  input(model, options) {
    const fal = model.falImage || {};
    const ratio = String(options.aspectRatio || model.defaultAspectRatio || '1:1');
    const value = fal.values?.[ratio];
    if (!value) throw new Error('Unsupported aspect ratio for this image model.');
    const input = { prompt: String(options.prompt || '') };
    if (fal.sizeParam === 'image_size') {
      if (value === 'custom') { const [width, height] = String(fal.sizes[ratio]).split('x').map(Number); input.image_size = { width, height }; }
      else input.image_size = value;
    } else input.aspect_ratio = value;
    if (fal.hasNumImages) input.num_images = 1;
    return input;
  }
  async generateImage(model, options) {
    const op = await this.fal.submit(model.falImage.endpoint, this.input(model, options));
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
