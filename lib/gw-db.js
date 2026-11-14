// Base des comptes de la passerelle : SQLite local (node:sqlite), independante de MySQL pour que la
// connexion marche meme si MySQL est indisponible. Chaque serveur a SA base (pas de SSO entre serveurs).
const fs = require('fs');
const path = require('path');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS gw_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  login TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  email TEXT,
  password_hash TEXT NOT NULL,
  is_super INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS gw_access (
  user_id INTEGER NOT NULL REFERENCES gw_users(id) ON DELETE CASCADE,
  app TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','member')),
  PRIMARY KEY (user_id, app)
);
CREATE TABLE IF NOT EXISTS gw_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES gw_users(id) ON DELETE CASCADE,
  device TEXT,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gw_sessions_user ON gw_sessions(user_id);
`;

const defaultFile = () => process.env.GATEWAY_DB || path.join(__dirname, '..', 'data', 'gateway.db');

function openGatewayDb(file = defaultFile()) {
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  try { fs.chmodSync(file, 0o600); } catch (e) { /* Windows */ }
  return db;
}

module.exports = { openGatewayDb, defaultFile };
