import { createHash, randomBytes } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import '@fastify/cookie';
import { db, id, passwordMatches } from './db.js';
import { seal } from './crypto.js';

export type Principal = { id: string; role: string; username?: string; type: 'session' | 'api_key' };
const hash = (value: string) => createHash('sha256').update(value).digest('base64url');

export function newApiKey() { return `a2a_${randomBytes(32).toString('base64url')}`; }

export function createSession(userId: string) {
  const session = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(hash(session), userId, Date.now() + 7 * 24 * 60 * 60_000, Date.now());
  return session;
}

export function login(username: string, password: string) {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as { id: string; password_hash: string; role: string } | undefined;
  if (!user || !passwordMatches(password, user.password_hash)) return null;
  return { user: { id: user.id, role: user.role }, token: createSession(user.id) };
}

export function principal(request: FastifyRequest): Principal | null {
  const session = request.cookies.a2a_session;
  if (session) {
    const item = db.prepare(`SELECT u.id, u.username, u.role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ?`).get(hash(session), Date.now()) as { id: string; username: string; role: string } | undefined;
    if (item) return { ...item, type: 'session' };
  }
  const bearer = request.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!bearer) return null;

  // 1. Check if bearer is a user session token (e.g. from frontend login localStorage)
  const sessionItem = db.prepare(`SELECT u.id, u.username, u.role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ?`).get(hash(bearer), Date.now()) as { id: string; username: string; role: string } | undefined;
  if (sessionItem) return { ...sessionItem, type: 'session' };

  // 2. Check if bearer is an API Key
  const key = db.prepare(`SELECT id, role FROM api_keys WHERE key_hash = ? AND status = 'active' AND (expires_at IS NULL OR expires_at > ?)`)
    .get(hash(bearer), Date.now()) as { id: string; role: string } | undefined;
  if (!key) return null;
  db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(Date.now(), key.id);
  return { ...key, type: 'api_key' };
}

export function requireRole(request: FastifyRequest, roles: string[]) {
  const actor = principal(request);
  if (!actor || !roles.includes(actor.role)) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 });
  return actor;
}

export function saveApiKey(name: string, role = 'user', expiresAt?: number) {
  const value = newApiKey();
  const keyId = id('key');
  const encrypted = seal(value);
  db.prepare('INSERT INTO api_keys (id, name, key_prefix, key_hash, secret_ciphertext, secret_iv, secret_tag, role, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(keyId, name, value.slice(0, 12), hash(value), encrypted.ciphertext, encrypted.iv, encrypted.tag, role, expiresAt ?? null, Date.now());
  return { id: keyId, value, prefix: value.slice(0, 12) };
}
