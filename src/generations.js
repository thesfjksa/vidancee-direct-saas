const customerApiStore = require('./customer_api_store.js');
const { MAX_PROMPT_CHARS } = require('./prompt_limits.js');
const { hideVendors } = require('./vendor_names.js');
const { customerModelId } = require('./dope_brand.js');
const crypto = require('node:crypto');
const { getPool } = require('./db.js');
const { logActivity } = require('./activity_log.js');
const { getPlanProfile } = require('./plans.js');
const { getCost, validateAspectRatio, normalizeResolution, isH3Model } = require('./pricing.js');
const { roundCredits, roundYuanCredits, applyPriceRate, priceRate } = require('./billing.js');
const { configuredStorage, offloadBlob, hydrateBlobs, removeBlobs } = require('./object_storage.js');

function serializeGeneration(row) {
  return {
    id: row.id,
    mode: row.mode,
    model: row.provider === 'wxksai' ? customerModelId(row.model) : row.model,
    duration: Number(row.duration),
    resolution: row.resolution || null,
    aspect_ratio: row.aspect_ratio,
    prompt: row.prompt,
    status: row.status,
    ...(row.provider==='aivid' && row.status==='processing' &&
      require('./aivid_manual.js').activeStage(row) ? { awaiting_delivery:true } : {}),
    credits_cost: Number(row.credits_cost),
    provider_cost: row.provider_cost == null ? null : Number(row.provider_cost),
    error_message: hideVendors(row.error_message),
    created_at: row.created_at,
    submitted_at: row.submitted_at,
    started_at: row.started_at,
    completed_at: row.completed_at,
    refunded_at: row.refunded_at,
    has_video: Boolean(row.output_url),
    has_poster: Boolean(row.poster_url),
    generation_options: (() => {
      try {
        const options = JSON.parse(row.generation_options || '{}');
        return {
          generationMode: options.generationMode || null,
          generateAudio: options.generateAudio === true,
          ...(options.studio === 'cartoon' ? { studio: 'cartoon', cartoon_style: String(options.cartoonStyle || '') } : {}),
          ...(options.studio === 'upscale' ? { studio: 'upscale', source_generation_id: options.sourceGenerationId || null,
            target_resolution: options.targetResolution || null, source_seconds: options.sourceSeconds ?? null } : {}),
          ...(options.studio === 'video-tools' ? { studio: 'video-tools', video_tool: options.videoTool } : {}),
        };
      } catch {
        return {};
      }
    })(),
    video_url: row.output_url ? '/api/generations/' + row.id + '/media?type=video' : null,
    poster_url: row.poster_url ? '/api/generations/' + row.id + '/media?type=poster' : null,
  };
}

function normalizeReuseImageIds(value, maxImages = 6) {
  if (value == null || value === '') return [];
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); }
    catch {
      const error = new Error('Invalid reused reference image selection.');
      error.statusCode = 400;
      throw error;
    }
  }
  if (!Array.isArray(parsed)) {
    const error = new Error('Invalid reused reference image selection.');
    error.statusCode = 400;
    throw error;
  }
  const ids = [...new Set(parsed.map(Number).filter(id => Number.isInteger(id) && id > 0))];
  if (ids.length > maxImages) {
    const error = new Error('A maximum of ' + maxImages + ' reference images is allowed.');
    error.statusCode = 400;
    throw error;
  }
  return ids;
}

function normalizeReferenceOrder(value, maxImages = 6) {
  if (value == null || value === '') return [];
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); }
    catch {
      const error = new Error('Invalid reference image order.');
      error.statusCode = 400;
      throw error;
    }
  }
  if (!Array.isArray(parsed) || parsed.length > maxImages) {
    const error = new Error('Invalid reference image order.');
    error.statusCode = 400;
    throw error;
  }

  return parsed.map(item => {
    if (!item || typeof item !== 'object') {
      const error = new Error('Invalid reference image order.');
      error.statusCode = 400;
      throw error;
    }
    if (item.kind === 'reused') {
      const id = Number(item.id);
      if (!Number.isInteger(id) || id <= 0) {
        const error = new Error('Invalid reused reference image order.');
        error.statusCode = 400;
        throw error;
      }
      return { kind: 'reused', id, role: String(item.role || '').trim() };
    }
    if (item.kind === 'fresh') {
      const index = Number(item.index);
      if (!Number.isInteger(index) || index < 0) {
        const error = new Error('Invalid uploaded reference image order.');
        error.statusCode = 400;
        throw error;
      }
      return { kind: 'fresh', index, role: String(item.role || '').trim() };
    }
    const error = new Error('Invalid reference image order.');
    error.statusCode = 400;
    throw error;
  });
}

