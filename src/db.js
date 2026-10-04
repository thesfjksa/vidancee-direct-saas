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
      credits INT NOT NULL DEFAULT 0,
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
      provider_job_id VARCHAR(191) NULL,
      mode VARCHAR(40) NOT NULL DEFAULT 'text-to-video',
      model VARCHAR(80) NOT NULL,
      duration INT NOT NULL,
      aspect_ratio VARCHAR(20) NOT NULL,
      prompt TEXT NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'queued',
      credits_cost INT NOT NULL,
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

    `CREATE TABLE IF NOT EXISTS credit_transactions (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id BIGINT UNSIGNED NOT NULL,
      generation_id CHAR(36) NULL,
      amount INT NOT NULL,
      type VARCHAR(40) NOT NULL,
      note VARCHAR(255) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_credit_user_created (user_id, created_at),
      KEY idx_credit_generation (generation_id),
      CONSTRAINT fk_credit_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      CONSTRAINT fk_credit_generation FOREIGN KEY (generation_id) REFERENCES generations(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  ];

  for (const sql of statements) {
    await db.query(sql);
  }

  const [providerJobColumn] = await db.query("SHOW COLUMNS FROM generations LIKE 'provider_job_id'");
  if (providerJobColumn[0] && !/varchar/i.test(String(providerJobColumn[0].Type || ''))) {
    await db.query("ALTER TABLE generations MODIFY provider_job_id VARCHAR(191) NULL");
  }

  const [providerCostColumn] = await db.query("SHOW COLUMNS FROM generations LIKE 'provider_cost'");
  if (providerCostColumn[0] && !/decimal/i.test(String(providerCostColumn[0].Type || ''))) {
    await db.query("ALTER TABLE generations MODIFY provider_cost DECIMAL(12,4) NULL");
  }

  const [costUnitColumn] = await db.query("SHOW COLUMNS FROM generations LIKE 'provider_cost_unit'");
  if (!costUnitColumn.length) {
    await db.query("ALTER TABLE generations ADD COLUMN provider_cost_unit VARCHAR(20) NULL AFTER provider_cost");
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
