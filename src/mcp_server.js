'use strict';

// The CMM Tools connector for Claude: a remote MCP server on Streamable HTTP.
// It answers both protocol eras: Claude's current client opens with an
// `initialize` handshake (2025-11-25 and earlier), and newer clients send the
// protocol version in each request's _meta (2026-07-28). The server keeps no
// session state, so every request stands alone.
//
// Tools act as the signed-in customer through injected services, which run
// the same checks, prices and credit rules as the website.

const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MODERN_VERSIONS = ['2026-07-28'];
const SERVER_INFO = { name: 'cmm-tools', title: 'CMM Tools', version: '1.0.0' };
const INSTRUCTIONS = 'CMM Tools makes AI videos and images and charges the signed-in customer\'s CMM Tools credits. '
  + 'list_models gives model ids and options and estimate_cost gives the price in credits. create_video and create_image start a job '
  + 'and return its id at once; jobs run in the background, and get_job (with wait_seconds up to 50) reports progress and, when finished, '
  + 'a download link valid for 7 days. Videos usually take 2 to 10 minutes. To use a photo from the customer\'s computer as a reference, '
  + 'request_image_upload returns a link where they upload it.';
const ACTIVE = ['queued', 'submitting', 'submitted', 'processing'];
const MAX_WAIT_SECONDS = 50;

const PARSE_ERROR = -32700, INVALID_REQUEST = -32600, METHOD_NOT_FOUND = -32601, INVALID_PARAMS = -32602, INTERNAL_ERROR = -32603;
const HEADER_MISMATCH = -32020, UNSUPPORTED_VERSION = -32022;

const referenceItem = {
  type: 'object',
  description: 'One reference image: give exactly one of upload_id (from request_image_upload), image_job_id (a finished CMM Tools image), or url (a public https image link).',
  properties: {
    upload_id: { type: 'string', description: 'Id returned by request_image_upload, after the customer uploaded the image.' },
    image_job_id: { type: 'string', description: 'Id of a finished image job from this account.' },
    url: { type: 'string', description: 'Public https link to a JPEG, PNG or WebP image (15 MB max).' },
  },
  additionalProperties: false,
};

