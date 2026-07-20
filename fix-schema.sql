CREATE TABLE IF NOT EXISTS wa_outgoing (
  id INT AUTO_INCREMENT PRIMARY KEY,
  staff_id VARCHAR(100),
  wa_number VARCHAR(50),
  message TEXT,
  msg_type VARCHAR(30) DEFAULT 'chat',
  file_name VARCHAR(255) NULL,
  file_mime VARCHAR(100) NULL,
  file_data LONGTEXT NULL,
  status VARCHAR(20) DEFAULT 'pending',
  message_id VARCHAR(255) NULL,
  retry_count INT DEFAULT 0,
  caption TEXT NULL,
  scheduled_at DATETIME NULL,
  created_at DATETIME DEFAULT NOW(),
  updated_at DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE INDEX idx_outgoing_status_scheduled ON wa_outgoing (status, scheduled_at);

CREATE TABLE IF NOT EXISTS wa_incoming (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  staff_id   VARCHAR(100) NOT NULL,
  from_number VARCHAR(50),
  body       TEXT,
  msg_type   VARCHAR(30) DEFAULT 'chat',
  has_media  TINYINT(1) DEFAULT 0,
  created_at DATETIME DEFAULT NOW()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS wa_templates (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  name       VARCHAR(100) NOT NULL UNIQUE,
  content    TEXT NOT NULL,
  created_at DATETIME DEFAULT NOW()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
