const mysql = require('mysql2/promise');

let pool = null;
let initialized = false;

function dbConfigured() {
  return Boolean(
    String(process.env.DB_HOST || '').trim() &&
    String(process.env.DB_USER || '').trim() &&
    String(process.env.DB_NAME || '').trim()
  );
}

function getPool() {
  if (!dbConfigured()) {
    throw new Error('MySQL is not configured. Set DB_HOST, DB_PORT, DB_USER, DB_PASSWORD and DB_NAME in hPanel.');
  }

  if (!pool) {
    pool = mysql.createPool({
      host: String(process.env.DB_HOST).trim(),
      port: Number(process.env.DB_PORT || 3306),
      user: String(process.env.DB_USER).trim(),
      password: String(process.env.DB_PASSWORD || ''),
      database: String(process.env.DB_NAME).trim(),
      waitForConnections: true,
      connectionLimit: Number(process.env.DB_POOL_SIZE || 10),
      queueLimit: 0,
      charset: 'utf8mb4',
      timezone: 'Z',
      supportBigNumbers: true,
      bigNumberStrings: false,
      connectTimeout: Number(process.env.DB_CONNECT_TIMEOUT_MS || 8000),
      enableKeepAlive: true,
      keepAliveInitialDelay: 0,
    });
  }

  return pool;
}