const TOOLS = [
  {
    name: 'get_account', title: 'Get account',
    description: 'Shows the signed-in CMM Tools account: email, credit balance, plan, and how many jobs can run at once.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'Get account', readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'list_models', title: 'List models',
    description: 'Lists the video and image models this account can use, with their ids, resolutions, durations, aspect ratios, qualities, sizes and reference-image limits.',
    inputSchema: { type: 'object', properties: { media_type: { type: 'string', enum: ['video', 'image'], description: 'Only list video or image models.' } }, additionalProperties: false },
    annotations: { title: 'List models', readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'estimate_cost', title: 'Estimate cost',
    description: 'Returns the price in credits of a video or image with the given settings, without creating anything.',
    inputSchema: {
      type: 'object',
      properties: {
        media_type: { type: 'string', enum: ['video', 'image'] },
        model: { type: 'string', description: 'Model id from list_models.' },
        duration: { type: 'integer', description: 'Video length in seconds.' },
        resolution: { type: 'string', description: 'Video resolution, such as 720p or 1080p.' },
        aspect_ratio: { type: 'string', description: 'Such as 16:9, 9:16 or 1:1.' },
        generate_audio: { type: 'boolean', description: 'Video with a generated soundtrack (models that support audio).' },
        quality: { type: 'string', description: 'Image quality, for models that offer it.' },
        image_size: { type: 'string', description: 'Image size, for models that offer it.' },
      },
      required: ['media_type', 'model'], additionalProperties: false,
    },
    annotations: { title: 'Estimate cost', readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'create_video', title: 'Create video',
    description: 'Starts an AI video job on CMM Tools and charges its price in credits. Returns the job id immediately; the video is ready after a few minutes (see get_job).',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'Video model id from list_models.' },
        prompt: { type: 'string', description: 'What the video should show.' },
        duration: { type: 'integer', description: 'Length in seconds (the model\'s default if left out).' },
        resolution: { type: 'string', description: '720p or 1080p (the model\'s default if left out).' },
        aspect_ratio: { type: 'string', description: 'Such as 16:9, 9:16 or 1:1 (the model\'s default if left out).' },
        generate_audio: { type: 'boolean', description: 'Add a generated soundtrack (models that support audio; default true).' },
        reference_images: { type: 'array', items: referenceItem, maxItems: 9, description: 'Optional reference images.' },
        image_mode: {
          type: 'string', enum: ['reference', 'first_frame', 'first_and_last_frame'],
          description: 'How reference images are used: as references for subject and style (default), as the first frame, or as the first and last frames (two images).',
        },
      },
      required: ['model', 'prompt'], additionalProperties: false,
    },
    annotations: { title: 'Create video', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'create_image', title: 'Create image',
    description: 'Starts an AI image job on CMM Tools and charges its price in credits. Returns the job id immediately; images are usually ready within a minute (see get_job).',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'Image model id from list_models.' },
        prompt: { type: 'string', description: 'What the image should show.' },
        aspect_ratio: { type: 'string', description: 'Such as 1:1, 16:9 or 9:16 (the model\'s default if left out).' },
        quality: { type: 'string', description: 'For models that offer qualities.' },
        image_size: { type: 'string', description: 'For models that offer sizes.' },
        reference_images: { type: 'array', items: referenceItem, maxItems: 14, description: 'Optional reference images to edit or follow.' },
      },
      required: ['model', 'prompt'], additionalProperties: false,
    },
    annotations: { title: 'Create image', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'get_job', title: 'Get job',
    description: 'Reports the status of a video, image or upscale job. With wait_seconds it waits up to that long for the job to finish. A finished job includes a download link valid for 7 days.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string' },
        wait_seconds: { type: 'integer', minimum: 0, maximum: MAX_WAIT_SECONDS, description: 'Wait for the job to finish, up to 50 seconds.' },
      },
      required: ['job_id'], additionalProperties: false,
    },
    annotations: { title: 'Get job', readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'list_jobs', title: 'List jobs',
    description: 'Lists recent video and image jobs from this account, newest first.',
    inputSchema: {
      type: 'object',
      properties: {
        media_type: { type: 'string', enum: ['video', 'image'] },
        limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Default 10.' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'List jobs', readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'upscale_video', title: 'Upscale video',
    description: 'Starts upscaling a finished CMM Tools video to 1080p, 2K or 4K and charges its price in credits. Returns a new job id.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'Id of a finished video job.' },
        resolution: { type: 'string', enum: ['1080p', '2k', '4k'] },
      },
      required: ['job_id', 'resolution'], additionalProperties: false,
    },
    annotations: { title: 'Upscale video', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'request_image_upload', title: 'Request image upload',
    description: 'Creates a link, valid for 1 hour, where the customer uploads a photo from their device. The returned upload_id can then be used in reference_images.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'Request image upload', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'list_uploads', title: 'List uploads',
    description: 'Lists images the customer uploaded through request_image_upload links in the last 7 days, and whether each is ready.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'List uploads', readOnlyHint: true, openWorldHint: false },
  },
];
const TOOL_NAMES = new Set(TOOLS.map(t => t.name));

class ToolInputError extends Error {}
const bad = message => { throw new ToolInputError(message); };

function str(args, key, { required = false, max = 200 } = {}) {
  const value = args[key];
  if (value == null || value === '') { if (required) bad(key + ' is required.'); return undefined; }
  if (typeof value !== 'string') bad(key + ' must be a string.');
  if (value.length > max) bad(key + ' is too long.');
  return value.trim();
}
function int(args, key, { min = 0, max = 3600 } = {}) {
  const value = args[key];
  if (value == null) return undefined;
  if (!Number.isInteger(value) || value < min || value > max) bad(key + ' must be a whole number from ' + min + ' to ' + max + '.');
  return value;
}
function bool(args, key) {
  const value = args[key];
  if (value == null) return undefined;
  if (typeof value !== 'boolean') bad(key + ' must be true or false.');
  return value;
}
function checkUnknown(tool, args) {
  const allowed = Object.keys(tool.inputSchema.properties || {});
  const extra = Object.keys(args).filter(k => !allowed.includes(k));
  if (extra.length) bad('Unknown argument' + (extra.length > 1 ? 's' : '') + ': ' + extra.join(', ') + '.');
}

