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
import type { ProviderEvent } from './providers/types.js';
import './providers/index.js';

import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getMediaFile } from './media.js';
import { registerImageRoutes } from './routes/images.js';
import { registerMessagesRoutes } from './routes/messages.js';
import { registerEditableFilesRoutes } from './routes/editable_files.js';
import { registerOAuthRoutes } from './routes/oauth.js';

seedWebDefaults();

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
await app.register(cookie);
await app.register(cors, {
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-session-id', 'x-admin-token', 'x-api-key', 'anthropic-version', 'x-requested-with'],
});
await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });

await registerImageRoutes(app);
await registerMessagesRoutes(app);
await registerEditableFilesRoutes(app);
await registerOAuthRoutes(app);


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
  const errObj = error as { statusCode?: number; status?: number };
  const statusCode = errObj.statusCode ?? errObj.status ?? 500;
  reply.status(statusCode).send({
    error: {
      message: error instanceof Error ? error.message : 'Internal error',
      type: statusCode === 401 ? 'authentication_error' : statusCode === 404 ? 'invalid_request_error' : statusCode === 503 ? 'service_unavailable' : 'api_error',
      param: null,
      code: statusCode
    }
  });
});

app.get('/health', async () => ({ status: 'ok', now: new Date().toISOString() }));
app.get('/v1/models', async () => modelList());

app.get('/api/media/:filename', async (request, reply) => {
  const { filename } = request.params as { filename: string };
  const { path: filePath, exists } = getMediaFile(filename);
  if (!exists) {
    reply.status(404).send({ error: { message: 'Media file not found' } });
    return;
  }
  const ext = filename.split('.').pop()?.toLowerCase() || 'png';
  const mime = ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : ext === 'mp4' ? 'video/mp4' : 'application/octet-stream';
  const buffer = readFileSync(filePath);
  reply.header('Content-Type', mime);
  reply.header('Cache-Control', 'public, max-age=31536000, immutable');
  reply.header('Access-Control-Allow-Origin', '*');
  return reply.send(buffer);
});

