const crypto = require('node:crypto');
const { getPool } = require('./db.js');
const { getCost, validateAspectRatio } = require('./pricing.js');

function serializeGeneration(row) {
  return {
    id: row.id,
    mode: row.mode,
    model: row.model,
    duration: Number(row.duration),
    aspect_ratio: row.aspect_ratio,
    prompt: row.prompt,
    status: row.status,
    credits_cost: Number(row.credits_cost),
    provider_cost: row.provider_cost == null ? null : Number(row.provider_cost),
    error_message: row.error_message,
    created_at: row.created_at,
    submitted_at: row.submitted_at,
    started_at: row.started_at,
    completed_at: row.completed_at,
    refunded_at: row.refunded_at,
    has_video: Boolean(row.output_url),
    has_poster: Boolean(row.poster_url),
    video_url: row.output_url ? '/api/generations/' + row.id + '/media?type=video' : null,
    poster_url: row.poster_url ? '/api/generations/' + row.id + '/media?type=poster' : null,
  };
}

function normalizeReuseImageIds(value) {
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
  if (ids.length > 6) {
    const error = new Error('A maximum of 6 reference images is allowed.');
    error.statusCode = 400;
    throw error;
  }
  return ids;
}

function normalizeReferenceOrder(value) {
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
  if (!Array.isArray(parsed) || parsed.length > 6) {
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
      return { kind: 'reused', id };
    }
    if (item.kind === 'fresh') {
      const index = Number(item.index);
      if (!Number.isInteger(index) || index < 0) {
        const error = new Error('Invalid uploaded reference image order.');
        error.statusCode = 400;
        throw error;
      }
      return { kind: 'fresh', index };
    }
    const error = new Error('Invalid reference image order.');
    error.statusCode = 400;
    throw error;
  });
}

async function createGenerationForUser(userId, input) {
  const prompt = String(input.prompt || '').trim();
  const model = String(input.model || '');
  const duration = Number(input.duration);
  const aspectRatio = String(input.aspectRatio || input.aspect_ratio || '');
  const freshImages = Array.isArray(input.images) ? input.images : [];
  const reuseGenerationId = String(input.reuseGenerationId || input.reuse_generation_id || '').trim();
  const reuseImageIds = normalizeReuseImageIds(input.reuseImageIds || input.reuse_image_ids || '');
  const referenceOrder = normalizeReferenceOrder(input.referenceOrder || input.reference_order || '');

  if (freshImages.length + reuseImageIds.length > 6) {
    const error = new Error('A maximum of 6 reference images is allowed in total.');
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
  if (prompt.length > 50000) {
    const error = new Error('Prompt is too long.');
    error.statusCode = 400;
    throw error;
  }

  validateAspectRatio(aspectRatio);
  const cost = getCost(model, duration);
  const id = crypto.randomUUID();

  const db = getPool();
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [users] = await conn.execute(
      "SELECT id, credits, status FROM users WHERE id = ? FOR UPDATE",
      [userId],
    );
    const user = users[0];
    if (!user || user.status !== 'active') {
      const error = new Error('User account is unavailable.');
      error.statusCode = 403;
      throw error;
    }
    if (Number(user.credits) < cost) {
      const error = new Error('Not enough credits.');
      error.statusCode = 402;
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

      const byId = new Map(imageRows.map(row => [Number(row.id), row]));
      reusedImages = reuseImageIds.map(imageId => byId.get(imageId)).filter(Boolean);

      if (reusedImages.length !== reuseImageIds.length) {
        const error = new Error('One or more reused reference images are no longer available.');
        error.statusCode = 409;
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
          return { kind: 'reused', image };
        }

        const image = freshImages[item.index];
        if (!image || seenFresh.has(item.index)) {
          const error = new Error('Invalid uploaded reference image order.');
          error.statusCode = 400;
          throw error;
        }
        seenFresh.add(item.index);
        return { kind: 'fresh', image };
      });

      if (seenReused.size !== reusedImages.length || seenFresh.size !== freshImages.length) {
        const error = new Error('Reference image order is incomplete.');
        error.statusCode = 400;
        throw error;
      }
    }

    const allImageCount = orderedImages.length;
    const mode = allImageCount > 0 ? 'image-to-video' : 'text-to-video';

    await conn.execute(
      `INSERT INTO generations
       (id, user_id, provider, mode, model, duration, aspect_ratio, prompt, status, credits_cost)
       VALUES (?, ?, 'vidancee', ?, ?, ?, ?, ?, 'queued', ?)`,
      [id, userId, mode, model, duration, aspectRatio, prompt, cost],
    );

    let position = 0;
    for (const entry of orderedImages) {
      const image = entry.image;
      const mimeType = entry.kind === 'reused' ? image.mime_type : image.mimeType;
      const imageData = entry.kind === 'reused' ? image.image_data : image.data;
      await conn.execute(
        `INSERT INTO generation_images
         (generation_id, position_index, filename, mime_type, image_data)
         VALUES (?, ?, ?, ?, ?)`,
        [id, position, image.filename, mimeType, imageData],
      );
      position += 1;
    }

    await conn.execute('UPDATE users SET credits = credits - ? WHERE id = ?', [cost, userId]);
    await conn.execute(
      `INSERT INTO credit_transactions (user_id, generation_id, amount, type, note)
       VALUES (?, ?, ?, 'generation_debit', ?)`,
      [userId, id, -cost, 'Reserved for video generation'],
    );

    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }

  const [rows] = await db.execute('SELECT * FROM generations WHERE id = ?', [id]);
  return serializeGeneration(rows[0]);
}

