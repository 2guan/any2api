import { leaseAccount, releaseAccount, type Account } from './accounts.js';
import { db } from './db.js';
import { beginRequest, event, finishRequest } from './events.js';
import { providers } from './providers/registry.js';
import type { ProviderEvent } from './providers/types.js';

export type GatewayRequest = { model: string; messages: Array<{ role: string; content: unknown }>; stream: boolean; reasoning?: { effort?: string }; webSearch?: boolean };

function route(model: string) {
  return db.prepare(`SELECT m.provider, m.upstream_id FROM routes r JOIN models m ON m.id = r.model_id
    WHERE r.public_model = ? AND r.enabled = 1 AND m.enabled = 1`).get(model) as { provider: string; upstream_id: string } | undefined;
}

function sanitizeMessagesForLog(messages: unknown): unknown {
  if (!Array.isArray(messages)) return messages;
  return messages.map((msg) => {
    if (!msg || typeof msg !== 'object') return msg;
    const role = (msg as { role?: string }).role;
    const content = (msg as { content?: unknown }).content;
    if (typeof content === 'string') {
      if (content.length > 300 && (content.includes('base64,') || content.includes('imageurl') || content.includes('image_url'))) {
        return { role, content: content.replace(/data:image\/[a-zA-Z0-9+.-]+;base64,[a-zA-Z0-9+/=]+/g, '[base64 image]') };
      }
      return { role, content };
    }
    if (Array.isArray(content)) {
      const sanitized = content.map((item) => {
        if (!item || typeof item !== 'object') return item;
        const obj = { ...item } as Record<string, any>;
        if (obj.image_url && typeof obj.image_url === 'object' && obj.image_url.url?.startsWith('data:')) {
          obj.image_url = { ...obj.image_url, url: `[base64 image (${obj.image_url.url.length} chars)]` };
        }
        if (obj.imageurl && typeof obj.imageurl === 'object' && obj.imageurl.url?.startsWith('data:')) {
          obj.imageurl = { ...obj.imageurl, url: `[base64 image (${obj.imageurl.url.length} chars)]` };
        }
        if (typeof obj.image_url === 'string' && obj.image_url.startsWith('data:')) {
          obj.image_url = `[base64 image (${obj.image_url.length} chars)]`;
        }
        if (typeof obj.imageurl === 'string' && obj.imageurl.startsWith('data:')) {
          obj.imageurl = `[base64 image (${obj.imageurl.length} chars)]`;
        }
        return obj;
      });
      return { role, content: sanitized };
    }
    return msg;
  });
}

export async function* execute(request: GatewayRequest, options: { kind: 'api' | 'connection_test'; accountId?: string; apiKeyId?: string }) {
  const target = route(request.model);
  if (!target) throw Object.assign(new Error(`Model '${request.model}' is unavailable`), { statusCode: 404 });
  const account = options.accountId
    ? db.prepare(`SELECT * FROM provider_accounts WHERE id = ? AND provider = ? AND status = 'ready'`).get(options.accountId, target.provider) as Account | undefined
    : leaseAccount(target.provider);
  if (!account) {
    const configured = db.prepare('SELECT COUNT(*) AS value FROM provider_accounts WHERE provider = ?').get(target.provider) as { value: number };
    const message = configured.value ? `No verified ${target.provider} account is available; run account verification or re-authorize the saved credentials` : `No ${target.provider} account is configured`;
    throw Object.assign(new Error(message), { statusCode: 503 });
  }
  const requestId = beginRequest({ kind: options.kind, apiKeyId: options.apiKeyId, accountId: account.id, provider: target.provider, model: request.model });
  const started = Date.now();
  event(requestId, 'info', 'request.routed', 'Request routed to an eligible account', { provider: target.provider, accountId: account.id, model: target.upstream_id });
  event(requestId, 'info', 'request.sent', 'Sent message to upstream', { model: target.upstream_id, messages: sanitizeMessagesForLog(request.messages) });
  let messageContent = '';
  let reasoningContent = '';
  let summaryWritten = false;
  const writeResponseSummary = () => {
    if (summaryWritten) return;
    summaryWritten = true;
    if (messageContent) event(requestId, 'info', 'upstream.message', 'Received assistant message', { content: messageContent, chars: messageContent.length });
    if (reasoningContent) event(requestId, 'info', 'upstream.reasoning', 'Received reasoning summary', { content: reasoningContent, chars: reasoningContent.length });
  };
  try {
    const adapter = providers.get(target.provider);
    if (!adapter) throw new Error(`No adapter registered for ${target.provider}`);
    for await (const item of adapter.streamTurn({ ...request, model: target.upstream_id }, account)) {
      if (item.type === 'message.delta') messageContent += item.text;
      if (item.type === 'reasoning.summary.delta') reasoningContent += item.text;
      if (item.type === 'search.citation') event(requestId, 'info', 'upstream.citation', 'Received web citation', { url: item.url, title: item.title });
      if (item.type === 'image.created') event(requestId, 'info', 'upstream.image', 'Received generated image', { url: item.url });
      yield { requestId, item } as { requestId: string; item: ProviderEvent };
    }
    writeResponseSummary();
    finishRequest(requestId, 'completed', 200);
    releaseAccount(account.id, true, Date.now() - started, 200);
    event(requestId, 'info', 'request.completed', 'Request completed', { latencyMs: Date.now() - started });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown provider error';
    const errStatusCode = (error as { statusCode?: number }).statusCode ?? 502;
    writeResponseSummary();
    finishRequest(requestId, 'failed', errStatusCode);
    releaseAccount(account.id, false, Date.now() - started, errStatusCode);
    event(requestId, 'error', 'request.failed', message);
    throw Object.assign(new Error(message), { requestId, statusCode: errStatusCode });
  }
}