// ---------- Model summaries ----------
function rangeOf(numbers) {
  const list = [...new Set(numbers.map(Number).filter(n => n > 0))].sort((a, b) => a - b);
  if (!list.length) return null;
  const contiguous = list.every((n, i) => !i || n - list[i - 1] === 1);
  return contiguous && list.length > 3 ? { min: list[0], max: list[list.length - 1] } : list;
}
function imageModes(capability = {}) {
  const roles = capability.roles || [], modes = [];
  if (roles.includes('image_references')) modes.push('reference');
  if (roles.includes('start_image')) modes.push('first_frame');
  if (roles.includes('start_image') && roles.includes('end_image')) modes.push('first_and_last_frame');
  return modes;
}
function videoModelSummary(m) {
  const img = m.capabilities?.image || {};
  return {
    id: m.id, name: m.label,
    resolutions: (m.resolutions || []).map(r => r.id), default_resolution: m.defaultResolution || null,
    durations_seconds: rangeOf((m.durations || []).map(d => d.seconds)), default_duration: m.defaultDuration || null,
    aspect_ratios: m.aspectRatios || [], default_aspect_ratio: m.defaultAspectRatio || null,
    audio: Boolean(m.supportsAudio),
    reference_images: img.supported ? { max: Number(img.max || 0), modes: imageModes(img) } : null,
    needs_reference_image: m.capabilities?.textOnly === false,
  };
}
function imageModelSummary(m) {
  const img = m.capabilities?.image || m.referenceCapabilities?.image || {};
  return {
    id: m.id, name: m.label,
    aspect_ratios: m.aspectRatios || [], default_aspect_ratio: m.defaultAspectRatio || null,
    ...(m.qualities?.length ? { qualities: m.qualities, default_quality: m.defaultQuality || null } : {}),
    ...(m.imageSizes?.length ? { image_sizes: m.imageSizes, default_image_size: m.defaultImageSize || null } : {}),
    reference_images_max: img.supported === false ? 0 : Number(img.max || 0),
  };
}
// Image price as Image Studio shows it, or null when it needs a live quote.
function imagePriceFromCatalog(m, { aspectRatio, quality, imageSize }) {
  if (!m.dynamicCost) {
    const value = m.costByQuality?.[quality || m.defaultQuality]?.[aspectRatio] ?? m.costByAspectRatio?.[aspectRatio] ?? m.cost;
    return value == null ? null : Number(value);
  }
  const key = aspectRatio + '|' + (m.qualities?.length ? quality || '' : '') + '|' + (m.imageSizes?.length ? imageSize || '' : '');
  return m.costTable && Object.hasOwn(m.costTable, key) ? Number(m.costTable[key]) : null;
}

// ---------- Job formatting ----------
function jobView(job, services) {
  const done = job.status === 'completed' && (job.has_video || job.has_image);
  const view = {
    job_id: job.id, media_type: job.media_type || (job.has_image != null ? 'image' : 'video'),
    kind: job.generation_options?.studio === 'upscale' ? 'upscale' : job.media_type,
    status: job.status, finished: !ACTIVE.includes(job.status),
    model: job.model, prompt: String(job.prompt || '').slice(0, 300),
    ...(job.duration ? { duration_seconds: Number(job.duration) } : {}),
    ...(job.resolution ? { resolution: job.resolution } : {}),
    aspect_ratio: job.aspect_ratio, credits_charged: Number(job.credits_cost),
    created_at: job.created_at, completed_at: job.completed_at || null,
  };
  if (job.error_message) view.message = job.error_message;
  if (job.refunded_at) view.refunded = true;
  if (done) {
    view.download_url = services.shareUrl(job.id);
    view.download_link_expires = '7 days';
  }
  return view;
}

