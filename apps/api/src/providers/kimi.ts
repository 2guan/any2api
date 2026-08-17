import { credentialsFor, saveCredentials } from '../credentials.js';
import type { Account } from '../accounts.js';
import type { ProviderAdapter, ProviderEvent, ProviderRequest } from './types.js';

type TokenState = { accessToken: string; expiresAt: number };

function parseJWTPayload(jwtToken: string): Record<string, unknown> | null {
  if (!jwtToken || typeof jwtToken !== 'string' || !jwtToken.startsWith('eyJ')) return null;
  try {
    const parts = jwtToken.split('.');
    if (parts.length < 2) return null;
    let base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4 !== 0) base64 += '=';
    return JSON.parse(Buffer.from(base64, 'base64').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function textOf(content: unknown) {
  return typeof content === 'string' ? content : JSON.stringify(content);
}

function webModel(model: string) {
  const name = model.toLowerCase();
  if (name.includes('fast') || name === 'kimi') return 'kimi';
  if (name.includes('k2')) return 'k2';
  if (name.includes('k3') || name.includes('k1.5') || name.includes('thinking') || name.includes('agent')) return 'k1.5-thinking';
  if (name.includes('k1') || name.includes('vision') || name.includes('preview')) return 'k1.5';
  return 'k1.5-thinking';
}

function requestText(messages: ProviderRequest['messages']) {
  return messages.map((message) => `${message.role}: ${textOf(message.content)}`).join('\n');
}

export class KimiAdapter implements ProviderAdapter {
  readonly provider = 'kimi';
  private tokens = new Map<string, TokenState>();

  async testConnection(account: Account) {
    try {
      await this.accessToken(account);
      return { ok: true, detail: 'Kimi Token 凭据校验成功' };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : 'Kimi 凭据校验失败' };
    }
  }

  async refreshCredentials(account: Account) {
    await this.accessToken(account);
  }

  async *discoverModels(_account: Account) {
    return;
  }

  async *streamTurn(request: ProviderRequest, account: Account): AsyncIterable<ProviderEvent> {
    const token = await this.accessToken(account);
    const credentials = credentialsFor(account.id);
    let chatId = credentials.kimi_chat_id;

    if (!chatId) {
      const session = await fetch('https://kimi.moonshot.cn/api/chat', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36'
        },
        body: JSON.stringify({ name: 'Any2API session', is_example: false })
      });
      if (!session.ok) throw new Error(`Kimi 会话创建失败 (${session.status})`);
      const createdId = (await session.json() as { id?: string }).id;
      if (createdId) {
        chatId = createdId;
        saveCredentials(account.id, { ...credentials, kimi_chat_id: createdId });
      }
    }

    if (!chatId) throw new Error('Kimi 未能返回有效会话 ID');

    const model = webModel(request.model);
    const defaultEnhancedMode = /k3|k2\.6|k1\.5|thinking|agent/i.test(request.model);

    let reasoningEffort = 'medium';
    if (request.reasoning?.effort) {
      const effort = request.reasoning.effort.toLowerCase();
      if (effort === 'low' || effort === 'minimal') reasoningEffort = 'low';
      else if (effort === 'high') reasoningEffort = 'high';
      else if (effort === 'xhigh' || effort === 'max') reasoningEffort = 'max';
    }

    const payload: Record<string, unknown> = {
      messages: [{ role: 'user', content: requestText(request.messages) }],
      model,
      use_search: request.webSearch ?? true,
      use_k1: defaultEnhancedMode && request.reasoning?.effort !== 'off',
      reasoning_effort: reasoningEffort,
      refs: []
    };

    if (/swarm|cluster|agent/i.test(request.model)) {
      payload.scenario = 'AUTOMATION_K3';
    }

    let response: Response | null = null;
    let attempts = 0;
    const maxAttempts = 3;
    let isDegraded = false;

    while (attempts < maxAttempts) {
      attempts++;
      try {
        response = await fetch(`https://kimi.moonshot.cn/api/chat/${chatId}/completion/stream`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36'
          },
          body: JSON.stringify(payload)
        });

        if (response.ok) break;

        const errText = await response.text().catch(() => '');

        // 1. 会话冲突 (user_stream_pushing / 发送频率过高)：自动新建独立会话重试
        if (errText.includes('user_stream_pushing') || errText.includes('发送频率过高')) {
          try {
            const newSession = await fetch('https://kimi.moonshot.cn/api/chat', {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${token}`,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
              },
              body: JSON.stringify({ name: 'Any2API auto-fallback', is_example: false })
            });
            if (newSession.ok) {
              const created = (await newSession.json() as { id?: string }).id;
              if (created) {
                chatId = created;
                saveCredentials(account.id, { ...credentials, kimi_chat_id: created });
              }
            }
          } catch {}
          await new Promise((r) => setTimeout(r, 1200));
          continue;
        }

        // 2. 高峰期繁忙 / 限流 (429 / 503 / 500 / busy / overload)：自动平滑降级到快速模型 (kimi)
        if ((response.status === 429 || response.status >= 500 || errText.includes('busy') || errText.includes('人数过多') || errText.includes('繁忙')) && payload.model !== 'kimi') {
          payload.model = 'kimi';
          payload.use_k1 = false;
          delete payload.reasoning_effort;
          delete payload.scenario;
          isDegraded = true;
          await new Promise((r) => setTimeout(r, 800));
          continue;
        }

        if (attempts >= maxAttempts) {
          throw new Error(`Kimi 请求失败 (${response.status}): ${errText.slice(0, 200)}`);
        }
      } catch (err) {
        if (attempts >= maxAttempts) throw err;
      }
    }

    if (!response || !response.ok || !response.body) {
      throw new Error(`Kimi 响应流建立失败`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let zone = 'normal';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (!raw || raw === '[DONE]') continue;

        try {
          const item = JSON.parse(raw) as {
            event?: string;
            zone_type?: string;
            text?: string;
            text_delta?: string;
            content?: string;
            msg?: { title?: string; url?: string; site_name?: string; type?: string };
          };

          if (item.event === 'zone_set' && item.zone_type) zone = item.zone_type;

          if (item.event === 'search_plus' && item.msg?.url) {
            yield {
              type: 'search.citation',
              title: item.msg.title || item.msg.site_name || '',
              url: item.msg.url
            };
          }

          const text = item.text ?? item.text_delta ?? item.content ?? '';
          if (!text) continue;

          if (item.event === 'think' || item.event === 'k1' || zone === 'thought' || zone === 'thinking') {
            yield { type: 'reasoning.summary.delta', text };
          } else if (item.event === 'cmpl' || item.event === 'resp') {
            yield { type: 'message.delta', text };
          }
        } catch {
          /* Ignore parsing errors on keepalive ping lines */
        }
      }
    }
    yield { type: 'completed' };
  }

  private async accessToken(account: Account): Promise<string> {
    const cached = this.tokens.get(account.id);
    if (cached && cached.expiresAt > Date.now()) return cached.accessToken;

    const credentials = credentialsFor(account.id);
    let rawToken = (credentials.token ?? credentials.access_token ?? credentials.refresh_token ?? credentials.cookie ?? '').trim();

    if (rawToken.startsWith('{')) {
      try {
        const parsed = JSON.parse(rawToken) as { refresh_token?: string; access_token?: string; token?: string };
        if (parsed.refresh_token) rawToken = parsed.refresh_token;
        else if (parsed.access_token) rawToken = parsed.access_token;
        else if (parsed.token) rawToken = parsed.token;
      } catch {}
    }

    if (rawToken.includes('=')) {
      const match = rawToken.match(/(?:refresh_token|k_refresh_token|access_token|k_access_token|token)=([^;]+)/i);
      if (match && match[1]) rawToken = match[1].trim();
    }

    const cleanToken = rawToken.replace(/^Bearer\s+/i, '').trim();
    if (!cleanToken) {
      throw new Error('未配置 Kimi 凭据，请在【使用指南】中查看如何复制 Authorization Token 并录入账号池');
    }

    // 1. 尝试使用该 Token 换取新令牌（如果该 Token 是 Refresh Token）
    try {
      const response = await fetch('https://kimi.moonshot.cn/api/auth/token/refresh', {
        headers: {
          authorization: `Bearer ${cleanToken}`,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36'
        }
      });

      if (response.ok) {
        const data = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
        if (data.access_token) {
          if (data.refresh_token && data.refresh_token !== cleanToken) {
            saveCredentials(account.id, { ...credentials, refresh_token: data.refresh_token, token: data.refresh_token });
          }
          const accessToken = data.access_token;
          this.tokens.set(account.id, {
            accessToken,
            expiresAt: Date.now() + Math.max(60, data.expires_in ?? 900) * 1000 - 30_000
          });
          return accessToken;
        }
      }
    } catch {}

    // 2. 如果刷新失败，检查该 Token 是否本身就是有效的 Access Token (JWT)
    const payload = parseJWTPayload(cleanToken);
    if (payload && typeof payload.exp === 'number') {
      const expMs = payload.exp < 10000000000 ? payload.exp * 1000 : payload.exp;
      if (Date.now() < expMs - 30_000) {
        this.tokens.set(account.id, {
          accessToken: cleanToken,
          expiresAt: expMs - 30_000
        });
        return cleanToken;
      }
      throw new Error('Kimi Authorization Token 已过期，请在网页端 F12 重新复制最新的 Authorization 令牌');
    }

    // 3. 兜底直接使用该 Token
    this.tokens.set(account.id, {
      accessToken: cleanToken,
      expiresAt: Date.now() + 600 * 1000
    });
    return cleanToken;
  }
}
