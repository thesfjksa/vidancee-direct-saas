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

async function createGenerationForUser(userId, input) {
  const prompt = String(input.prompt || '').trim();
  const model = String(input.model || '');
  const duration = Number(input.duration);
  const aspectRatio = String(input.aspectRatio || input.aspect_ratio || '');
  const images = Array.isArray(input.images) ? input.images : [];
  const mode = images.length > 0 ? 'image-to-video' : 'text-to-video';
  if (mode === 'image-to-video' && (images.length < 1 || images.length > 6)) {
    const error = new Error('Image-to-video requires between 1 and 6 reference images.');
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

    await conn.execute(
      `INSERT INTO generations
       (id, user_id, provider, mode, model, duration, aspect_ratio, prompt, status, credits_cost)
       VALUES (?, ?, 'vidancee', ?, ?, ?, ?, ?, 'queued', ?)`,
      [id, userId, mode, model, duration, aspectRatio, prompt, cost],
    );

    if (mode === 'image-to-video') {
      for (let i = 0; i < images.length; i += 1) {
        const image = images[i];
        await conn.execute(
          `INSERT INTO generation_images
           (generation_id, position_index, filename, mime_type, image_data)
           VALUES (?, ?, ?, ?, ?)`,
          [id, i, image.filename, image.mimeType, image.data],
        );
      }
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
  refundGeneration,
};
