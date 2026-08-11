import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dataDir = resolve(process.env.ANY2API_DATA_DIR ?? './data');
mkdirSync(dataDir, { recursive: true });

function encryptionKey() {
  const value = process.env.ANY2API_ENCRYPTION_KEY;
  const path = resolve(dataDir, '.encryption-key');
  const stored = !value && existsSync(path) ? readFileSync(path, 'utf8').trim() : undefined;
  const generated = !value && !stored ? randomBytes(32).toString('base64url') : undefined;
  let active = value ?? stored ?? generated!;
  if (generated) { try { writeFileSync(path, generated, { encoding: 'utf8', mode: 0o600, flag: 'wx' }); } catch { active = readFileSync(path, 'utf8').trim(); } }
  const key = Buffer.from(active, 'base64url');
  if (key.length !== 32) throw new Error('ANY2API_ENCRYPTION_KEY must be a 32-byte base64url value');
  return key;
}

function sessionSecret() {
  if (process.env.ANY2API_SESSION_SECRET) return process.env.ANY2API_SESSION_SECRET;
  const path = resolve(dataDir, '.session-secret');
  if (existsSync(path)) return readFileSync(path, 'utf8').trim();
  const value = randomBytes(32).toString('base64url');
  try { writeFileSync(path, value, { encoding: 'utf8', mode: 0o600, flag: 'wx' }); return value; }
  catch { return readFileSync(path, 'utf8').trim(); }
}

export const config = {
  host: process.env.ANY2API_HOST ?? '127.0.0.1',
  port: Number(process.env.ANY2API_PORT ?? 8787),
  origin: process.env.ANY2API_ORIGIN ?? 'http://localhost:5173',
  dbPath: resolve(dataDir, 'any2api.sqlite'),
  encryptionKey: encryptionKey(),
  ownerUsername: process.env.ANY2API_OWNER_USERNAME ?? 'owner',
  ownerPassword: process.env.ANY2API_OWNER_PASSWORD ?? '',
  sessionSecret: sessionSecret()
};
