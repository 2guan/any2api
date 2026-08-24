import { credentialsFor, saveCredentials } from '../credentials.js';
import type { Account } from '../accounts.js';
import type { ProviderAdapter, ProviderEvent, ProviderRequest } from './types.js';

type TokenState = { accessToken: string; refreshToken?: string; expiresAt: number };

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

function isJWTExpired(jwtToken: string, bufferMs = 30_000): boolean {
  const payload = parseJWTPayload(jwtToken);
  if (!payload || typeof payload.exp !== 'number') return false;
  const expMs = payload.exp < 10000000000 ? payload.exp * 1000 : payload.exp;
  return Date.now() >= expMs - bufferMs;
}

function extractTokenValue(raw: string | undefined): string {
  if (!raw || typeof raw !== 'string') return '';
  let token = raw.trim();
  if (token.startsWith('{')) {
    try {
      const parsed = JSON.parse(token) as { refresh_token?: string; access_token?: string; token?: string };
      token = parsed.refresh_token || parsed.access_token || parsed.token || token;
    } catch {}
  }
  if (token.includes('=')) {
    const match = token.match(/(?:refresh_token|k_refresh_token|access_token|k_access_token|token)=([^;]+)/i);
    if (match && match[1]) token = match[1].trim();
  }
  return token.replace(/^Bearer\s+/i, '').replace(/^"|"$/g, '').trim();
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

  private resolveCredentialsTokens(credentials: Record<string, string>) {
    let accessToken = extractTokenValue(credentials.access_token || credentials.token);
    let refreshToken = extractTokenValue(credentials.refresh_token);

    // If user pasted full cookie string in any field
    for (const val of Object.values(credentials)) {
      if (typeof val === 'string' && val.includes('=')) {
        const matchRefresh = val.match(/(?:k_refresh_token|refresh_token)=([^;]+)/i);
        if (matchRefresh && matchRefresh[1]) refreshToken = matchRefresh[1].trim();
        const matchAccess = val.match(/(?:k_access_token|access_token)=([^;]+)/i);
        if (matchAccess && matchAccess[1]) accessToken = matchAccess[1].trim();
      }
    }

    // If the token in accessToken is actually a refresh token (typ: 'refresh')
    const accessPayload = parseJWTPayload(accessToken);
    if (accessPayload && (accessPayload as { typ?: string }).typ === 'refresh') {
      if (!refreshToken) refreshToken = accessToken;
      accessToken = '';
    }

    // If the token in refreshToken is actually an access token (typ: 'access')
    const refreshPayload = parseJWTPayload(refreshToken);
    if (refreshPayload && (refreshPayload as { typ?: string }).typ === 'access') {
      if (!accessToken) accessToken = refreshToken;
      refreshToken = '';
    }

    return { accessToken, refreshToken };
  }

  async refreshAccessToken(account: Account, customRefreshToken?: string): Promise<string> {
    const credentials = credentialsFor(account.id);
    const { refreshToken: resolvedRefresh } = this.resolveCredentialsTokens(credentials);
    const refreshToken = customRefreshToken || resolvedRefresh;

    if (!refreshToken) {
      throw new Error('未配置 Kimi Refresh Token，无法自动续签。请在【账号池】录入 Refresh Token（有效期长达数月）');
    }

    const response = await fetch('https://kimi.moonshot.cn/api/auth/token/refresh', {
      method: 'GET',
      headers: {
        authorization: `Bearer ${refreshToken}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36'
      }
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`Kimi Refresh Token 续签失败 (${response.status}): ${errText.slice(0, 150)}`);
    }

    const data = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (!data.access_token) {
      throw new Error('Kimi 未能返回有效的 Access Token');
    }

    const newAccessToken = data.access_token;
    const newRefreshToken = data.refresh_token || refreshToken;
    const expiresIn = Math.max(60, data.expires_in ?? 900);
    const expiresAt = Date.now() + expiresIn * 1000 - 60_000;

    // 持久化存储到数据库
    saveCredentials(account.id, {
      ...credentials,
      token: newAccessToken,
      access_token: newAccessToken,
      refresh_token: newRefreshToken
    });

    // 更新内存缓存
    this.tokens.set(account.id, {
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      expiresAt
    });

    return newAccessToken;
  }

  async accessToken(account: Account, forceRefresh = false): Promise<string> {
    const cached = this.tokens.get(account.id);
    if (!forceRefresh && cached && cached.accessToken && Date.now() < cached.expiresAt) {
      return cached.accessToken;
    }

    const credentials = credentialsFor(account.id);
    const { accessToken, refreshToken } = this.resolveCredentialsTokens(credentials);

    // 1. 如果已有有效的 Access Token 且未强制刷新
    if (!forceRefresh && accessToken && !isJWTExpired(accessToken, 60_000)) {
      const payload = parseJWTPayload(accessToken);
      const expSec = (payload?.exp as number) || (Math.floor(Date.now() / 1000) + 900);
      const expiresAt = expSec < 10000000000 ? expSec * 1000 - 60_000 : expSec - 60_000;

      this.tokens.set(account.id, {
        accessToken,
        refreshToken,
        expiresAt
      });
      return accessToken;
    }

    // 2. 如果配置了 Refresh Token，调用接口自动刷新
    if (refreshToken) {
      try {
        return await this.refreshAccessToken(account, refreshToken);
      } catch (err) {
        if (accessToken && !isJWTExpired(accessToken, 5_000)) {
          return accessToken;
        }
        throw err;
      }
    }

    // 3. 只有 Access Token 且已过期
    if (accessToken) {
      if (isJWTExpired(accessToken)) {
        throw new Error('Kimi Authorization Token 已过期（通常仅 15 分钟有效）。强烈建议在【账号池】录入 Refresh Token（有效期长达数月），系统将永久自动续签！可在网页控制台执行：localStorage.getItem("refresh_token") 获取。');
      }
      return accessToken;
    }

    throw new Error('未配置 Kimi 凭据，请在【使用指南】中查看如何复制 Refresh Token 并录入账号池');
  }

  async testConnection(account: Account) {
    try {
      const credentials = credentialsFor(account.id);
      const { refreshToken } = this.resolveCredentialsTokens(credentials);
      await this.accessToken(account);
      const detail = refreshToken
        ? 'Kimi 凭据校验成功（已启用 Refresh Token 长期自动静默续签）'
        : 'Kimi Access Token 校验成功（建议在账号池填入 Refresh Token 以实现长效免维护自动续签）';
      return { ok: true, detail };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : 'Kimi 凭据校验失败' };
    }
  }

  async refreshCredentials(account: Account): Promise<void> {
    await this.accessToken(account, true);
  }

  async *discoverModels(_account: Account) {
    return;
  }

  async *streamTurn(request: ProviderRequest, account: Account): AsyncIterable<ProviderEvent> {
    let token = await this.accessToken(account);
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

        // 鉴权失败 / Token 过期：触发自动续签并重试
        if (!response.ok && (response.status === 401 || response.status === 403) && attempts < maxAttempts) {
          try {
            token = await this.accessToken(account, true);
            continue;
          } catch {}
        }

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
}
