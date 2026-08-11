import { credentialsFor, saveCredentials } from '../credentials.js';
import type { Account } from '../accounts.js';
import type { ProviderAdapter, ProviderEvent, ProviderRequest } from './types.js';

type TokenState = { accessToken: string; expiresAt: number };

function textOf(content: unknown) { return typeof content === 'string' ? content : JSON.stringify(content); }

function webModel(model: string) {
  const name = model.toLowerCase();
  if (name.includes('fast')) return 'kimi';
  if (name.includes('k2')) return 'k2';
  return 'k1.5-thinking';
}

export class KimiAdapter implements ProviderAdapter {
  readonly provider = 'kimi';
  private tokens = new Map<string, TokenState>();

  async testConnection(account: Account) {
    try { await this.accessToken(account); return { ok: true, detail: 'Refresh Token verification succeeded' }; }
    catch (error) { return { ok: false, detail: error instanceof Error ? error.message : 'Kimi verification failed' }; }
  }

  async refreshCredentials(account: Account) { await this.accessToken(account); }

  async *discoverModels(_account: Account) {
    // The web picker changes independently; the verified web defaults seed the catalog.
    return;
  }

  async *streamTurn(request: ProviderRequest, account: Account): AsyncIterable<ProviderEvent> {
    const token = await this.accessToken(account);
    const credentials = credentialsFor(account.id); let chatId = credentials.kimi_chat_id;
    if (!chatId) {
      const session = await fetch('https://kimi.moonshot.cn/api/chat', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ name: 'Any2API session', is_example: false }) });
      if (!session.ok) throw new Error(`Kimi session creation failed (${session.status})`);
      const createdId = (await session.json() as { id?: string }).id;
      if (createdId) { chatId = createdId; saveCredentials(account.id, { ...credentials, kimi_chat_id: createdId }); }
    }
    if (!chatId) throw new Error('Kimi did not return a chat session');
    const model = webModel(request.model);
    const defaultEnhancedMode = /k3|k2\.6/i.test(request.model);
    const response = await fetch(`https://kimi.moonshot.cn/api/chat/${chatId}/completion/stream`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ messages: [{ role: 'user', content: requestText(request.messages) }], model, use_search: request.webSearch ?? defaultEnhancedMode, use_k1: defaultEnhancedMode && request.reasoning?.effort !== 'off', refs: [] })
    });
    if (!response.ok || !response.body) throw new Error(`Kimi completion failed (${response.status}): ${(await response.text()).slice(0, 240)}`);
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let zone = 'normal';
    while (true) {
      const { done, value } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n'); buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue; const raw = line.slice(6).trim(); if (!raw || raw === '[DONE]') continue;
        try {
          const item = JSON.parse(raw) as { event?: string; zone_type?: string; text?: string; text_delta?: string; content?: string; msg?: { title?: string; url?: string } };
          if (item.event === 'zone_set' && item.zone_type) zone = item.zone_type;
          if (item.event === 'search_plus' && item.msg?.url) yield { type: 'search.citation', title: item.msg.title ?? '', url: item.msg.url };
          const text = item.text ?? item.text_delta ?? item.content ?? '';
          if (!text) continue;
          if (item.event === 'think' || item.event === 'k1' || zone === 'thought' || zone === 'thinking') yield { type: 'reasoning.summary.delta', text };
          else if (item.event === 'cmpl' || item.event === 'resp') yield { type: 'message.delta', text };
        } catch { /* Ignore non-JSON SSE keepalives. */ }
      }
    }
    yield { type: 'completed' };
  }

  private async accessToken(account: Account) {
    const cached = this.tokens.get(account.id); if (cached && cached.expiresAt > Date.now()) return cached.accessToken;
    const credentials = credentialsFor(account.id); const refreshToken = credentials.refresh_token;
    if (!refreshToken) throw new Error('Kimi requires a Refresh Token for automatic verification');
    const response = await fetch('https://kimi.moonshot.cn/api/auth/token/refresh', { headers: { authorization: `Bearer ${refreshToken}` } });
    if (!response.ok) throw new Error(`Kimi Refresh Token was rejected (${response.status})`);
    const data = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (!data.access_token) throw new Error('Kimi did not return an Access Token');
    if (data.refresh_token && data.refresh_token !== refreshToken) saveCredentials(account.id, { ...credentials, refresh_token: data.refresh_token });
    const accessToken = data.access_token; this.tokens.set(account.id, { accessToken, expiresAt: Date.now() + Math.max(60, data.expires_in ?? 900) * 1000 - 30_000 });
    return accessToken;
  }
}

function requestText(messages: ProviderRequest['messages']) { return messages.map((message) => `${message.role}: ${textOf(message.content)}`).join('\n'); }
