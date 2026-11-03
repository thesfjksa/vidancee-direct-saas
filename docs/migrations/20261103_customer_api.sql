-- Additive customer API tables. Run once with a MySQL account that can CREATE tables.
CREATE TABLE IF NOT EXISTS customer_api_keys (
    id CHAR(36) NOT NULL, user_id BIGINT UNSIGNED NOT NULL,
    name VARCHAR(80) NOT NULL, key_hash CHAR(64) NOT NULL, key_prefix VARCHAR(24) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, expires_at DATETIME NOT NULL,
    last_used_at DATETIME NULL, revoked_at DATETIME NULL,
    rate_window BIGINT NOT NULL DEFAULT 0, rate_count INT UNSIGNED NOT NULL DEFAULT 0,
    PRIMARY KEY (id), UNIQUE KEY uq_customer_api_hash (key_hash), KEY idx_customer_api_user (user_id),
    CONSTRAINT fk_customer_api_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS customer_api_requests (
    user_id BIGINT UNSIGNED NOT NULL, request_key_hash CHAR(64) NOT NULL,
    request_hash CHAR(64) NOT NULL, api_key_id CHAR(36) NOT NULL, generation_id CHAR(36) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id,request_key_hash), UNIQUE KEY uq_customer_api_generation (generation_id),
    KEY idx_customer_api_requests_key (api_key_id),
    CONSTRAINT fk_customer_api_request_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