function parseRoleList(value, maxItems = 24) {
  if (value == null || value === '') return [];
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); }
    catch {
      const error = new Error('Invalid reference-role selection.');
      error.statusCode = 400;
      throw error;
    }
  }
  if (!Array.isArray(parsed) || parsed.length > maxItems) {
    const error = new Error('Invalid reference-role selection.');
    error.statusCode = 400;
    throw error;
  }
  return parsed.map(role => String(role || '').trim());
}

function normalizeReferenceCapabilities(options = {}) {
  const raw = options.referenceCapabilities && typeof options.referenceCapabilities === 'object'
    ? options.referenceCapabilities
    : {};
  const normalizeKind = kind => {
    const source = raw[kind] && typeof raw[kind] === 'object' ? raw[kind] : {};
    return {
      supported: source.supported === true,
      max: Math.max(0, Number(source.max || 0)),
      min: Math.max(0, Number(source.min || 0)),
      roles: Array.isArray(source.roles) ? source.roles.map(String) : [],
      requiredRoles: Array.isArray(source.requiredRoles) ? source.requiredRoles.map(String) : [],
    };
  };
  return {
    totalMax: Math.max(0, Number(raw.totalMax || 0)),
    image: normalizeKind('image'),
    video: normalizeKind('video'),
    audio: normalizeKind('audio'),
  };
}

function validateAssignedRoles(kind, assignedRoles, capability) {
  const count = assignedRoles.length;
  if (!count) {
    if (capability.min > 0 || capability.requiredRoles.length) {
      const error = new Error('This model requires a ' + kind + ' reference.');
      error.statusCode = 400;
      throw error;
    }
    return;
  }

  if (!capability.supported) {
    const error = new Error('This model does not accept ' + kind + ' references.');
    error.statusCode = 400;
    throw error;
  }
  if (capability.max > 0 && count > capability.max) {
    const error = new Error('This model accepts at most ' + capability.max + ' ' + kind + ' reference' + (capability.max === 1 ? '' : 's') + '.');
    error.statusCode = 400;
    throw error;
  }
  if (capability.min > 0 && count < capability.min) {
    const error = new Error('This model requires at least ' + capability.min + ' ' + kind + ' reference' + (capability.min === 1 ? '' : 's') + '.');
    error.statusCode = 400;
    throw error;
  }

  const allowed = new Set(capability.roles);
  const seenFixed = new Set();
  for (const role of assignedRoles) {
    if (!role || (allowed.size && !allowed.has(role))) {
      const error = new Error('Unsupported ' + kind + ' reference role.');
      error.statusCode = 400;
      throw error;
    }
    if (['start_image','end_image','reference_image','reference_video'].includes(role)) {
      if (seenFixed.has(role)) {
        const error = new Error('Only one ' + role.replace(/_/g,' ') + ' is allowed.');
        error.statusCode = 400;
        throw error;
      }
      seenFixed.add(role);
    }
  }

  for (const required of capability.requiredRoles) {
    if (!assignedRoles.includes(required)) {
      const error = new Error('This model requires a ' + required.replace(/_/g,' ') + '.');
      error.statusCode = 400;
      throw error;
    }
  }
  if (assignedRoles.includes('end_image') && capability.roles.includes('start_image') && !assignedRoles.includes('start_image')) {
    const error = new Error('End image requires a start image for this model.');
    error.statusCode = 400;
    throw error;
  }
}