async function streamChat(request: z.infer<typeof chatRequest>, reply: FastifyReply, options: { kind: 'api' | 'connection_test'; apiKeyId?: string; accountId?: string }) {
  const iterator = execute({
    model: request.model,
    messages: request.messages as Array<{ role: string; content: unknown }>,
    stream: true,
    reasoning: request.reasoning,
    webSearch: request.web_search
  }, options);

  let firstResult: IteratorResult<{ requestId: string; item: ProviderEvent }> | null = null;
  try {
    firstResult = await iterator.next();
  } catch (error) {
    const statusCode = (error as { statusCode?: number }).statusCode ?? 502;
    const message = error instanceof Error ? error.message : 'Gateway error';
    return reply.status(statusCode).send({
      error: {
        message,
        type: statusCode === 401 ? 'authentication_error' : statusCode === 404 ? 'invalid_request_error' : statusCode === 503 ? 'service_unavailable' : 'api_error',
        param: null,
        code: statusCode
      }
    });
  }

  reply.hijack();
  const origin = (reply.request.headers.origin as string | undefined) || '*';
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-session-id, x-admin-token, x-api-key, anthropic-version',
  });

  let sentRole = false;
  try {
    let current = firstResult;
    while (!current.done) {
      const { requestId, item } = current.value;
      const delta: Record<string, unknown> = {};
      if (!sentRole) { delta.role = 'assistant'; sentRole = true; }
      if (item.type === 'message.delta') delta.content = item.text;
      if (item.type === 'reasoning.summary.delta') delta.reasoning_content = item.text;
      if (item.type === 'search.citation') delta.annotations = [{ type: 'url_citation', url: item.url, title: item.title }];
      if (item.type === 'image.created') delta.content = `![generated image](${item.url})\n\n`;

      reply.raw.write(`data: ${JSON.stringify({
        id: requestId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: request.model,
        choices: [{ index: 0, delta, finish_reason: item.type === 'completed' ? 'stop' : null }]
      })}\n\n`);

      current = await iterator.next();
    }
    reply.raw.write('data: [DONE]\n\n');
  } catch (error) {
    reply.raw.write(`data: ${JSON.stringify({ error: { message: error instanceof Error ? error.message : 'Gateway error', type: 'api_error', code: 502 } })}\n\n`);
  } finally {
    reply.raw.end();
  }
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
  reply.setCookie('a2a_session', session.token, { httpOnly: true, sameSite: 'none', secure: true, path: '/', maxAge: 7 * 24 * 60 * 60 });
  return { user: session.user, token: session.token };
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
app.delete('/api/accounts/:id', async (request) => {
  requireRole(request, ['owner', 'admin']);
  const { id: accountId } = request.params as { id: string };
  db.prepare('DELETE FROM account_credentials WHERE account_id = ?').run(accountId);
  db.prepare('DELETE FROM provider_accounts WHERE id = ?').run(accountId);
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
function parseTimeFilter(query: Record<string, string | undefined>) {
  const now = Date.now();
  let startTime = now - 7 * 86_400_000;
  let endTime = now;
  const timeRange = query.timeRange || '7d';

  if (timeRange === '1h') {
    startTime = now - 3600_000;
  } else if (timeRange === 'today') {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    startTime = today.getTime();
  } else if (timeRange === '24h') {
    startTime = now - 86_400_000;
  } else if (timeRange === '7d') {
    startTime = now - 7 * 86_400_000;
  } else if (timeRange === '30d') {
    startTime = now - 30 * 86_400_000;
  } else if (timeRange === 'all') {
    startTime = 0;
  } else if (timeRange === 'custom') {
    if (query.startTime) startTime = Number(query.startTime) || startTime;
    if (query.endTime) endTime = Number(query.endTime) || endTime;
  }
  return { startTime, endTime, timeRange };
}

function buildLogFilters(query: Record<string, string | undefined>, prefix = 'l.') {
  const { startTime, endTime, timeRange } = parseTimeFilter(query);
  const conditions: string[] = [`${prefix}started_at >= ?`, `${prefix}started_at <= ?`];
  const params: Array<string | number> = [startTime, endTime];

  if (query.provider && query.provider !== 'all') {
    conditions.push(`${prefix}provider = ?`);
    params.push(query.provider);
  }
  if (query.apiKeyId && query.apiKeyId !== 'all') {
    if (query.apiKeyId === 'test') {
      conditions.push(`${prefix}api_key_id IS NULL`);
    } else {
      conditions.push(`${prefix}api_key_id = ?`);
      params.push(query.apiKeyId);
    }
  }
  if (query.accountId && query.accountId !== 'all') {
    conditions.push(`${prefix}account_id = ?`);
    params.push(query.accountId);
  }
  if (query.model && query.model !== 'all') {
    conditions.push(`${prefix}model = ?`);
    params.push(query.model);
  }
  if (query.status && query.status !== 'all') {
    conditions.push(`${prefix}status = ?`);
    params.push(query.status);
  }
  if (query.kind && query.kind !== 'all') {
    conditions.push(`${prefix}kind = ?`);
    params.push(query.kind);
  }
  if (query.keyword) {
    conditions.push(`(${prefix}id LIKE ? OR ${prefix}model LIKE ? OR ${prefix}provider LIKE ?)`);
    const kw = `%${query.keyword}%`;
    params.push(kw, kw, kw);
  }
  return { conditions: conditions.join(' AND '), params, startTime, endTime, timeRange };
}

app.get('/api/analytics', async (request) => {
  requireRole(request, ['owner', 'admin', 'operator', 'auditor']);
  const query = request.query as Record<string, string | undefined>;
  const { conditions, params, startTime, endTime, timeRange } = buildLogFilters(query, 'l.');

  const summaryRaw = db.prepare(`
    SELECT 
      COUNT(*) AS requests,
      SUM(l.status = 'completed') AS completed,
      SUM(l.status = 'failed') AS failed,
      ROUND(AVG(l.latency_ms)) AS avg_latency,
      MIN(l.latency_ms) AS min_latency,
      MAX(l.latency_ms) AS max_latency,
      COUNT(DISTINCT l.api_key_id) AS active_keys,
      COUNT(DISTINCT l.account_id) AS active_accounts
    FROM request_logs l
    WHERE ${conditions}
  `).get(...params) as {
    requests: number;
    completed: number;
    failed: number;
    avg_latency: number | null;
    min_latency: number | null;
    max_latency: number | null;
    active_keys: number;
    active_accounts: number;
  };

  const requests = summaryRaw?.requests || 0;
  const completed = summaryRaw?.completed || 0;
  const failed = summaryRaw?.failed || 0;
  const success_rate = requests > 0 ? Math.round((completed / requests) * 1000) / 10 : 100;

  let p95_latency = summaryRaw?.avg_latency || 0;
  if (requests > 0) {
    const latencies = db.prepare(`
      SELECT l.latency_ms 
      FROM request_logs l 
      WHERE ${conditions} AND l.latency_ms IS NOT NULL 
      ORDER BY l.latency_ms ASC
    `).all(...params) as Array<{ latency_ms: number }>;
    if (latencies.length > 0) {
      const idx = Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95));
      p95_latency = latencies[idx].latency_ms;
    }
  }

  const imageCountRaw = db.prepare(`
    SELECT COUNT(e.id) AS image_count
    FROM request_events e
    JOIN request_logs l ON l.id = e.request_id
    WHERE e.event = 'upstream.image' AND ${conditions}
  `).get(...params) as { image_count: number } | undefined;
  const image_count = imageCountRaw?.image_count || 0;

  const span = Math.max(1000, endTime - startTime);
  const bucketMs = span <= 4 * 3600_000 ? 5 * 60_000 : span <= 48 * 3600_000 ? 3600_000 : 86_400_000;
  const timeSeriesRows = db.prepare(`
    SELECT 
      CAST(l.started_at / ? AS INTEGER) * ? AS bucket_time,
      COUNT(*) AS requests,
      SUM(l.status = 'completed') AS completed,
      SUM(l.status = 'failed') AS failed,
      ROUND(AVG(l.latency_ms)) AS avg_latency
    FROM request_logs l
    WHERE ${conditions}
    GROUP BY bucket_time
    ORDER BY bucket_time ASC
  `).all(bucketMs, bucketMs, ...params) as Array<{
    bucket_time: number;
    requests: number;
    completed: number;
    failed: number;
    avg_latency: number | null;
  }>;

  const timeSeries = timeSeriesRows.map((row) => {
    const d = new Date(row.bucket_time);
    let label = '';
    if (bucketMs < 3600_000) {
      label = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    } else if (bucketMs < 86_400_000) {
      label = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}h`;
    } else {
      label = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    const reqs = row.requests || 0;
    const comps = row.completed || 0;
    return {
      time: label,
      timestamp: row.bucket_time,
      requests: reqs,
      completed: comps,
      failed: row.failed || 0,
      success_rate: reqs > 0 ? Math.round((comps / reqs) * 1000) / 10 : 100,
      avg_latency: row.avg_latency || 0,
    };
  });

  const byProviderRows = db.prepare(`
    SELECT 
      COALESCE(l.provider, 'unrouted') AS provider,
      COUNT(l.id) AS requests,
      SUM(l.status = 'completed') AS completed,
      SUM(l.status = 'failed') AS failed,
      ROUND(AVG(l.latency_ms)) AS avg_latency
    FROM request_logs l
    WHERE ${conditions}
    GROUP BY l.provider
    ORDER BY requests DESC
  `).all(...params) as Array<{
    provider: string;
    requests: number;
    completed: number;
    failed: number;
    avg_latency: number | null;
  }>;

  const byProvider = byProviderRows.map((r) => ({
    provider: r.provider,
    requests: r.requests,
    completed: r.completed || 0,
    failed: r.failed || 0,
    success_rate: r.requests > 0 ? Math.round(((r.completed || 0) / r.requests) * 1000) / 10 : 100,
    avg_latency: r.avg_latency || 0,
  }));

  const byApiKeyRows = db.prepare(`
    SELECT 
      l.api_key_id,
      COALESCE(k.name, CASE WHEN l.kind = 'connection_test' THEN '🛠️ 控制台测试' ELSE '🌐 系统直接调用' END) AS key_name,
      COALESCE(k.key_prefix, '—') AS key_prefix,
      COALESCE(k.role, 'system') AS role,
      k.last_used_at,
      COUNT(l.id) AS requests,
      SUM(l.status = 'completed') AS completed,
      SUM(l.status = 'failed') AS failed,
      ROUND(AVG(l.latency_ms)) AS avg_latency
    FROM request_logs l
    LEFT JOIN api_keys k ON k.id = l.api_key_id
    WHERE ${conditions}
    GROUP BY l.api_key_id
    ORDER BY requests DESC
  `).all(...params) as Array<{
    api_key_id: string | null;
    key_name: string;
    key_prefix: string;
    role: string;
    last_used_at: number | null;
    requests: number;
    completed: number;
    failed: number;
    avg_latency: number | null;
  }>;

  const byApiKey = byApiKeyRows.map((r) => ({
    api_key_id: r.api_key_id,
    key_name: r.key_name,
    key_prefix: r.key_prefix,
    role: r.role,
    last_used_at: r.last_used_at,
    requests: r.requests,
    completed: r.completed || 0,
    failed: r.failed || 0,
    success_rate: r.requests > 0 ? Math.round(((r.completed || 0) / r.requests) * 1000) / 10 : 100,
    avg_latency: r.avg_latency || 0,
  }));

  const byAccountRows = db.prepare(`
    SELECT 
      l.account_id,
      COALESCE(a.name, '未分配 / 自动') AS account_name,
      COALESCE(l.provider, a.provider, 'unknown') AS provider,
      COALESCE(a.priority, 50) AS priority,
      COALESCE(a.status, 'ready') AS status,
      COUNT(l.id) AS requests,
      SUM(l.status = 'completed') AS completed,
      SUM(l.status = 'failed') AS failed,
      ROUND(AVG(l.latency_ms)) AS avg_latency
    FROM request_logs l
    LEFT JOIN provider_accounts a ON a.id = l.account_id
    WHERE ${conditions}
    GROUP BY l.account_id
    ORDER BY requests DESC
  `).all(...params) as Array<{
    account_id: string | null;
    account_name: string;
    provider: string;
    priority: number;
    status: string;
    requests: number;
    completed: number;
    failed: number;
    avg_latency: number | null;
  }>;

  const byAccount = byAccountRows.map((r) => ({
    account_id: r.account_id,
    account_name: r.account_name,
    provider: r.provider,
    priority: r.priority,
    status: r.status,
    requests: r.requests,
    completed: r.completed || 0,
    failed: r.failed || 0,
    success_rate: r.requests > 0 ? Math.round(((r.completed || 0) / r.requests) * 1000) / 10 : 100,
    avg_latency: r.avg_latency || 0,
  }));

  const byModelRows = db.prepare(`
    SELECT 
      COALESCE(l.model, 'unknown') AS model,
      COALESCE(l.provider, 'unknown') AS provider,
      COUNT(l.id) AS requests,
      SUM(l.status = 'completed') AS completed,
      SUM(l.status = 'failed') AS failed,
      ROUND(AVG(l.latency_ms)) AS avg_latency
    FROM request_logs l
    WHERE ${conditions}
    GROUP BY l.model
    ORDER BY requests DESC
  `).all(...params) as Array<{
    model: string;
    provider: string;
    requests: number;
    completed: number;
    failed: number;
    avg_latency: number | null;
  }>;

  const byModel = byModelRows.map((r) => ({
    model: r.model,
    provider: r.provider,
    requests: r.requests,
    completed: r.completed || 0,
    failed: r.failed || 0,
    success_rate: r.requests > 0 ? Math.round(((r.completed || 0) / r.requests) * 1000) / 10 : 100,
    avg_latency: r.avg_latency || 0,
  }));

  const filterOptions = {
    providers: ['chatgpt', 'kimi', 'deepseek', 'glm', 'qwen', 'jimeng'],
    apiKeys: db.prepare('SELECT id, name, key_prefix FROM api_keys ORDER BY created_at DESC').all() as Array<{ id: string; name: string; key_prefix: string }>,
    accounts: db.prepare('SELECT id, name, provider FROM provider_accounts ORDER BY provider, priority DESC').all() as Array<{ id: string; name: string; provider: string }>,
    models: db.prepare('SELECT DISTINCT public_model AS id, m.provider FROM routes r JOIN models m ON m.id = r.model_id ORDER BY public_model').all() as Array<{ id: string; provider: string }>,
  };

  return {
    timeRange,
    startTime,
    endTime,
    summary: {
      requests,
      completed,
      failed,
      success_rate,
      avg_latency: summaryRaw?.avg_latency || 0,
      min_latency: summaryRaw?.min_latency || 0,
      max_latency: summaryRaw?.max_latency || 0,
      p95_latency,
      image_count,
      active_keys: summaryRaw?.active_keys || 0,
      active_accounts: summaryRaw?.active_accounts || 0,
    },
    timeSeries,
    byProvider,
    byApiKey,
    byAccount,
    byModel,
    filterOptions,
  };
});

app.get('/api/logs/search', async (request) => {
  requireRole(request, ['owner', 'admin', 'operator', 'auditor']);
  const query = request.query as Record<string, string | undefined>;
  const { conditions, params } = buildLogFilters(query, 'l.');
  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(100, Math.max(10, Number(query.limit) || 30));
  const offset = (page - 1) * limit;

  const totalRaw = db.prepare(`SELECT COUNT(*) AS total FROM request_logs l WHERE ${conditions}`).get(...params) as { total: number };
  const total = totalRaw?.total || 0;

  const rows = db.prepare(`
    SELECT 
      l.*,
      a.name AS account_name,
      k.name AS api_key_name,
      k.key_prefix,
      (
        SELECT re.details_json 
        FROM request_events re 
        WHERE re.request_id = l.id AND re.event = 'request.sent' 
        ORDER BY re.id ASC 
        LIMIT 1
      ) AS sent_json,
      (
        SELECT re.details_json 
        FROM request_events re 
        WHERE re.request_id = l.id AND (re.event = 'upstream.message' OR re.event = 'upstream.reasoning')
        ORDER BY re.id DESC 
        LIMIT 1
      ) AS reply_json,
      (
        SELECT COUNT(*) 
        FROM request_events re 
        WHERE re.request_id = l.id
      ) AS events_count,
      (
        SELECT COUNT(*) 
        FROM request_events re 
        WHERE re.request_id = l.id AND re.event = 'upstream.image'
      ) AS image_events_count
    FROM request_logs l
    LEFT JOIN provider_accounts a ON a.id = l.account_id
    LEFT JOIN api_keys k ON k.id = l.api_key_id
    WHERE ${conditions}
    ORDER BY l.started_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as Array<{
    id: string;
    kind: string;
    api_key_id: string | null;
    account_id: string | null;
    provider: string | null;
    model: string | null;
    status: string;
    http_status: number | null;
    latency_ms: number | null;
    started_at: number;
    completed_at: number | null;
    account_name: string | null;
    api_key_name: string | null;
    key_prefix: string | null;
    sent_json: string | null;
    reply_json: string | null;
    events_count: number;
    image_events_count: number;
  }>;

  const items = rows.map((r) => {
    let promptPreview = '';
    let replyPreview = '';
    if (r.sent_json) {
      try {
        const sentData = JSON.parse(r.sent_json);
        if (Array.isArray(sentData.messages)) {
          const userMsg = [...sentData.messages].reverse().find((m: any) => m?.role === 'user');
          if (userMsg && userMsg.content) {
            promptPreview = typeof userMsg.content === 'string' ? userMsg.content : JSON.stringify(userMsg.content);
          }
        }
      } catch {}
    }
    if (r.reply_json) {
      try {
        const replyData = JSON.parse(r.reply_json);
        if (replyData.content) {
          replyPreview = typeof replyData.content === 'string' ? replyData.content : JSON.stringify(replyData.content);
        }
      } catch {}
    }

    return {
      id: r.id,
      kind: r.kind,
      provider: r.provider,
      model: r.model,
      status: r.status,
      http_status: r.http_status,
      latency_ms: r.latency_ms,
      started_at: r.started_at,
      completed_at: r.completed_at,
      account_id: r.account_id,
      account_name: r.account_name,
      api_key_id: r.api_key_id,
      api_key_name: r.api_key_name,
      key_prefix: r.key_prefix,
      prompt_preview: promptPreview ? promptPreview.slice(0, 120) : '',
      reply_preview: replyPreview ? replyPreview.slice(0, 120) : '',
      events_count: r.events_count,
      has_images: r.image_events_count > 0,
    };
  });

  return { total, page, limit, items };
});

app.get('/api/logs/:requestId/detail', async (request) => {
  requireRole(request, ['owner', 'admin', 'operator', 'auditor']);
  const { requestId } = request.params as { requestId: string };
  const log = db.prepare(`
    SELECT l.*, a.name AS account_name, a.priority AS account_priority, a.status AS account_status,
           k.name AS api_key_name, k.key_prefix, k.role AS api_key_role
    FROM request_logs l
    LEFT JOIN provider_accounts a ON a.id = l.account_id
    LEFT JOIN api_keys k ON k.id = l.api_key_id
    WHERE l.id = ?
  `).get(requestId) as any;

  if (!log) throw Object.assign(new Error('Log not found'), { statusCode: 404 });

  const rawEvents = db.prepare(`
    SELECT id, request_id, at, level, event, message, details_json
    FROM request_events
    WHERE request_id = ?
    ORDER BY id ASC
  `).all(requestId) as Array<{
    id: number;
    request_id: string;
    at: number;
    level: string;
    event: string;
    message: string;
    details_json: string;
  }>;

  let promptMessages: any[] = [];
  let assistantReply = '';
  let reasoning = '';
  const citations: any[] = [];
  const images: string[] = [];
  let failureError = '';

  const events = rawEvents.map((evt) => {
    let details: Record<string, unknown> | undefined;
    try {
      details = JSON.parse(evt.details_json);
    } catch {}

    if (evt.event === 'request.sent' && details && Array.isArray(details.messages)) {
      promptMessages = details.messages;
    }
    if (evt.event === 'upstream.message' && details && typeof details.content === 'string') {
      assistantReply = details.content;
    }
    if (evt.event === 'upstream.reasoning' && details && typeof details.content === 'string') {
      reasoning = details.content;
    }
    if (evt.event === 'upstream.citation' && details) {
      citations.push(details);
    }
    if (evt.event === 'upstream.image' && details) {
      if (typeof details.url === 'string') images.push(details.url);
      else if (typeof details.media_url === 'string') images.push(details.media_url);
    }
    if (evt.level === 'error') {
      failureError = evt.message || (details && typeof details.error === 'string' ? String(details.error) : '');
    }

    return {
      id: evt.id,
      request_id: evt.request_id,
      at: evt.at,
      level: evt.level,
      event: evt.event,
      message: evt.message,
      details,
    };
  });

  return {
    log,
    events,
    promptMessages,
    assistantReply,
    reasoning,
    citations,
    images,
    failureError,
  };
});
app.get('/api/image-logs', async (request) => {
  requireRole(request, ['owner', 'admin', 'operator', 'auditor']);
  const rows = db.prepare(`
    SELECT 
      e.id AS event_id,
      e.at,
      e.details_json,
      l.id AS request_id,
      l.kind,
      l.provider,
      l.model,
      l.status,
      l.latency_ms,
      l.started_at,
      a.name AS account_name,
      k.name AS api_key_name,
      k.key_prefix,
      (
        SELECT re.details_json 
        FROM request_events re 
        WHERE re.request_id = l.id AND re.event = 'request.sent' 
        ORDER BY re.id ASC 
        LIMIT 1
      ) AS sent_details_json
    FROM request_events e
    JOIN request_logs l ON l.id = e.request_id
    LEFT JOIN provider_accounts a ON a.id = l.account_id
    LEFT JOIN api_keys k ON k.id = l.api_key_id
    WHERE e.event = 'upstream.image'
    ORDER BY e.at DESC
    LIMIT 300
  `).all() as Array<{
    event_id: number;
    at: number;
    details_json: string;
    request_id: string;
    kind: string;
    provider: string | null;
    model: string | null;
    status: string;
    latency_ms: number | null;
    started_at: number;
    account_name: string | null;
    api_key_name: string | null;
    key_prefix: string | null;
    sent_details_json: string | null;
  }>;

  return rows.map((row) => {
    let imageUrl = '';
    try {
      const parsed = JSON.parse(row.details_json) as { url?: string };
      imageUrl = parsed.url || '';
    } catch {}

    let prompt = '';
    if (row.sent_details_json) {
      try {
        const sent = JSON.parse(row.sent_details_json) as { messages?: Array<{ role?: string; content?: unknown }> };
        if (Array.isArray(sent.messages)) {
          const userMsg = [...sent.messages].reverse().find(m => m.role === 'user') ?? sent.messages.at(-1);
          if (userMsg && userMsg.content) {
            prompt = typeof userMsg.content === 'string' ? userMsg.content : JSON.stringify(userMsg.content);
          }
        }
      } catch {}
    }

    return {
      id: `img_${row.event_id}`,
      url: imageUrl,
      prompt,
      model: row.model ?? 'image-gen',
      provider: row.provider ?? 'unknown',
      kind: row.kind,
      status: row.status,
      latency_ms: row.latency_ms,
      created_at: row.at,
      request_id: row.request_id,
      account_name: row.account_name,
      api_key_name: row.api_key_name,
      key_prefix: row.key_prefix
    };
  });
});
app.get('/api/logs', async (request) => { requireRole(request, ['owner', 'admin', 'operator', 'auditor']); return db.prepare('SELECT l.*, a.name AS account_name, k.name AS api_key_name FROM request_logs l LEFT JOIN provider_accounts a ON a.id = l.account_id LEFT JOIN api_keys k ON k.id = l.api_key_id ORDER BY l.started_at DESC LIMIT 200').all(); });
app.get('/api/logs/:requestId/events', async (request) => { requireRole(request, ['owner', 'admin', 'operator', 'auditor']); const { requestId } = request.params as { requestId: string }; return db.prepare('SELECT id, at, level, event, message, details_json FROM request_events WHERE request_id = ? ORDER BY id').all(requestId); });
app.get('/api/logs/live', async (request, reply) => {
  requireRole(request, ['owner', 'admin', 'operator', 'auditor']);
  reply.hijack();
  const origin = (request.headers.origin as string | undefined) || '*';
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-session-id, x-admin-token, x-api-key',
  });
  const stop = onEvent((item) => reply.raw.write(`data: ${JSON.stringify(item)}\n\n`));
  request.raw.on('close', stop);
});
app.post('/api/connection-test', async (request, reply) => {
  requireRole(request, ['owner', 'admin', 'operator']); const body = chatRequest.extend({ accountId: z.string().optional() }).parse(request.body);
  return streamChat(body, reply, { kind: 'connection_test', accountId: body.accountId });
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const adminDistPath = resolve(__dirname, '../../../apps/admin/dist');
const altAdminDistPath = resolve(__dirname, '../../admin/dist');
const effectiveAdminDist = existsSync(adminDistPath) ? adminDistPath : existsSync(altAdminDistPath) ? altAdminDistPath : null;

if (effectiveAdminDist) {
  app.get('/*', async (request, reply) => {
    const rawUrl = request.raw.url || '/';
    const cleanPath = rawUrl.split('?')[0];
    if (cleanPath.startsWith('/api') || cleanPath.startsWith('/v1') || cleanPath.startsWith('/media') || cleanPath === '/health') {
      return reply.status(404).send({ error: { message: 'Not found', code: 404 } });
    }
    const relativePath = cleanPath.startsWith('/') ? cleanPath.slice(1) : cleanPath;
    const targetFile = join(effectiveAdminDist, relativePath);
    if (relativePath && existsSync(targetFile) && statSync(targetFile).isFile()) {
      const ext = relativePath.split('.').pop()?.toLowerCase() || '';
      const mimeMap: Record<string, string> = {
        html: 'text/html; charset=utf-8',
        js: 'application/javascript; charset=utf-8',
        css: 'text/css; charset=utf-8',
        svg: 'image/svg+xml',
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        webp: 'image/webp',
        ico: 'image/x-icon',
        json: 'application/json',
        woff: 'font/woff',
        woff2: 'font/woff2'
      };
      reply.header('Content-Type', mimeMap[ext] || 'application/octet-stream');
      return reply.send(readFileSync(targetFile));
    }
    const indexFile = join(effectiveAdminDist, 'index.html');
    if (existsSync(indexFile)) {
      reply.header('Content-Type', 'text/html; charset=utf-8');
      return reply.send(readFileSync(indexFile));
    }
    return reply.status(404).send('Admin UI not built');
  });
}

await app.listen({ host: config.host, port: config.port });