function textResult(value, structured = value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent: structured };
}
function errorResult(message) {
  return { content: [{ type: 'text', text: String(message) }], isError: true };
}

async function resolveReferences(services, user, list, max) {
  if (list == null) return [];
  if (!Array.isArray(list)) bad('reference_images must be a list.');
  if (list.length && !max) bad('This model does not accept reference images.');
  if (list.length > max) bad('This model accepts at most ' + max + ' reference image' + (max === 1 ? '' : 's') + '.');
  const out = [];
  for (const [i, ref] of list.entries()) {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)) bad('reference_images[' + i + '] must be an object.');
    const keys = ['upload_id', 'image_job_id', 'url'].filter(k => ref[k] != null && ref[k] !== '');
    if (keys.length !== 1 || Object.keys(ref).some(k => !['upload_id', 'image_job_id', 'url'].includes(k))) {
      bad('reference_images[' + i + '] needs exactly one of upload_id, image_job_id or url.');
    }
    if (typeof ref[keys[0]] !== 'string') bad('reference_images[' + i + '].' + keys[0] + ' must be a string.');
    out.push(await services.loadReference(user, { [keys[0]]: ref[keys[0]].trim() }));
  }
  return out;
}

function rolesFor(mode, count, capability = {}) {
  const roles = capability.roles || [];
  if (mode === 'first_frame') {
    if (!roles.includes('start_image')) bad('This model cannot use an image as the first frame.');
    if (count !== 1) bad('first_frame needs exactly one reference image.');
    return ['start_image'];
  }
  if (mode === 'first_and_last_frame') {
    if (!roles.includes('start_image') || !roles.includes('end_image')) bad('This model cannot use first and last frames.');
    if (count !== 2) bad('first_and_last_frame needs exactly two reference images.');
    return ['start_image', 'end_image'];
  }
  const role = roles.includes('image_references') ? 'image_references' : roles[0] || '';
  return Array(count).fill(role);
}

