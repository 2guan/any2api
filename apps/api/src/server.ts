import Fastify, { type FastifyReply } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import { config } from './config.js';
import { db, id } from './db.js';
import { catalog, modelList, seedWebDefaults, upsertDiscoveredModel } from './catalog.js';
import { onEvent } from './events.js';
import { execute } from './gateway.js';
import { login, principal, requireRole, saveApiKey } from './auth.js';
import { seal, unseal } from './crypto.js';
import { credentialsFor, saveCredentials } from './credentials.js';
import { providers } from './providers/registry.js';
import './providers/index.js';

seedWebDefaults();

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
await app.register(cookie);
const localOrigins = new Set([config.origin, 'http://127.0.0.1:5173', 'http://localhost:5173', 'http://127.0.0.1:5174', 'http://localhost:5174']);
await app.register(cors, { origin: (origin, done) => done(null, !origin || localOrigins.has(origin)), credentials: true });
await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });

const chatRequest = z.object({
  model: z.string().min(1),
  messages: z.array(z.object({ role: z.string(), content: z.any() })).min(1),
  stream: z.boolean().default(true),
  reasoning: z.object({ effort: z.string().optional() }).optional(),
  web_search: z.boolean().optional()
});
const accountInput = z.object({ provider: z.enum(['chatgpt', 'kimi', 'deepseek', 'glm', 'qwen', 'jimeng']), name: z.string().trim().min(1), credentials: z.record(z.string(), z.string()), priority: z.number().int().min(0).max(100).default(50) });

app.setErrorHandler((error, request, reply) => {
  request.log.error(error);
  reply.status((error as { statusCode?: number }).statusCode ?? 500).send({ error: { message: error instanceof Error ? error.message : 'Internal error', type: 'any2api_error' } });
});

app.get('/health', async () => ({ status: 'ok', now: new Date().toISOString() }));
app.get('/v1/models', async () => modelList());

async function streamChat(request: z.infer<typeof chatRequest>, reply: FastifyReply, options: { kind: 'api' | 'connection_test'; apiKeyId?: string; accountId?: string }) {
  reply.hijack();
  reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  let sentRole = false;
  try {
    for await (const { requestId, item } of execute({ model: request.model, messages: request.messages as Array<{ role: string; content: unknown }>, stream: true, reasoning: request.reasoning, webSearch: request.web_search }, options)) {
      const delta: Record<string, unknown> = {};
      if (!sentRole) { delta.role = 'assistant'; sentRole = true; }
      if (item.type === 'message.delta') delta.content = item.text;
      if (item.type === 'reasoning.summary.delta') delta.reasoning_content = item.text;
      if (item.type === 'search.citation') delta.annotations = [{ type: 'url_citation', url: item.url, title: item.title }];
      if (item.type === 'image.created') delta.content = `![generated image](${item.url})\n\n`;
      reply.raw.write(`data: ${JSON.stringify({ id: requestId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: request.model, choices: [{ index: 0, delta, finish_reason: item.type === 'completed' ? 'stop' : null }] })}\n\n`);
    }
    reply.raw.write('data: [DONE]\n\n');
  } catch (error) {
    reply.raw.write(`data: ${JSON.stringify({ error: { message: error instanceof Error ? error.message : 'Gateway error' } })}\n\n`);
  } finally { reply.raw.end(); }
}

app.post('/v1/chat/completions', async (request, reply) => {
  const actor = principal(request);
  if (!actor) throw Object.assign(new Error('Invalid API key'), { statusCode: 401 });
  const input = chatRequest.parse(request.body);
  if (input.stream) return streamChat(input, reply, { kind: 'api', apiKeyId: actor.type === 'api_key' ? actor.id : undefined });
  let content = '';
  let requestId = '';
  for await (const result of execute({ model: input.model, messages: input.messages as Array<{ role: string; content: unknown }>, stream: false, reasoning: input.reasoning, webSearch: input.web_search }, { kind: 'api', apiKeyId: actor.type === 'api_key' ? actor.id : undefined })) {
    requestId = result.requestId;
    if (result.item.type === 'message.delta') content += result.item.text;
    if (result.item.type === 'image.created') content += `![generated image](${result.item.url})\n\n`;
  }
  return { id: requestId, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: input.model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] };
});