async function createGenerationForUser(userId, input, options = {}) {
  const offloaded = [];
  const prompt = String(input.prompt || '').trim();
  const model = String(input.model || '');
  const duration = Number(input.duration);
  const requestedResolution = String(input.resolution || '').trim();
  const aspectRatio = String(input.aspectRatio || input.aspect_ratio || '');
  const freshImages = Array.isArray(input.images) ? input.images : [];
  const freshVideos = Array.isArray(input.videos) ? input.videos : [];
  const freshAudios = Array.isArray(input.audios) ? input.audios : [];
  const capabilities = normalizeReferenceCapabilities(options);
  const maxImages = options.dynamicModel
    ? Math.max(capabilities.image.max || 0, freshImages.length, 1)
    : 6;
  const reuseGenerationId = String(input.reuseGenerationId || input.reuse_generation_id || '').trim();
  const reuseImageIds = normalizeReuseImageIds(input.reuseImageIds || input.reuse_image_ids || '', maxImages);
  const referenceOrder = normalizeReferenceOrder(input.referenceOrder || input.reference_order || '', maxImages);
  const videoRoles = parseRoleList(input.videoRoles || input.video_roles || '', 24);
  const audioRoles = parseRoleList(input.audioRoles || input.audio_roles || '', 24);

  if (!options.dynamicModel && freshImages.length + reuseImageIds.length > 6) {
    const error = new Error('A maximum of 6 reference images is allowed in total.');
    error.statusCode = 400;
    throw error;
  }
  // Fixed-price models take sound and video only when the caller passes a
  // validator (MiniMax H3, src/h3_references.js); it sees the files and the image count.
  const staticMedia = !options.dynamicModel && typeof options.validateMedia === 'function';
  if (!options.dynamicModel && freshVideos.length && !staticMedia) {
    const error = new Error('This model does not accept video references.');
    error.statusCode = 400;
    throw error;
  }
  if (options.dynamicModel && videoRoles.length !== freshVideos.length) {
    const error = new Error('Video reference roles do not match the uploaded videos.');
    error.statusCode = 400;
    throw error;
  }
  if (!options.dynamicModel && freshAudios.length && !staticMedia) {
    const error = new Error('This model does not accept sound references.');
    error.statusCode = 400;
    throw error;
  }
  if (staticMedia) options.validateMedia(freshAudios, freshVideos, freshImages.length + reuseImageIds.length);
  if (options.dynamicModel && audioRoles.length !== freshAudios.length) {
    const error = new Error('Sound reference roles do not match the uploaded files.');
    error.statusCode = 400;
    throw error;
  }

  if (reuseImageIds.length && !/^[0-9a-f-]{36}$/i.test(reuseGenerationId)) {
    const error = new Error('The reused generation reference is invalid.');
    error.statusCode = 400;
    throw error;
  }

  if (!prompt) {
    const error = new Error('Prompt is required.');
    error.statusCode = 400;
    throw error;
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    const error = new Error('Prompt is too long.');
    error.statusCode = 400;
    throw error;
  }

  if (options.dynamicModel) {
    if (!aspectRatio || aspectRatio.length > 30) {
      const error = new Error('Unsupported aspect ratio.');
      error.statusCode = 400;
      throw error;
    }
  } else {
    validateAspectRatio(aspectRatio);
  }

  const dynamicCost = Number(options.costOverride);
  const hasDynamicCost = Number.isFinite(dynamicCost) && dynamicCost >= 0;
  const resolution = options.dynamicModel
    ? (requestedResolution || String(options.defaultResolution || '').trim() || null)
    : normalizeResolution(model, requestedResolution);
  let cost = hasDynamicCost
    ? (options.provider==='api888'?roundYuanCredits(dynamicCost):roundCredits(dynamicCost))
    : getCost(model, duration, resolution);
  const provider = String(options.provider || 'vgenv').slice(0, 40);
  const providerCost = Number(options.providerCost);
  const providerCostValue = Number.isFinite(providerCost) && providerCost >= 0 ? providerCost : null;
  const providerCostUnit = providerCostValue == null ? null : String(options.providerCostUnit || 'credits').slice(0, 20);
  const id = crypto.randomUUID();

  const db = getPool();
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [users] = await conn.execute(
      "SELECT id, credits, status, plan_code, price_rate FROM users WHERE id = ? FOR UPDATE",
      [userId],
    );
    const user = users[0];
    if (!user || user.status !== 'active') {
      const error = new Error('User account is unavailable.');
      error.statusCode = 403;
      throw error;
    }
    const apiReplay = await customerApiStore.beginRequest(conn, userId, options.apiRequest);
    if (apiReplay) {
      await conn.commit();
      return serializeGeneration(apiReplay);
    }
    cost = applyPriceRate(cost, priceRate(user));
    if(options.maxCustomerCredits!=null){
      const ceiling=Number(options.maxCustomerCredits);
      if(!Number.isFinite(ceiling)||ceiling<=0)throw Object.assign(new Error('Invalid customer price limit.'),{statusCode:400});
      if(cost>ceiling)throw Object.assign(new Error('The price changed. Refresh the price and review it before generating.'),{statusCode:409});
    }

    if (Number(user.credits) < cost) {
      const error = new Error('Not enough credits.');
      error.statusCode = 402;
      throw error;
    }

    const planProfile = getPlanProfile(user.plan_code);
    const aividQueue=provider==='aivid';
    const queueLimit=aividQueue?20:planProfile.concurrency;
    const [[activeRow]] = await conn.execute(
      "SELECT COUNT(*) AS total FROM generations WHERE user_id=? AND status IN ('queued','submitting','submitted','processing')"+(aividQueue?" AND provider='aivid'":''),
      [userId],
    );
    if (Number(activeRow?.total || 0) >= queueLimit) {
      const error = new Error(
        aividQueue?'Your Premium queue is full (20 pending videos). Wait for one to finish.':planProfile.code
          ? planProfile.name + ' allows up to ' + planProfile.concurrency + ' simultaneous generations.'
          : 'Choose a plan to run more than one generation at a time.'
      );
      error.statusCode = 429;
      throw error;
    }

    let reusedImages = [];
    if (reuseImageIds.length) {
      const [sourceRows] = await conn.execute(
        'SELECT id FROM generations WHERE id = ? AND user_id = ? LIMIT 1',
        [reuseGenerationId, userId],
      );
      if (!sourceRows[0]) {
        const error = new Error('The source generation for these reference images was not found.');
        error.statusCode = 404;
        throw error;
      }

      const placeholders = reuseImageIds.map(() => '?').join(',');
      const [imageRows] = await conn.query(
        `SELECT id, filename, mime_type, image_data
         FROM generation_images
         WHERE generation_id = ? AND id IN (${placeholders})`,
        [reuseGenerationId, ...reuseImageIds],
      );
      // Reused files are copied, so deleting either generation is independent.
      await hydrateBlobs(imageRows, 'image_data');

      const byId = new Map(imageRows.map(row => [Number(row.id), row]));
      reusedImages = reuseImageIds.map(imageId => byId.get(imageId)).filter(Boolean);

      if (reusedImages.length !== reuseImageIds.length) {
        const error = new Error('One or more reused reference images are no longer available.');
        error.statusCode = 409;
        throw error;
      }
    }

    if (isH3Model(model)) {
      const oversizedReused = reusedImages.find(image => Buffer.isBuffer(image.image_data) && image.image_data.length > 5 * 1024 * 1024);
      const oversizedFresh = freshImages.find(image => Buffer.isBuffer(image.data) && image.data.length > 5 * 1024 * 1024);
      if (oversizedReused || oversizedFresh) {
        const error = new Error('MiniMax H3 reference images must be 5 MB or smaller.');
        error.statusCode = 400;
        throw error;
      }
    }

    let orderedImages = [
      ...reusedImages.map(image => ({ kind: 'reused', image })),
      ...freshImages.map(image => ({ kind: 'fresh', image })),
    ];

    if (referenceOrder.length) {
      if (referenceOrder.length !== reusedImages.length + freshImages.length) {
        const error = new Error('Reference image order does not match the selected images.');
        error.statusCode = 400;
        throw error;
      }

      const reusedById = new Map(reusedImages.map(image => [Number(image.id), image]));
      const seenReused = new Set();
      const seenFresh = new Set();

      orderedImages = referenceOrder.map(item => {
        if (item.kind === 'reused') {
          const image = reusedById.get(item.id);
          if (!image || seenReused.has(item.id)) {
            const error = new Error('Invalid reused reference image order.');
            error.statusCode = 400;
            throw error;
          }
          seenReused.add(item.id);
          return { kind: 'reused', image, role: item.role };
        }

        const image = freshImages[item.index];
        if (!image || seenFresh.has(item.index)) {
          const error = new Error('Invalid uploaded reference image order.');
          error.statusCode = 400;
          throw error;
        }
        seenFresh.add(item.index);
        return { kind: 'fresh', image, role: item.role };
      });

      if (seenReused.size !== reusedImages.length || seenFresh.size !== freshImages.length) {
        const error = new Error('Reference image order is incomplete.');
        error.statusCode = 400;
        throw error;
      }
    }

    if (options.dynamicModel && orderedImages.length && !referenceOrder.length) {
      const fallbackRole = capabilities.image.roles[0] || '';
      orderedImages = orderedImages.map(entry => ({...entry, role:fallbackRole}));
    }

    if (options.dynamicModel) {
      const imageRoles = orderedImages.map(entry => String(entry.role || ''));
      validateAssignedRoles('image', imageRoles, capabilities.image);
      validateAssignedRoles('video', videoRoles, capabilities.video);
      validateAssignedRoles('audio', audioRoles, capabilities.audio);
      const totalRefs = orderedImages.length + freshVideos.length + freshAudios.length;
      if (capabilities.totalMax > 0 && totalRefs > capabilities.totalMax) {
        const error = new Error('This model accepts at most ' + capabilities.totalMax + ' total reference files.');
        error.statusCode = 400;
        throw error;
      }
    }

    if(typeof options.validatePreparedReferences==='function'){
      options.validatePreparedReferences({images:orderedImages.map(entry=>({kind:'image',mimeType:entry.kind==='reused'?entry.image.mime_type:entry.image.mimeType,data:entry.kind==='reused'?entry.image.image_data:entry.image.data})),videos:freshVideos,audios:freshAudios});
    }
    const allImageCount = orderedImages.length;
    const hasReferences = allImageCount > 0 || freshVideos.length > 0 || freshAudios.length > 0;
    const mode = hasReferences
      ? (options.dynamicModel ? 'reference-to-video' : 'image-to-video')
      : 'text-to-video';

    // Manual jobs have no source ID and enter processing directly. Even an
    // older automatic worker will neither claim nor collect them.
    const manualHandoff = provider === 'aivid' && options.aividManualHandoff === true;
    await conn.execute(
      `INSERT INTO generations
       (id, user_id, provider, queue_priority, mode, model, duration, resolution, aspect_ratio, prompt, status, credits_cost, provider_cost, provider_cost_unit, generation_options, provider_operation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${manualHandoff ? "'processing'" : "'queued'"}, ?, ?, ?, ?, ?)`,
      [
        id, userId, provider, planProfile.queuePriority, mode, model, duration,
        resolution, aspectRatio, prompt, cost, providerCostValue, providerCostUnit,
        options.generationOptions?JSON.stringify(options.generationOptions):null,
        manualHandoff ? JSON.stringify({stage:'manual_pending'}) : null,
      ],
    );

    // Uploaded files go to cloud storage when enabled; the BLOB keeps a tag.
    let storePromise = null;
    const keep = async (prefix, data, mimeType) => {
      storePromise ??= configuredStorage();
      const value = await offloadBlob(prefix, data, mimeType, { store: await storePromise });
      if (value !== data) offloaded.push(value);
      return value;
    };
    let position = 0;
    for (const entry of orderedImages) {
      const image = entry.image;
      const mimeType = entry.kind === 'reused' ? image.mime_type : image.mimeType;
      const imageData = entry.kind === 'reused' ? image.image_data : image.data;
      await conn.execute(
        `INSERT INTO generation_images
         (generation_id, position_index, filename, mime_type, image_data)
         VALUES (?, ?, ?, ?, ?)`,
        [id, position, image.filename, mimeType, await keep('refs/' + id, imageData, mimeType)],
      );
      position += 1;
    }

    if (options.dynamicModel) {
      let mediaPosition = 0;
      for (const entry of orderedImages) {
        const image = entry.image;
        const mimeType = entry.kind === 'reused' ? image.mime_type : image.mimeType;
        const imageData = entry.kind === 'reused' ? image.image_data : image.data;
        await conn.execute(
          `INSERT INTO generation_media
           (generation_id,position_index,media_kind,media_role,filename,mime_type,media_data)
           VALUES (?,?,?,?,?,?,?)`,
          [id, mediaPosition, 'image', String(entry.role || ''), image.filename, mimeType, await keep('media/' + id, imageData, mimeType)],
        );
        mediaPosition += 1;
      }
      for (let i = 0; i < freshVideos.length; i += 1) {
        const video = freshVideos[i];
        await conn.execute(
          `INSERT INTO generation_media
           (generation_id,position_index,media_kind,media_role,filename,mime_type,media_data)
           VALUES (?,?,?,?,?,?,?)`,
          [id, mediaPosition, 'video', String(videoRoles[i] || ''), video.filename, video.mimeType, await keep('media/' + id, video.data, video.mimeType)],
        );
        mediaPosition += 1;
      }
      for (let i = 0; i < freshAudios.length; i += 1) {
        const audio = freshAudios[i];
        await conn.execute(
          `INSERT INTO generation_media
           (generation_id,position_index,media_kind,media_role,filename,mime_type,media_data)
           VALUES (?,?,?,?,?,?,?)`,
          [id, mediaPosition, 'audio', String(audioRoles[i] || ''), audio.filename, audio.mimeType, await keep('media/' + id, audio.data, audio.mimeType)],
        );
        mediaPosition += 1;
      }
    }

    // Fixed-price sound clips and videos go after the image positions, so
    // their signed provider links never share a position with a reference image.
    if (staticMedia) {
      const extra = [...freshAudios.map(f => ['audio', 'audio_references', f]), ...freshVideos.map(f => ['video', 'video_references', f])];
      for (let i = 0; i < extra.length; i += 1) {
        const [kind, role, file] = extra[i];
        await conn.execute(
          `INSERT INTO generation_media
           (generation_id,position_index,media_kind,media_role,filename,mime_type,media_data)
           VALUES (?,?,?,?,?,?,?)`,
          [id, orderedImages.length + i, kind, role, file.filename, file.mimeType, await keep('media/' + id, file.data, file.mimeType)],
        );
      }
    }

    await conn.execute('UPDATE users SET credits = credits - ? WHERE id = ?', [cost, userId]);
    await conn.execute(
      `INSERT INTO credit_transactions (user_id, generation_id, amount, type, note)
       VALUES (?, ?, ?, 'generation_debit', ?)`,
      [userId, id, -cost, 'Reserved for video generation'],
    );

    await customerApiStore.completeRequest(conn, userId, options.apiRequest, id);
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    await removeBlobs(offloaded).catch(() => {});
    throw error;
  } finally {
    conn.release();
  }

  logActivity({ category: 'generation', event: 'video.created', userId, generationId: id, provider,
    message: model + ' · ' + duration + 's · ' + (resolution || 'default') + ' · ' + aspectRatio + ' · ' + cost + ' credits',
    details: { prompt: String(input.prompt || '').slice(0, 500), options: options.generationOptions || null } });
  const [rows] = await db.execute('SELECT * FROM generations WHERE id = ?', [id]);
  return serializeGeneration(rows[0]);
}