// ---------- Tools ----------
async function runTool(name, args, ctx) {
  const { services, user } = ctx;
  const tool = TOOLS.find(t => t.name === name);
  checkUnknown(tool, args);

  if (name === 'get_account') return textResult(await services.account(user));

  if (name === 'list_models') {
    const type = str(args, 'media_type');
    if (type && !['video', 'image'].includes(type)) bad('media_type must be video or image.');
    const catalog = await services.catalog(user);
    const out = {};
    if (type !== 'image') out.video_models = catalog.video.map(videoModelSummary);
    if (type !== 'video') out.image_models = catalog.image.map(imageModelSummary);
    if (!type) out.upscaler = catalog.upscaler.enabled ? { resolutions: catalog.upscaler.resolutions.map(r => r.id) } : null;
    return textResult(out);
  }

  if (name === 'estimate_cost') {
    const type = str(args, 'media_type', { required: true }), model = str(args, 'model', { required: true });
    if (!['video', 'image'].includes(type)) bad('media_type must be video or image.');
    const catalog = await services.catalog(user);
    const entry = (type === 'video' ? catalog.video : catalog.image).find(m => m.id === model);
    if (!entry) bad('Unknown ' + type + ' model "' + model + '". Use list_models for the ids available to this account.');
    const aspectRatio = str(args, 'aspect_ratio') || entry.defaultAspectRatio;
    if (type === 'video') {
      const body = { model, mediaType: 'video', aspectRatio, duration: int(args, 'duration', { min: 1, max: 60 }) ?? entry.defaultDuration,
        resolution: str(args, 'resolution') || entry.defaultResolution, generateAudio: bool(args, 'generate_audio') ?? true };
      const quote = await services.quote(user, body);
      return textResult({ media_type: 'video', model, credits: quote.cost, estimate: Boolean(quote.isEstimate),
        settings: { duration_seconds: body.duration, resolution: body.resolution, aspect_ratio: aspectRatio, audio: body.generateAudio } });
    }
    const settings = { aspectRatio, quality: str(args, 'quality') || entry.defaultQuality || undefined, imageSize: str(args, 'image_size') || entry.defaultImageSize || undefined };
    let credits = imagePriceFromCatalog(entry, settings), estimate = false;
    if (credits == null) { const q = await services.quote(user, { model, mediaType: 'image', ...settings }); credits = q.cost; estimate = Boolean(q.isEstimate); }
    return textResult({ media_type: 'image', model, credits, estimate, settings: { aspect_ratio: aspectRatio, quality: settings.quality || null, image_size: settings.imageSize || null } });
  }

  if (name === 'create_video') {
    const model = str(args, 'model', { required: true }), prompt = str(args, 'prompt', { required: true, max: 8000 });
    const catalog = await services.catalog(user);
    const entry = catalog.video.find(m => m.id === model);
    if (!entry) bad('Unknown video model "' + model + '". Use list_models for the ids available to this account.');
    const mode = str(args, 'image_mode') || 'reference';
    if (!['reference', 'first_frame', 'first_and_last_frame'].includes(mode)) bad('image_mode must be reference, first_frame or first_and_last_frame.');
    const capability = entry.capabilities?.image || {};
    const images = await resolveReferences(services, user, args.reference_images, Math.max(0, Number(capability.max || 0)) || 0);
    if (images.length && !capability.supported) bad('This model does not accept reference images.');
    const roles = images.length ? rolesFor(mode, images.length, capability) : [];
    // Frame modes follow the first image's shape on some models; the server decides.
    const body = {
      model, prompt,
      duration: int(args, 'duration', { min: 1, max: 60 }) ?? entry.defaultDuration,
      resolution: str(args, 'resolution') || entry.defaultResolution,
      aspectRatio: str(args, 'aspect_ratio') || entry.defaultAspectRatio,
      generateAudio: bool(args, 'generate_audio') ?? true,
      images, referenceOrder: JSON.stringify(images.map((_, index) => ({ kind: 'fresh', index, role: roles[index] }))),
      videos: [], videoRoles: '[]',
    };
    if (!images.length) delete body.referenceOrder;
    const { generation, credits } = await services.submitVideo(user, body);
    ctx.log('mcp.create_video', 'Video job ' + generation.id + ' · ' + model, { model, duration: body.duration, resolution: body.resolution, aspectRatio: body.aspectRatio, references: images.length }, generation.id);
    return textResult({ ...jobView(generation, services), credits_left: credits,
      next: 'Use get_job with this job_id (wait_seconds up to 50) to follow it. Videos usually take 2 to 10 minutes.' });
  }

  if (name === 'create_image') {
    const model = str(args, 'model', { required: true }), prompt = str(args, 'prompt', { required: true, max: 8000 });
    const catalog = await services.catalog(user);
    const entry = catalog.image.find(m => m.id === model);
    if (!entry) bad('Unknown image model "' + model + '". Use list_models for the ids available to this account.');
    const capability = entry.capabilities?.image || entry.referenceCapabilities?.image || {};
    const images = await resolveReferences(services, user, args.reference_images, Math.max(0, Number(capability.max || 0)));
    const body = { model, prompt, aspectRatio: str(args, 'aspect_ratio') || entry.defaultAspectRatio, images };
    const quality = str(args, 'quality') || entry.defaultQuality, imageSize = str(args, 'image_size') || entry.defaultImageSize;
    if (quality && entry.qualities?.length) body.quality = quality;
    if (imageSize && entry.imageSizes?.length) body.imageSize = imageSize;
    const { generation, credits } = await services.submitImage(user, body);
    ctx.log('mcp.create_image', 'Image job ' + generation.id + ' · ' + model, { model, aspectRatio: body.aspectRatio, references: images.length }, generation.id);
    return textResult({ ...jobView({ ...generation, media_type: 'image' }, services), credits_left: credits,
      next: 'Use get_job with this job_id (wait_seconds up to 50) to get the image.' });
  }

  if (name === 'get_job') {
    const id = str(args, 'job_id', { required: true, max: 64 });
    if (!/^[0-9a-f-]{36}$/i.test(id)) bad('job_id is not a CMM Tools job id.');
    const wait = int(args, 'wait_seconds', { min: 0, max: MAX_WAIT_SECONDS }) || 0;
    const deadline = Date.now() + wait * 1000;
    let job = await services.getJob(user, id);
    if (!job) bad('No job ' + id + ' on this account.');
    if (ACTIVE.includes(job.status)) services.wake();
    while (ACTIVE.includes(job.status) && Date.now() + 3000 <= deadline && !ctx.signal?.aborted) {
      await new Promise(resolve => setTimeout(resolve, 3000));
      job = await services.getJob(user, id) || job;
    }
    return textResult(jobView(job, services));
  }

  if (name === 'list_jobs') {
    const type = str(args, 'media_type');
    if (type && !['video', 'image'].includes(type)) bad('media_type must be video or image.');
    const limit = int(args, 'limit', { min: 1, max: 20 }) || 10;
    const jobs = await services.listJobs(user, { mediaType: type, limit });
    return textResult({ jobs: jobs.map(job => jobView(job, services)) });
  }

  if (name === 'upscale_video') {
    const id = str(args, 'job_id', { required: true, max: 64 }), resolution = str(args, 'resolution', { required: true });
    if (!/^[0-9a-f-]{36}$/i.test(id)) bad('job_id is not a CMM Tools job id.');
    if (!['1080p', '2k', '4k'].includes(resolution)) bad('resolution must be 1080p, 2k or 4k.');
    const { generation, credits } = await services.submitUpscale(user, { generationId: id, resolution });
    ctx.log('mcp.upscale_video', 'Upscale job ' + generation.id + ' from ' + id + ' to ' + resolution, { source: id, resolution }, generation.id);
    return textResult({ ...jobView(generation, services), credits_left: credits, next: 'Use get_job with this job_id to follow it.' });
  }

  if (name === 'request_image_upload') {
    const upload = await services.createUpload(user);
    ctx.log('mcp.upload_link', 'Upload link ' + upload.id, null);
    return textResult({ upload_id: upload.id, upload_url: upload.url, link_expires: '1 hour',
      next: 'The customer opens upload_url and picks a photo. Then use {"upload_id": "' + upload.id + '"} in reference_images.' });
  }

  if (name === 'list_uploads') return textResult({ uploads: await services.listUploads(user) });
  return errorResult('Unknown tool.');
}

