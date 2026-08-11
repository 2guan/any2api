import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';

export const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('owner','admin','operator','auditor')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    key_prefix TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    secret_ciphertext TEXT,
    secret_iv TEXT,
    secret_tag TEXT,
    role TEXT NOT NULL DEFAULT 'user',
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
    expires_at INTEGER,
    last_used_at INTEGER,
    created_at INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS provider_accounts (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'action_required' CHECK(status IN ('ready','refresh_due','refreshing','cooling','action_required','disabled')),
    priority INTEGER NOT NULL DEFAULT 50 CHECK(priority BETWEEN 0 AND 100),
    max_concurrency INTEGER NOT NULL DEFAULT 1 CHECK(max_concurrency BETWEEN 1 AND 8),
    active_leases INTEGER NOT NULL DEFAULT 0,
    lease_until INTEGER,
    success_ewma REAL NOT NULL DEFAULT 1,
    latency_ewma_ms REAL,
    cooldown_until INTEGER,
    last_error TEXT,
    last_used_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(provider, name)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS account_credentials (
    account_id TEXT PRIMARY KEY REFERENCES provider_accounts(id) ON DELETE CASCADE,
    ciphertext TEXT NOT NULL,
    iv TEXT NOT NULL,
    tag TEXT NOT NULL,
    refresh_after INTEGER,
    expires_at INTEGER,
    updated_at INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS models (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    upstream_id TEXT NOT NULL,
    capabilities_json TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    discovered_at INTEGER NOT NULL,
    UNIQUE(provider, upstream_id)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS routes (
    id TEXT PRIMARY KEY,
    public_model TEXT NOT NULL UNIQUE,
    model_id TEXT NOT NULL REFERENCES models(id),
    enabled INTEGER NOT NULL DEFAULT 1,
    priority INTEGER NOT NULL DEFAULT 50,
    created_at INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS request_logs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    api_key_id TEXT,
    account_id TEXT,
    provider TEXT,
    model TEXT,
    status TEXT NOT NULL,
    http_status INTEGER,
    latency_ms INTEGER,
    started_at INTEGER NOT NULL,
    completed_at INTEGER
  ) STRICT;
  CREATE TABLE IF NOT EXISTS request_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id TEXT NOT NULL REFERENCES request_logs(id) ON DELETE CASCADE,
    at INTEGER NOT NULL,
    level TEXT NOT NULL CHECK(level IN ('debug','info','warn','error')),
    event TEXT NOT NULL,
    message TEXT NOT NULL,
    details_json TEXT NOT NULL DEFAULT '{}'
  ) STRICT;
  CREATE INDEX IF NOT EXISTS request_logs_started_idx ON request_logs(started_at DESC);
  CREATE INDEX IF NOT EXISTS request_events_request_idx ON request_events(request_id, id);
`);

const apiKeyColumns = new Set((db.prepare('PRAGMA table_info(api_keys)').all() as Array<{ name: string }>).map((column) => column.name));
for (const column of ['secret_ciphertext', 'secret_iv', 'secret_tag']) if (!apiKeyColumns.has(column)) db.exec(`ALTER TABLE api_keys ADD COLUMN ${column} TEXT`);

export function id(prefix: string) { return `${prefix}_${randomBytes(12).toString('base64url')}`; }

export function passwordHash(password: string) {
  const salt = randomBytes(16);
  return `${salt.toString('base64url')}:${scryptSync(password, salt, 64).toString('base64url')}`;
}

export function passwordMatches(password: string, stored: string) {
  const [saltValue, hashValue] = stored.split(':');
  if (!saltValue || !hashValue) return false;
  const hash = scryptSync(password, Buffer.from(saltValue, 'base64url'), 64);
  return timingSafeEqual(hash, Buffer.from(hashValue, 'base64url'));
}

if (config.ownerPassword && !db.prepare('SELECT 1 FROM users WHERE role = ?').get('owner')) {
  const now = Date.now();
  db.prepare('INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id('usr'), config.ownerUsername, passwordHash(config.ownerPassword), 'owner', now, now);
}