app.post('/api/auth/login', async (request, reply) => {
  const body = z.object({ username: z.string().trim().min(1), password: z.string().min(1) }).parse(request.body);
  const session = login(body.username, body.password);
  if (!session) throw Object.assign(new Error('Invalid username or password'), { statusCode: 401 });
  reply.setCookie('a2a_session', session.token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: 7 * 24 * 60 * 60 });
  return { user: session.user };
});
app.post('/api/auth/logout', async (_request, reply) => { reply.clearCookie('a2a_session', { path: '/' }); return { ok: true }; });
app.get('/api/auth/me', async (request) => { const actor = requireRole(request, ['owner', 'admin', 'operator', 'auditor']); return actor; });

app.get('/api/dashboard', async (request) => {
  requireRole(request, ['owner', 'admin', 'operator', 'auditor']);
  const [accounts, requests, failures, pending] = [
    db.prepare('SELECT COUNT(*) AS value FROM provider_accounts').get() as { value: number },
    db.prepare('SELECT COUNT(*) AS value FROM request_logs WHERE started_at > ?').get(Date.now() - 86_400_000) as { value: number },
    db.prepare("SELECT COUNT(*) AS value FROM request_logs WHERE status = 'failed' AND started_at > ?").get(Date.now() - 86_400_000) as { value: number },
    db.prepare("SELECT COUNT(*) AS value FROM provider_accounts WHERE status IN ('refresh_due', 'action_required')").get() as { value: number }
  ];
  return { accounts: accounts.value, requests24h: requests.value, failures24h: failures.value, attention: pending.value };
});
app.get('/api/catalog/models', async (request) => { requireRole(request, ['owner', 'admin', 'operator', 'auditor']); return catalog(); });
app.get('/api/accounts', async (request) => { requireRole(request, ['owner', 'admin', 'operator', 'auditor']); return db.prepare('SELECT id, provider, name, status, priority, max_concurrency, active_leases, success_ewma, latency_ewma_ms, cooldown_until, last_error, last_used_at FROM provider_accounts ORDER BY provider, priority DESC').all(); });
app.get('/api/accounts/:id/credentials', async (request) => {
  requireRole(request, ['owner', 'admin']);
  const { id: accountId } = request.params as { id: string };
  const account = db.prepare('SELECT id FROM provider_accounts WHERE id = ?').get(accountId) as { id: string } | undefined;
  if (!account) throw Object.assign(new Error('Account not found'), { statusCode: 404 });
  return credentialsFor(accountId);
});
app.get('/api/accounts/export', async (request) => {
  requireRole(request, ['owner', 'admin']);
  const accounts = db.prepare('SELECT id, provider, name, priority FROM provider_accounts ORDER BY provider, priority DESC, name').all() as Array<{ id: string; provider: string; name: string; priority: number }>;
  return { version: 1, accounts: accounts.map(({ id: accountId, ...account }) => ({ ...account, credentials: credentialsFor(accountId) })) };
});
app.post('/api/accounts/import', async (request) => {
  requireRole(request, ['owner', 'admin']);
  const body = z.object({ accounts: z.array(accountInput).min(1).max(500) }).parse(request.body);
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const account of body.accounts) {
      const existing = db.prepare('SELECT id FROM provider_accounts WHERE provider = ? AND name = ?').get(account.provider, account.name) as { id: string } | undefined;
      const accountId = existing?.id ?? id('acc'); const now = Date.now(); const encrypted = seal(account.credentials);
      if (existing) db.prepare("UPDATE provider_accounts SET priority = ?, status = 'ready', updated_at = ? WHERE id = ?").run(account.priority, now, accountId);
      else db.prepare("INSERT INTO provider_accounts (id, provider, name, status, priority, created_at, updated_at) VALUES (?, ?, ?, 'ready', ?, ?, ?)").run(accountId, account.provider, account.name, account.priority, now, now);
      db.prepare(`INSERT INTO account_credentials (account_id, ciphertext, iv, tag, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv, tag = excluded.tag, updated_at = excluded.updated_at`).run(accountId, encrypted.ciphertext, encrypted.iv, encrypted.tag, now);
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { imported: body.accounts.length };
});
app.post('/api/accounts', async (request) => {
  requireRole(request, ['owner', 'admin']);
  const body = accountInput.parse(request.body);
  const accountId = id('acc'); const now = Date.now(); const encrypted = seal(body.credentials);
  db.prepare(`INSERT INTO provider_accounts (id, provider, name, status, priority, created_at, updated_at) VALUES (?, ?, ?, 'ready', ?, ?, ?)`).run(accountId, body.provider, body.name, body.priority, now, now);
  db.prepare('INSERT INTO account_credentials (account_id, ciphertext, iv, tag, updated_at) VALUES (?, ?, ?, ?, ?)').run(accountId, encrypted.ciphertext, encrypted.iv, encrypted.tag, now);
  return { id: accountId, status: 'ready' };
});
app.patch('/api/accounts/:id', async (request) => {
  requireRole(request, ['owner', 'admin']);
  const { id: accountId } = request.params as { id: string };
  const body = z.object({ name: z.string().trim().min(1).optional(), credentials: z.record(z.string(), z.string()).optional(), priority: z.number().int().min(0).max(100).optional() }).parse(request.body);
  const account = db.prepare('SELECT id FROM provider_accounts WHERE id = ?').get(accountId) as { id: string } | undefined;
  if (!account) throw Object.assign(new Error('Account not found'), { statusCode: 404 });
  const assignments: string[] = []; const values: Array<string | number> = [];
  if (body.name !== undefined) { assignments.push('name = ?'); values.push(body.name); }
  if (body.priority !== undefined) { assignments.push('priority = ?'); values.push(body.priority); }
  if (assignments.length) { assignments.push('updated_at = ?'); values.push(Date.now(), accountId); db.prepare(`UPDATE provider_accounts SET ${assignments.join(', ')} WHERE id = ?`).run(...values); }
  if (body.credentials && Object.keys(body.credentials).length) saveCredentials(accountId, { ...credentialsFor(accountId), ...body.credentials });
  return { ok: true };
});
app.post('/api/accounts/:id/test', async (request) => {
  requireRole(request, ['owner', 'admin', 'operator']); const { id: accountId } = request.params as { id: string };
  const account = db.prepare('SELECT * FROM provider_accounts WHERE id = ?').get(accountId) as import('./accounts.js').Account & { provider: string; name: string } | undefined;
  if (!account) throw Object.assign(new Error('Account not found'), { statusCode: 404 });
  const adapter = providers.get(account.provider);
  if (!adapter) throw Object.assign(new Error(`No adapter registered for ${account.provider}`), { statusCode: 400 });
  const result = await adapter.testConnection(account);
  db.prepare('UPDATE provider_accounts SET status = ?, last_error = ?, updated_at = ? WHERE id = ?').run(result.ok ? 'ready' : 'action_required', result.ok ? null : result.detail, Date.now(), accountId);
  return result;
});
app.post('/api/keys', async (request) => { requireRole(request, ['owner', 'admin']); const body = z.object({ name: z.string().trim().min(1), role: z.enum(['user', 'operator']).default('user') }).parse(request.body); return saveApiKey(body.name, body.role); });
app.get('/api/keys', async (request) => { requireRole(request, ['owner', 'admin']); return db.prepare('SELECT id, name, key_prefix, role, status, expires_at, last_used_at, created_at FROM api_keys ORDER BY created_at DESC').all(); });
app.get('/api/keys/:id/value', async (request) => { requireRole(request, ['owner', 'admin']); const { id } = request.params as { id: string }; const key = db.prepare('SELECT secret_ciphertext, secret_iv, secret_tag FROM api_keys WHERE id = ?').get(id) as { secret_ciphertext: string | null; secret_iv: string | null; secret_tag: string | null } | undefined; if (!key) throw Object.assign(new Error('API key not found'), { statusCode: 404 }); if (!key.secret_ciphertext || !key.secret_iv || !key.secret_tag) throw Object.assign(new Error('该密钥创建于旧版本，无法恢复完整值；请重新生成。'), { statusCode: 409 }); return { value: unseal<string>({ ciphertext: key.secret_ciphertext, iv: key.secret_iv, tag: key.secret_tag }) }; });
app.patch('/api/keys/:id', async (request) => { requireRole(request, ['owner', 'admin']); const { id } = request.params as { id: string }; const body = z.object({ status: z.enum(['active', 'revoked']) }).parse(request.body); db.prepare('UPDATE api_keys SET status = ? WHERE id = ?').run(body.status, id); return { ok: true }; });
app.delete('/api/keys/:id', async (request) => { requireRole(request, ['owner', 'admin']); const { id } = request.params as { id: string }; db.prepare('DELETE FROM api_keys WHERE id = ?').run(id); return { ok: true }; });
app.get('/api/users', async (request) => { requireRole(request, ['owner', 'admin']); return db.prepare('SELECT id, username, role, created_at, updated_at FROM users ORDER BY created_at').all(); });
app.post('/api/users', async (request) => { const actor = requireRole(request, ['owner', 'admin']); const body = z.object({ username: z.string().trim().min(1).max(64), password: z.string().min(4), role: z.enum(['admin', 'operator', 'auditor']) }).parse(request.body); if (actor.role !== 'owner' && body.role === 'admin') throw Object.assign(new Error('Only the owner can create an admin'), { statusCode: 403 }); const { passwordHash } = await import('./db.js'); const now = Date.now(); const userId = id('usr'); db.prepare('INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(userId, body.username, passwordHash(body.password), body.role, now, now); return { id: userId }; });
app.patch('/api/users/:id', async (request) => { const actor = requireRole(request, ['owner', 'admin']); const { id: userId } = request.params as { id: string }; const body = z.object({ password: z.string().min(4).optional(), role: z.enum(['admin', 'operator', 'auditor']).optional() }).parse(request.body); if (body.role === 'admin' && actor.role !== 'owner') throw Object.assign(new Error('Only the owner can grant admin'), { statusCode: 403 }); const target = db.prepare('SELECT role FROM users WHERE id = ?').get(userId) as { role: string } | undefined; if (!target) throw Object.assign(new Error('User not found'), { statusCode: 404 }); if (target.role === 'owner') throw Object.assign(new Error('The bootstrap owner cannot be modified here'), { statusCode: 403 }); const assignments: string[] = []; const values: Array<string | number> = []; if (body.password) { const { passwordHash } = await import('./db.js'); assignments.push('password_hash = ?'); values.push(passwordHash(body.password)); } if (body.role) { assignments.push('role = ?'); values.push(body.role); } if (assignments.length) { assignments.push('updated_at = ?'); values.push(Date.now(), userId); db.prepare(`UPDATE users SET ${assignments.join(', ')} WHERE id = ?`).run(...values); } return { ok: true }; });
app.get('/api/routes', async (request) => { requireRole(request, ['owner', 'admin', 'operator', 'auditor']); return db.prepare(`SELECT r.id, r.public_model, r.enabled, r.priority, m.provider, m.upstream_id, m.capabilities_json FROM routes r JOIN models m ON m.id = r.model_id ORDER BY r.priority DESC, r.public_model`).all(); });
app.post('/api/routes', async (request) => { requireRole(request, ['owner', 'admin', 'operator']); const body = z.object({ publicModel: z.string().trim().min(1), provider: z.enum(['chatgpt', 'kimi', 'deepseek', 'glm', 'qwen', 'jimeng']), upstreamModel: z.string().trim().min(1), priority: z.number().int().min(0).max(100).default(50), enabled: z.boolean().default(true), capabilities: z.object({ input: z.array(z.enum(['text', 'image'])).default(['text']), output: z.array(z.enum(['text', 'image', 'video'])).default(['text']), streaming: z.boolean().default(true), reasoningSummary: z.boolean().optional(), webSearch: z.boolean().optional(), imageGeneration: z.boolean().optional() }).default({ input: ['text'], output: ['text'], streaming: true }) }).parse(request.body); upsertDiscoveredModel(body.provider, body.upstreamModel, body.capabilities, body.publicModel); db.prepare('UPDATE routes SET priority = ?, enabled = ? WHERE public_model = ?').run(body.priority, body.enabled ? 1 : 0, body.publicModel); return { ok: true }; });
app.patch('/api/routes/:id', async (request) => { requireRole(request, ['owner', 'admin', 'operator']); const { id } = request.params as { id: string }; const body = z.object({ publicModel: z.string().trim().min(1).optional(), provider: z.enum(['chatgpt', 'kimi', 'deepseek', 'glm', 'qwen', 'jimeng']).optional(), upstreamModel: z.string().trim().min(1).optional(), enabled: z.boolean().optional(), priority: z.number().int().min(0).max(100).optional() }).parse(request.body); const row = db.prepare('SELECT r.id, r.model_id FROM routes r WHERE r.id = ?').get(id) as { id: string; model_id: string } | undefined; if (!row) throw Object.assign(new Error('Route not found'), { statusCode: 404 }); const routeAssignments: string[] = []; const routeValues: Array<string | number> = []; if (body.publicModel !== undefined) { routeAssignments.push('public_model = ?'); routeValues.push(body.publicModel); } if (body.enabled !== undefined) { routeAssignments.push('enabled = ?'); routeValues.push(body.enabled ? 1 : 0); } if (body.priority !== undefined) { routeAssignments.push('priority = ?'); routeValues.push(body.priority); } if (routeAssignments.length) { routeValues.push(id); db.prepare(`UPDATE routes SET ${routeAssignments.join(', ')} WHERE id = ?`).run(...routeValues); } const modelAssignments: string[] = []; const modelValues: string[] = []; if (body.provider !== undefined) { modelAssignments.push('provider = ?'); modelValues.push(body.provider); } if (body.upstreamModel !== undefined) { modelAssignments.push('upstream_id = ?'); modelValues.push(body.upstreamModel); } if (modelAssignments.length) { modelValues.push(row.model_id); db.prepare(`UPDATE models SET ${modelAssignments.join(', ')} WHERE id = ?`).run(...modelValues); } return { ok: true }; });
app.get('/api/analytics', async (request) => { requireRole(request, ['owner', 'admin', 'operator', 'auditor']); const since = Date.now() - 7 * 86_400_000; return { summary: db.prepare(`SELECT COUNT(*) AS requests, SUM(status = 'completed') AS completed, SUM(status = 'failed') AS failed, ROUND(AVG(latency_ms)) AS latency FROM request_logs WHERE started_at > ?`).get(since), byProvider: db.prepare(`SELECT COALESCE(provider, 'unrouted') AS provider, COUNT(*) AS requests, SUM(status = 'failed') AS failed, ROUND(AVG(latency_ms)) AS latency FROM request_logs WHERE started_at > ? GROUP BY provider ORDER BY requests DESC`).all(since) }; });
app.get('/api/logs', async (request) => { requireRole(request, ['owner', 'admin', 'operator', 'auditor']); return db.prepare('SELECT l.*, a.name AS account_name, k.name AS api_key_name FROM request_logs l LEFT JOIN provider_accounts a ON a.id = l.account_id LEFT JOIN api_keys k ON k.id = l.api_key_id ORDER BY l.started_at DESC LIMIT 200').all(); });
app.get('/api/logs/:requestId/events', async (request) => { requireRole(request, ['owner', 'admin', 'operator', 'auditor']); const { requestId } = request.params as { requestId: string }; return db.prepare('SELECT id, at, level, event, message, details_json FROM request_events WHERE request_id = ? ORDER BY id').all(requestId); });
app.get('/api/logs/live', async (request, reply) => {
  requireRole(request, ['owner', 'admin', 'operator', 'auditor']); reply.hijack(); reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const stop = onEvent((item) => reply.raw.write(`data: ${JSON.stringify(item)}\n\n`));
  request.raw.on('close', stop);
});
app.post('/api/connection-test', async (request, reply) => {
  requireRole(request, ['owner', 'admin', 'operator']); const body = chatRequest.extend({ accountId: z.string().optional() }).parse(request.body);
  return streamChat(body, reply, { kind: 'connection_test', accountId: body.accountId });
});

await app.listen({ host: config.host, port: config.port });