async function initDb() {
  if (!dbConfigured()) return false;
  if (initialized) return true;

  const db = getPool();

  const statements = [
    `CREATE TABLE IF NOT EXISTS users (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      email VARCHAR(190) NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      credits DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      plan_code VARCHAR(20) NULL,
      role VARCHAR(20) NOT NULL DEFAULT 'user',
      status VARCHAR(20) NOT NULL DEFAULT 'active',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_users_email (email)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS sessions (
      token_hash CHAR(64) NOT NULL,
      user_id BIGINT UNSIGNED NOT NULL,
      expires_at DATETIME NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (token_hash),
      KEY idx_sessions_user (user_id),
      KEY idx_sessions_expiry (expires_at),
      CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS generations (
      id CHAR(36) NOT NULL,
      user_id BIGINT UNSIGNED NOT NULL,
      provider VARCHAR(40) NOT NULL DEFAULT 'vidancee',
      media_type VARCHAR(20) NOT NULL DEFAULT 'video',
      provider_job_id VARCHAR(191) NULL,
      queue_priority INT NOT NULL DEFAULT 0,
      mode VARCHAR(40) NOT NULL DEFAULT 'text-to-video',
      model VARCHAR(80) NOT NULL,
      duration INT NOT NULL,
      resolution VARCHAR(20) NULL,
      image_quality VARCHAR(10) NULL,
      aspect_ratio VARCHAR(20) NOT NULL,
      prompt TEXT NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'queued',
      credits_cost DECIMAL(12,2) NOT NULL,
      provider_cost DECIMAL(12,4) NULL,
      provider_cost_unit VARCHAR(20) NULL,
      output_url TEXT NULL,
      poster_url TEXT NULL,
      error_message TEXT NULL,
      submitted_at DATETIME NULL,
      started_at DATETIME NULL,
      completed_at DATETIME NULL,
      refunded_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_generations_user_created (user_id, created_at),
      KEY idx_generations_status_created (status, created_at),
      KEY idx_generations_provider_job (provider_job_id),
      CONSTRAINT fk_generations_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS generation_image_outputs (
      generation_id CHAR(36) NOT NULL,
      mime_type VARCHAR(100) NOT NULL,
      image_data LONGBLOB NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (generation_id),
      CONSTRAINT fk_image_outputs_generation FOREIGN KEY (generation_id) REFERENCES generations(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS generation_images (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      generation_id CHAR(36) NOT NULL,
      position_index TINYINT UNSIGNED NOT NULL DEFAULT 0,
      filename VARCHAR(255) NOT NULL,
      mime_type VARCHAR(100) NOT NULL,
      image_data LONGBLOB NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_generation_images_generation (generation_id, position_index),
      CONSTRAINT fk_generation_images_generation FOREIGN KEY (generation_id) REFERENCES generations(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS generation_media (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      generation_id CHAR(36) NOT NULL,
      position_index SMALLINT UNSIGNED NOT NULL DEFAULT 0,
      media_kind VARCHAR(20) NOT NULL,
      media_role VARCHAR(50) NOT NULL,
      filename VARCHAR(255) NOT NULL,
      mime_type VARCHAR(100) NOT NULL,
      media_data LONGBLOB NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_generation_media_generation (generation_id, position_index),
      KEY idx_generation_media_kind (generation_id, media_kind),
      CONSTRAINT fk_generation_media_generation FOREIGN KEY (generation_id) REFERENCES generations(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS credit_transactions (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id BIGINT UNSIGNED NOT NULL,
      generation_id CHAR(36) NULL,
      amount DECIMAL(12,2) NOT NULL,
      type VARCHAR(40) NOT NULL,
      note VARCHAR(255) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_credit_user_created (user_id, created_at),
      KEY idx_credit_generation (generation_id),
      CONSTRAINT fk_credit_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      CONSTRAINT fk_credit_generation FOREIGN KEY (generation_id) REFERENCES generations(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS plan_requests (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id BIGINT UNSIGNED NOT NULL,
      plan_code VARCHAR(20) NOT NULL,
      price_pkr DECIMAL(12,2) NOT NULL,
      credits DECIMAL(12,2) NOT NULL,
      concurrency_limit INT NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      decided_at DATETIME NULL,
      PRIMARY KEY (id),
      KEY idx_plan_requests_user_created (user_id, created_at),
      KEY idx_plan_requests_status_created (status, created_at),
      CONSTRAINT fk_plan_requests_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS user_provider_access (
      user_id BIGINT UNSIGNED NOT NULL,
      provider VARCHAR(40) NOT NULL,
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, provider),
      KEY idx_user_provider_access_provider (provider, enabled),
      CONSTRAINT fk_user_provider_access_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS user_voice_clones (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id BIGINT UNSIGNED NOT NULL,
      provider VARCHAR(40) NOT NULL DEFAULT 'vibi',
      provider_clone_id VARCHAR(191) NULL,
      voice_name VARCHAR(191) NOT NULL,
      language_tag VARCHAR(80) NOT NULL DEFAULT 'English',
      gender VARCHAR(40) NOT NULL DEFAULT 'Male',
      preview_text VARCHAR(220) NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'queued',
      credits_cost DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      refunded_at DATETIME NULL,
      sample_filename VARCHAR(255) NULL,
      sample_mime_type VARCHAR(100) NULL,
      sample_data LONGBLOB NULL,
      sample_audio_url TEXT NULL,
      cover_url TEXT NULL,
      error_message TEXT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_user_voice_clones_user (user_id, created_at),
      KEY idx_user_voice_clones_status (status, updated_at),
      UNIQUE KEY uq_user_voice_provider_clone (provider, provider_clone_id),
      CONSTRAINT fk_user_voice_clones_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS provider_models (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      provider VARCHAR(40) NOT NULL,
      provider_model_id VARCHAR(191) NOT NULL,
      public_model_id VARCHAR(100) NOT NULL,
      label VARCHAR(191) NOT NULL,
      media_type VARCHAR(20) NOT NULL,
      tool_name VARCHAR(191) NOT NULL,
      input_schema LONGTEXT NULL,
      options_json LONGTEXT NULL,
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      available TINYINT(1) NOT NULL DEFAULT 1,
      last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_provider_models_provider_model_media (provider, provider_model_id, media_type),
      KEY idx_provider_models_public (provider, public_model_id, media_type),
      KEY idx_provider_models_enabled (provider, media_type, enabled, available)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  ];

  for (const sql of statements) {
    await db.query(sql);
  }

  async function ensureGenerationColumn(name, definition) {
    const [columns] = await db.query("SHOW COLUMNS FROM generations LIKE ?", [name]);
    if (!columns.length) {
      await db.query("ALTER TABLE generations ADD COLUMN " + definition);
    }
    return columns[0] || null;
  }

  const [voiceCloneCreditsColumn] = await db.query("SHOW COLUMNS FROM user_voice_clones LIKE 'credits_cost'");
  if (!voiceCloneCreditsColumn.length) {
    await db.query("ALTER TABLE user_voice_clones ADD COLUMN credits_cost DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER status");
  }
  const [voiceCloneRefundColumn] = await db.query("SHOW COLUMNS FROM user_voice_clones LIKE 'refunded_at'");
  if (!voiceCloneRefundColumn.length) {
    await db.query("ALTER TABLE user_voice_clones ADD COLUMN refunded_at DATETIME NULL AFTER credits_cost");
  }

  const [providerAvailableColumn] = await db.query("SHOW COLUMNS FROM provider_models LIKE 'available'");
  if (!providerAvailableColumn.length) {
    await db.query("ALTER TABLE provider_models ADD COLUMN available TINYINT(1) NOT NULL DEFAULT 1 AFTER enabled");
  }

  const [userPlanColumn] = await db.query("SHOW COLUMNS FROM users LIKE 'plan_code'");
  if (!userPlanColumn.length) {
    await db.query("ALTER TABLE users ADD COLUMN plan_code VARCHAR(20) NULL AFTER credits");
  }

  await ensureGenerationColumn('provider', "provider VARCHAR(40) NOT NULL DEFAULT 'vidancee' AFTER user_id");
  await ensureGenerationColumn('media_type', "media_type VARCHAR(20) NOT NULL DEFAULT 'video' AFTER provider");
  const providerJobColumn = await ensureGenerationColumn('provider_job_id', "provider_job_id VARCHAR(191) NULL AFTER media_type");
  await ensureGenerationColumn('queue_priority', "queue_priority INT NOT NULL DEFAULT 0 AFTER provider_job_id");
  if (providerJobColumn && !/varchar/i.test(String(providerJobColumn.Type || ''))) {
    await db.query("ALTER TABLE generations MODIFY provider_job_id VARCHAR(191) NULL");
  }

  await ensureGenerationColumn('mode', "mode VARCHAR(40) NOT NULL DEFAULT 'text-to-video' AFTER queue_priority");
  await ensureGenerationColumn('resolution', "resolution VARCHAR(20) NULL AFTER duration");
  await ensureGenerationColumn('image_quality', "image_quality VARCHAR(10) NULL AFTER resolution");
  await ensureGenerationColumn('poster_url', "poster_url TEXT NULL AFTER output_url");

  const providerCostColumn = await ensureGenerationColumn('provider_cost', "provider_cost DECIMAL(12,4) NULL AFTER credits_cost");
  if (providerCostColumn && !/decimal/i.test(String(providerCostColumn.Type || ''))) {
    await db.query("ALTER TABLE generations MODIFY provider_cost DECIMAL(12,4) NULL");
  }

  await ensureGenerationColumn('provider_cost_unit', "provider_cost_unit VARCHAR(20) NULL AFTER provider_cost");
  await ensureGenerationColumn('provider_meta', "provider_meta LONGTEXT NULL AFTER provider_cost_unit");

  const [userCreditsColumn] = await db.query("SHOW COLUMNS FROM users LIKE 'credits'");
  if (userCreditsColumn[0] && !/decimal\(12,2\)/i.test(String(userCreditsColumn[0].Type || ''))) {
    await db.query("ALTER TABLE users MODIFY credits DECIMAL(12,2) NOT NULL DEFAULT 0.00");
  }

  const [generationCreditsColumn] = await db.query("SHOW COLUMNS FROM generations LIKE 'credits_cost'");
  if (generationCreditsColumn[0] && !/decimal\(12,2\)/i.test(String(generationCreditsColumn[0].Type || ''))) {
    await db.query("ALTER TABLE generations MODIFY credits_cost DECIMAL(12,2) NOT NULL");
  }

  const [transactionAmountColumn] = await db.query("SHOW COLUMNS FROM credit_transactions LIKE 'amount'");
  if (transactionAmountColumn[0] && !/decimal\(12,2\)/i.test(String(transactionAmountColumn[0].Type || ''))) {
    await db.query("ALTER TABLE credit_transactions MODIFY amount DECIMAL(12,2) NOT NULL");
  }

  initialized = true;
  return true;
}

async function dbHealth() {
  if (!dbConfigured()) return { configured: false, connected: false };
  try {
    await initDb();
    const db = getPool();
    await db.query('SELECT 1');
    return { configured: true, connected: true };
  } catch (error) {
    return { configured: true, connected: false, error: error.message };
  }
}

module.exports = { dbConfigured, getPool, initDb, dbHealth };

