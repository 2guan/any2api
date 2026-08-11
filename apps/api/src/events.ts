import { EventEmitter } from 'node:events';
import { db, id } from './db.js';

export type RequestLog = {
  id?: string; kind: 'api' | 'connection_test'; apiKeyId?: string; accountId?: string;
  provider?: string; model?: string; status?: 'running' | 'completed' | 'failed'; httpStatus?: number;
};

export type RequestEvent = { requestId: string; at: number; level: 'debug' | 'info' | 'warn' | 'error'; event: string; message: string; details: Record<string, unknown> };

const emitter = new EventEmitter();
emitter.setMaxListeners(200);

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key,
    /token|cookie|authorization|password|secret|code_verifier/i.test(key) ? '[REDACTED]' : redact(item)
  ]));
}

export function beginRequest(input: RequestLog) {
  const requestId = input.id || id('req');
  db.prepare(`INSERT INTO request_logs (id, kind, api_key_id, account_id, provider, model, status, http_status, started_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(requestId, input.kind, input.apiKeyId ?? null, input.accountId ?? null, input.provider ?? null, input.model ?? null, 'running', input.httpStatus ?? null, Date.now());
  return requestId;
}

export function event(requestId: string, level: RequestEvent['level'], name: string, message: string, details: Record<string, unknown> = {}) {
  const item: RequestEvent = { requestId, at: Date.now(), level, event: name, message, details: redact(details) as Record<string, unknown> };
  db.prepare('INSERT INTO request_events (request_id, at, level, event, message, details_json) VALUES (?, ?, ?, ?, ?, ?)')
    .run(item.requestId, item.at, item.level, item.event, item.message, JSON.stringify(item.details));
  emitter.emit('event', item);
  return item;
}

export function finishRequest(requestId: string, status: 'completed' | 'failed', httpStatus: number) {
  db.prepare('UPDATE request_logs SET status = ?, http_status = ?, completed_at = ?, latency_ms = ? WHERE id = ?')
    .run(status, httpStatus, Date.now(), db.prepare('SELECT ? - started_at AS value FROM request_logs WHERE id = ?').get(Date.now(), requestId)?.value ?? null, requestId);
}

export function onEvent(listener: (item: RequestEvent) => void) { emitter.on('event', listener); return () => emitter.off('event', listener); }