async function listUserGenerations(userId, limit = 50) {
  const db = getPool();
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 50));
  const [rows] = await db.query(
    "SELECT * FROM generations WHERE user_id = ? AND media_type='video' ORDER BY created_at DESC LIMIT " + safeLimit,
    [userId],
  );
  return rows.map(serializeGeneration);
}

async function getUserGeneration(userId, id) {
  const db = getPool();
  const [rows] = await db.execute(
    "SELECT * FROM generations WHERE id = ? AND user_id = ? AND media_type='video' LIMIT 1",
    [id, userId],
  );
  return rows[0] || null;
}

async function listUserGenerationReferenceImages(userId, generationId) {
  const db = getPool();
  const [rows] = await db.execute(
    `SELECT gi.id, gi.position_index, gi.filename, gi.mime_type, LENGTH(gi.image_data) AS byte_length
     FROM generation_images gi
     JOIN generations g ON g.id = gi.generation_id
     WHERE gi.generation_id = ? AND g.user_id = ?
     ORDER BY gi.position_index ASC, gi.id ASC`,
    [generationId, userId],
  );

  return rows.map(row => ({
    id: Number(row.id),
    position: Number(row.position_index),
    filename: row.filename,
    mime_type: row.mime_type,
    byte_length: Number(row.byte_length || 0),
    url: '/api/generations/' + generationId + '/reference-images/' + row.id,
  }));
}