async function listUserGenerations(userId, limit = 50) {
  const db = getPool();
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 50));
  const [rows] = await db.query(
    'SELECT * FROM generations WHERE user_id = ? ORDER BY created_at DESC LIMIT ' + safeLimit,
    [userId],
  );
  return rows.map(serializeGeneration);
}

async function getUserGeneration(userId, id) {
  const db = getPool();
  const [rows] = await db.execute(
    'SELECT * FROM generations WHERE id = ? AND user_id = ? LIMIT 1',
    [id, userId],
  );
  return rows[0] || null;
}

async function listUserGenerationReferenceImages(userId, generationId) {
  const db = getPool();
  const [rows] = await db.execute(
    `SELECT gi.id, gi.position_index, gi.filename, gi.mime_type
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
  return rows[0] || null;
}

async function deleteUserGeneration(userId, generationId) {
  const db = getPool();
  const conn = await db.getConnection();

  try {
    await conn.beginTransaction();

    const [rows] = await conn.execute(
      'SELECT id, user_id, status FROM generations WHERE id = ? AND user_id = ? FOR UPDATE',
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

    // Do the child cleanup explicitly instead of relying only on FK actions.
    // Older deployments may have been created before ON DELETE CASCADE / SET NULL
    // was added, because CREATE TABLE IF NOT EXISTS does not rewrite existing FKs.
    await conn.execute(
      'UPDATE credit_transactions SET generation_id = NULL WHERE generation_id = ? AND user_id = ?',
      [generationId, userId],
    );
    await conn.execute(
      'DELETE FROM generation_images WHERE generation_id = ?',
      [generationId],
    );

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
    return true;
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
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
      [status, message || null, providerCost, generationId],
    );

    if (!row.refunded_at) {
      const amount = Number(row.credits_cost);
      await conn.execute('UPDATE users SET credits = credits + ? WHERE id = ?', [amount, row.user_id]);
      await conn.execute(
        `INSERT INTO credit_transactions (user_id, generation_id, amount, type, note)
         VALUES (?, ?, ?, 'generation_refund', ?)`,
        [row.user_id, row.id, amount, message || 'Generation refunded'],
      );
      await conn.execute(
        'UPDATE generations SET refunded_at = UTC_TIMESTAMP() WHERE id = ?',
        [generationId],
      );
    }

    await conn.commit();
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
