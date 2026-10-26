'use strict';
async function migrate(db) {
  // RENAME preserves the IDs used by existing desktop clients and Google Sheets.
  const [old] = await db.query("SHOW TABLES LIKE 'bot_reminder'");
  const [current] = await db.query("SHOW TABLES LIKE 'bot_todolist'");
  if (old.length && current.length) throw new Error('Ada dua tabel tugas; perlu rekonsiliasi sebelum migrasi.');
  if (old.length) await db.query('RENAME TABLE bot_reminder TO bot_todolist');
  await db.query(`CREATE TABLE IF NOT EXISTS bot_todolist (
    id INT AUTO_INCREMENT PRIMARY KEY, isi TEXT NOT NULL, waktu DATETIME NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'Menunggu Waktu', created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  const columns = [
    ['lead_days', 'TINYINT UNSIGNED NOT NULL DEFAULT 2'],
    ['revision', 'INT UNSIGNED NOT NULL DEFAULT 1'],
    ['archived_at', 'DATETIME NULL'],
    ['display_version', 'INT UNSIGNED NOT NULL DEFAULT 1'],
    ['updated_at', 'DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP']
  ];
  for (const [name, type] of columns) {
    const [found] = await db.query('SHOW COLUMNS FROM bot_todolist LIKE ?', [name]);
    if (!found.length) await db.query(`ALTER TABLE bot_todolist ADD COLUMN ${name} ${type}`);
  }
  // Previously 'Terkirim' meant an alert was sent, not that the user completed the task.
  await db.query("UPDATE bot_todolist SET status='Menunggu Waktu' WHERE status IN ('Terkirim','Pending')");
  await db.query(`CREATE TABLE IF NOT EXISTS todo_notifications (
    task_id INT NOT NULL, local_day DATE NOT NULL, state VARCHAR(16) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(task_id, local_day)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await db.query(`CREATE TABLE IF NOT EXISTS todo_conversations (
    chat_id VARCHAR(100) PRIMARY KEY, draft JSON NOT NULL, expires_at DATETIME NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await db.query(`CREATE TABLE IF NOT EXISTS todo_due_notifications (
    task_id INT NOT NULL, due_time DATETIME NOT NULL, state VARCHAR(16) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(task_id,due_time)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await db.query(`CREATE TABLE IF NOT EXISTS web_admin (
    id INT PRIMARY KEY, username VARCHAR(100) NOT NULL UNIQUE, password_hash VARCHAR(255) NOT NULL,
    totp_secret TEXT, totp_pending TEXT, totp_last_step BIGINT NOT NULL DEFAULT -1,
    failed_attempts INT NOT NULL DEFAULT 0, locked_until DATETIME NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await db.query(`CREATE TABLE IF NOT EXISTS web_sessions (
    token_hash CHAR(64) PRIMARY KEY, admin_id INT NOT NULL, stage VARCHAR(12) NOT NULL,
    csrf CHAR(64) NOT NULL, expires_at DATETIME NOT NULL, INDEX(expires_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await db.query(`CREATE TABLE IF NOT EXISTS web_recovery_codes (
    code_hash CHAR(64) PRIMARY KEY, admin_id INT NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}
if (require.main === module) {
  require('dotenv').config(); const db = require('./db');
  migrate(db).then(() => console.log('Migrasi TodoList selesai.')).catch(e => { console.error(e.message); process.exitCode = 1; }).finally(() => db.end());
}
module.exports = { migrate };
