-- Import into the existing CMMTools database if automatic CREATE is unavailable.

CREATE TABLE IF NOT EXISTS aivid_rdp_commands (
    id CHAR(36) NOT NULL PRIMARY KEY, device_id CHAR(36) NOT NULL, generation_id CHAR(36) NULL,
    kind VARCHAR(20) NOT NULL, state VARCHAR(20) NOT NULL, request_json LONGTEXT NOT NULL,
    response_json LONGTEXT NULL, expires_at DATETIME(3) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_aivid_rdp_device (device_id,state,expires_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS aivid_rdp_chunks (
    command_id CHAR(36) NOT NULL, position_index INT NOT NULL, media_data MEDIUMBLOB NOT NULL,
    PRIMARY KEY(command_id,position_index),
    CONSTRAINT fk_aivid_rdp_chunk FOREIGN KEY(command_id) REFERENCES aivid_rdp_commands(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
