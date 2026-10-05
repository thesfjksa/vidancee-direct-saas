const crypto = require('node:crypto');
const { getPool } = require('./db.js');
const { getPlanProfile } = require('./plans.js');
const { getImageCost, validateImageAspectRatio } = require('./image_pricing.js');

function serializeImageGeneration(row) {
  return {
    id: row.id,
    media_type: 'image',
    mode: row.mode,
    model: row.model,
    aspect_ratio: row.aspect_ratio,
    prompt: row.prompt,
    status: row.status,
    credits_cost: Number(row.credits_cost),
    error_message: row.error_message,
    created_at: row.created_at,
    submitted_at: row.submitted_at,
    started_at: row.started_at,
    completed_at: row.completed_at,
    refunded_at: row.refunded_at,
    has_image: Boolean(row.output_url),
    image_url: row.output_url ? '/api/image-generations/' + row.id + '/media' : null,
  };
}

async function createImageGenerationForUser(userId, input) {
  const prompt = String(input.prompt || '').trim();
  const model = String(input.model || '');
  const aspectRatio = String(input.aspectRatio || input.aspect_ratio || '');
  const images = Array.isArray(input.images) ? input.images : [];

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
  if (images.length > 6) {
    const error = new Error('A maximum of 6 reference images is allowed.');
    error.statusCode = 400;
    throw error;
  }

  validateImageAspectRatio(aspectRatio);
  const cost = getImageCost(model);
  const id = crypto.randomUUID();
  const mode = images.length ? 'reference-to-image' : 'text-to-image';

  const db = getPool();
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [users] = await conn.execute(
      'SELECT id, credits, status, plan_code FROM users WHERE id=? FOR UPDATE',
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

    const planProfile = getPlanProfile(user.plan_code);
    const [[activeRow]] = await conn.execute(
      "SELECT COUNT(*) AS total FROM generations WHERE user_id=? AND status IN ('queued','submitting','submitted','processing')",
      [userId],
    );
    if (Number(activeRow?.total || 0) >= planProfile.concurrency) {
      const error = new Error(
        planProfile.code
          ? planProfile.name + ' allows up to ' + planProfile.concurrency + ' simultaneous generations.'
          : 'Choose a plan to run more than one generation at a time.'
      );
      error.statusCode = 429;
      throw error;
    }

    await conn.execute(
      `INSERT INTO generations
       (id,user_id,provider,media_type,queue_priority,mode,model,duration,aspect_ratio,prompt,status,credits_cost)
       VALUES (?,?,'atlascloud','image',?,?,?,0,?,?,'queued',?)`,
      [id, userId, planProfile.queuePriority, mode, model, aspectRatio, prompt, cost],
    );

    for (let i = 0; i < images.length; i += 1) {
      const image = images[i];
      await conn.execute(
        `INSERT INTO generation_images
         (generation_id,position_index,filename,mime_type,image_data)
         VALUES (?,?,?,?,?)`,
        [id, i, image.filename, image.mimeType, image.data],
      );
    }

    await conn.execute('UPDATE users SET credits=credits-? WHERE id=?', [cost, userId]);
    await conn.execute(
      `INSERT INTO credit_transactions (user_id,generation_id,amount,type,note)
       VALUES (?, ?, ?, 'generation_debit', ?)`,
      [userId, id, -cost, 'Reserved for image generation'],
    );

    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }

  const [rows] = await db.execute('SELECT * FROM generations WHERE id=?', [id]);
  return serializeImageGeneration(rows[0]);
}

async function listUserImageGenerations(userId, limit = 60) {
  const db = getPool();
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 60));
  const [rows] = await db.query(
    "SELECT * FROM generations WHERE user_id=? AND media_type='image' ORDER BY created_at DESC LIMIT " + safeLimit,
    [userId],
  );
  return rows.map(serializeImageGeneration);
}

async function getUserImageGeneration(userId, id) {
  const db = getPool();
  const [rows] = await db.execute(
    "SELECT * FROM generations WHERE id=? AND user_id=? AND media_type='image' LIMIT 1",
    [id, userId],
  );
  return rows[0] || null;
}

async function deleteUserImageGeneration(userId, generationId) {
  const db = getPool();
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute(
      "SELECT id,status FROM generations WHERE id=? AND user_id=? AND media_type='image' FOR UPDATE",
      [generationId, userId],
    );
    const row = rows[0];
    if (!row) {
      const error = new Error('Image generation not found.');
      error.statusCode = 404;
      throw error;
    }
    if (!['completed','failed','submit_error'].includes(String(row.status))) {
      const error = new Error('This image generation is still in progress and cannot be deleted yet.');
      error.statusCode = 409;
      throw error;
    }

    await conn.execute(
      'UPDATE credit_transactions SET generation_id=NULL WHERE generation_id=? AND user_id=?',
      [generationId, userId],
    );
    await conn.execute('DELETE FROM generation_images WHERE generation_id=?', [generationId]);
    await conn.execute(
      "DELETE FROM generations WHERE id=? AND user_id=? AND media_type='image'",
      [generationId, userId],
    );
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
  serializeImageGeneration,
  createImageGenerationForUser,
  listUserImageGenerations,
  getUserImageGeneration,
  deleteUserImageGeneration,
};