async function getUserGenerationReferenceImage(userId, generationId, imageId) {
  const db = getPool();
  const [rows] = await db.execute(
    `SELECT gi.id, gi.filename, gi.mime_type, gi.image_data
     FROM generation_images gi
     JOIN generations g ON g.id = gi.generation_id
     WHERE gi.generation_id = ? AND gi.id = ? AND g.user_id = ?
     LIMIT 1`,
    [generationId, imageId, userId],
  );
  await hydrateBlobs(rows, 'image_data');
  return rows[0] || null;
}

async function deleteUserGeneration(userId, generationId, { verify } = {}) {
  const db = getPool();
  const conn = await db.getConnection();
  let deletedDriveId=null,deletedObjectKey=null,offloadedTags=[];

  try {
    await conn.beginTransaction();

    const [rows] = await conn.execute(
      "SELECT id, user_id, status, output_url, refunded_at, generation_options FROM generations WHERE id = ? AND user_id = ? AND media_type='video' FOR UPDATE",
      [generationId, userId],
    );
    const row = rows[0];

    if (!row) {
      const error = new Error('Generation not found.');
      error.statusCode = 404;
      throw error;
    }

    const terminalStatuses = new Set(['completed', 'failed', 'submit_error']);
    if (!terminalStatuses.has(String(row.status))) {
      const error = new Error('This generation is still in progress and cannot be deleted yet.');
      error.statusCode = 409;
      throw error;
    }
    if (row.status === 'submit_error' && !row.refunded_at &&
        serializeGeneration(row).generation_options.studio === 'video-tools') {
      throw Object.assign(new Error('This unconfirmed video submission needs review before it can be deleted.'), { statusCode: 409 });
    }

    if (verify) await verify(conn, generationId);

    // Do the child cleanup explicitly instead of relying only on FK actions.
    // Older deployments may have been created before ON DELETE CASCADE / SET NULL
    // was added, because CREATE TABLE IF NOT EXISTS does not rewrite existing FKs.
    await conn.execute(
      'UPDATE credit_transactions SET generation_id = NULL WHERE generation_id = ? AND user_id = ?',
      [generationId, userId],
    );
    // Cloud-stored reference files are removed after the commit below.
    const [tagRows] = await conn.execute(
      `SELECT image_data AS data FROM generation_images WHERE generation_id = ? AND LENGTH(image_data) < 512
       UNION ALL SELECT media_data FROM generation_media WHERE generation_id = ? AND LENGTH(media_data) < 512`,
      [generationId, generationId],
    );
    offloadedTags = tagRows.map(r => r.data);
    await conn.execute(
      'DELETE FROM generation_images WHERE generation_id = ?',
      [generationId],
    );
    await conn.execute(
      'DELETE FROM generation_media WHERE generation_id = ?',
      [generationId],
    );
    // Old databases can lack ON DELETE CASCADE; remove the large media
    // children explicitly before deleting the parent generation.
    await conn.execute('DELETE FROM generation_video_chunks WHERE generation_id=?',[generationId]);
    await conn.execute('DELETE FROM generation_video_outputs WHERE generation_id=?',[generationId]);
    await conn.execute('DELETE FROM generation_image_thumbnails WHERE generation_id=?',[generationId]);
    await conn.execute('DELETE FROM generation_image_outputs WHERE generation_id=?',[generationId]);

    const [deleted] = await conn.execute(
      'DELETE FROM generations WHERE id = ? AND user_id = ?',
      [generationId, userId],
    );

    if (!deleted.affectedRows) {
      const error = new Error('Generation could not be deleted.');
      error.statusCode = 409;
      throw error;
    }

    await conn.commit();
    deletedDriveId=String(row.output_url||'').startsWith('gdrive:')?String(row.output_url).slice(7):null;
    deletedObjectKey=String(row.output_url||'').startsWith('r2:')?String(row.output_url).slice(3):null;
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
  await removeBlobs(offloadedTags).catch(()=>{});
  if(deletedObjectKey){
    try{
      const {configuredStorage}=require('./object_storage.js');
      await (await configuredStorage({requireEnabled:false})).remove(deletedObjectKey);
    }catch(error){
      logActivity({level:'warn',category:'system',event:'r2.delete_failed',
        userId,generationId,message:'Customer deleted video; cloud storage cleanup failed.',
        details:{storageStatus:error.storageStatus||null}});
    }
  }
  if(deletedDriveId){
    try{
      const {configuredDrive}=require('./google_drive.js');
      const drive=await configuredDrive({requireEnabled:false});
      await drive.deleteFile(deletedDriveId);
    }catch(error){
      // The DB deletion has committed; do not falsely tell the customer it
      // failed. Record the orphaned Drive object for administrative cleanup.
      logActivity({level:'warn',category:'system',event:'gdrive.delete_failed',
        userId,generationId,message:'Customer deleted video; Google Drive cleanup failed.',
        details:{code:error.code||null,driveStatus:error.driveStatus||null}});
    }
  }
  return true;
}

async function refundGeneration(generationId, status, message, providerCost = null) {
  const db = getPool();
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute(
      'SELECT * FROM generations WHERE id = ? FOR UPDATE',
      [generationId],
    );
    const row = rows[0];
    if (!row) {
      await conn.rollback();
      return false;
    }

    await conn.execute(
      `UPDATE generations
       SET status = ?, error_message = ?, provider_cost = COALESCE(?, provider_cost),
           completed_at = COALESCE(completed_at, UTC_TIMESTAMP()), updated_at = UTC_TIMESTAMP()
       WHERE id = ?`,
      // Stored without provider names: every page that shows it is then safe.
      [status, hideVendors(message) || null, providerCost, generationId],
    );

    if (!row.refunded_at) {
      const amount = Number(row.credits_cost);
      await conn.execute('UPDATE users SET credits = credits + ? WHERE id = ?', [amount, row.user_id]);
      await conn.execute(
        `INSERT INTO credit_transactions (user_id, generation_id, amount, type, note)
         VALUES (?, ?, ?, 'generation_refund', ?)`,
        [row.user_id, row.id, amount, hideVendors(message) || 'Generation refunded'],
      );
      await conn.execute(
        'UPDATE generations SET refunded_at = UTC_TIMESTAMP() WHERE id = ?',
        [generationId],
      );
    }

    await conn.commit();
    logActivity({ level: 'warn', category: 'refund', event: row.refunded_at ? 'job.failed' : 'job.refunded', userId: row.user_id, generationId,
      provider: row.provider, message: (row.refunded_at ? '' : Number(row.credits_cost) + ' credits refunded · ') + (message || status),
      details: { status, model: row.model, mediaType: row.media_type, providerJobId: row.provider_job_id } });
    return true;
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

module.exports = {
  serializeGeneration,
  createGenerationForUser,
  listUserGenerations,
  getUserGeneration,
  listUserGenerationReferenceImages,
  getUserGenerationReferenceImage,
  deleteUserGeneration,
  refundGeneration,
};