// ---------- JSON-RPC ----------
function rpcError(id, code, message, data) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } };
}
function rpcResult(id, result) { return { jsonrpc: '2.0', id, result }; }

function modernWrap(result, { list = false, scope = 'private', ttlMs = 0 } = {}) {
  return { ...result, resultType: 'complete', _meta: { ...(result._meta || {}), 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
    ...(list ? { ttlMs, cacheScope: scope } : {}) };
}

// Handles one JSON-RPC message. Returns {status, body} (body null for 202).
async function handleMessage(message, ctx) {
  if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0') {
    return { status: 400, body: rpcError(null, INVALID_REQUEST, 'Invalid JSON-RPC message.') };
  }
  const { id, method } = message;
  // Notifications and client responses need no reply.
  if (method === undefined && ('result' in message || 'error' in message)) return { status: 202, body: null };
  if (typeof method !== 'string') return { status: 400, body: rpcError(id, INVALID_REQUEST, 'Missing method.') };
  if (id === undefined) return { status: 202, body: null };

  const params = message.params && typeof message.params === 'object' ? message.params : {};
  const meta = params._meta && typeof params._meta === 'object' ? params._meta : {};
  const requested = meta['io.modelcontextprotocol/protocolVersion'];
  let modern = false;
  if (requested !== undefined) {
    if (ctx.protocolHeader && ctx.protocolHeader !== requested) {
      return { status: 400, body: rpcError(id, HEADER_MISMATCH, 'MCP-Protocol-Version header does not match _meta.') };
    }
    if (![...MODERN_VERSIONS, ...LEGACY_VERSIONS].includes(requested)) {
      return { status: 400, body: rpcError(id, UNSUPPORTED_VERSION, 'Unsupported protocol version', { supported: [...MODERN_VERSIONS, ...LEGACY_VERSIONS], requested }) };
    }
    modern = MODERN_VERSIONS.includes(requested);
  }
  const reply = (result, options) => ({ status: 200, body: rpcResult(id, modern ? modernWrap(result, options) : result) });

  try {
    if (method === 'initialize') {
      const asked = String(params.protocolVersion || '');
      return { status: 200, body: rpcResult(id, {
        protocolVersion: LEGACY_VERSIONS.includes(asked) ? asked : LEGACY_VERSIONS[0],
        capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS,
      }) };
    }
    if (method === 'ping') return reply({});
    if (method === 'server/discover') {
      return reply({ supportedVersions: [...MODERN_VERSIONS, ...LEGACY_VERSIONS], capabilities: { tools: {} }, instructions: INSTRUCTIONS },
        { list: true, scope: 'public', ttlMs: 3600000 });
    }
    if (method === 'tools/list') return reply({ tools: TOOLS }, { list: true, scope: 'public', ttlMs: 3600000 });
    if (method === 'tools/call') {
      const name = params.name, args = params.arguments ?? {};
      if (typeof name !== 'string' || !TOOL_NAMES.has(name)) return { status: 200, body: rpcError(id, INVALID_PARAMS, 'Unknown tool: ' + String(name)) };
      if (!args || typeof args !== 'object' || Array.isArray(args)) return { status: 200, body: rpcError(id, INVALID_PARAMS, 'arguments must be an object.') };
      let result;
      try { result = await runTool(name, args, ctx); }
      catch (error) {
        // Input mistakes and account limits go back to Claude as tool errors.
        const known = error instanceof ToolInputError || (error?.statusCode && error.statusCode < 500);
        if (!known) console.error('[mcp] tool failed', name, error);
        ctx.log('mcp.tool_error', name + ': ' + (error?.message || error), { tool: name, statusCode: error?.statusCode }, null, known ? 'warn' : 'error');
        result = errorResult(known ? error.message : 'CMM Tools could not complete this request. Please try again in a moment.');
      }
      return reply(result);
    }
    return { status: modern ? 404 : 200, body: rpcError(id, METHOD_NOT_FOUND, 'Method not found: ' + method) };
  } catch (error) {
    console.error('[mcp] request failed', method, error);
    return { status: 500, body: rpcError(id, INTERNAL_ERROR, 'Internal error.') };
  }
}

// Parses an HTTP body and handles a single message or (2025-03-26) a batch.
async function handleBody(raw, ctx) {
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return { status: 400, body: rpcError(null, PARSE_ERROR, 'Parse error.') }; }
  if (!Array.isArray(parsed)) return handleMessage(parsed, ctx);
  if (!parsed.length || parsed.length > 20) return { status: 400, body: rpcError(null, INVALID_REQUEST, 'Invalid batch.') };
  const replies = [];
  for (const message of parsed) {
    const out = await handleMessage(message, ctx);
    if (out.body) replies.push(out.body);
  }
  return replies.length ? { status: 200, body: replies } : { status: 202, body: null };
}

module.exports = {
  LEGACY_VERSIONS, MODERN_VERSIONS, SERVER_INFO, TOOLS, ACTIVE,
  handleMessage, handleBody, videoModelSummary, imageModelSummary, imagePriceFromCatalog, rolesFor, jobView,
};
