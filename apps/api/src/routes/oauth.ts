import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { requireRole } from '../auth.js';
import { id, db } from '../db.js';
import { seal } from '../crypto.js';

function base64UrlEncode(buffer: Buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

interface OAuthSession {
  codeVerifier: string;
  state: string;
  redirectUri: string;
  email?: string;
  createdAt: number;
}

const oauthSessions = new Map<string, OAuthSession>();
const SESSION_TTL_MS = 10 * 60_000;

function purgeExpiredSessions() {
  const now = Date.now();
  for (const [sid, session] of oauthSessions.entries()) {
    if (now - session.createdAt > SESSION_TTL_MS) {
      oauthSessions.delete(sid);
    }
  }
}

export async function registerOAuthRoutes(app: FastifyInstance) {
  app.post('/api/admin/oauth/start', async (request) => {
    requireRole(request, ['owner', 'admin']);
    const body = z.object({ email: z.string().optional() }).parse(request.body ?? {});

    purgeExpiredSessions();

    const codeVerifier = base64UrlEncode(randomBytes(48));
    const challenge = base64UrlEncode(createHash('sha256').update(codeVerifier).digest());
    const nonce = base64UrlEncode(randomBytes(24));
    const deviceId = randomUUID();
    const sessionId = randomUUID().replace(/-/g, '');
    const state = `${sessionId}.${base64UrlEncode(randomBytes(12))}`;

    const authBase = 'https://auth.openai.com';
    const redirectUri = 'https://platform.openai.com/auth/callback';
    const clientId = 'app_2SKx67EdpoN0G6j64rFvigXD';
    const audience = 'https://api.openai.com/v1';

    const params = new URLSearchParams({
      issuer: authBase,
      client_id: clientId,
      audience: audience,
      redirect_uri: redirectUri,
      device_id: deviceId,
      screen_hint: 'login_or_signup',
      max_age: '0',
      scope: 'openid profile email offline_access',
      response_type: 'code',
      response_mode: 'query',
      state: state,
      nonce: nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      auth0Client: 'eyJuYW1lIjoiYXV0aDAtc3BhLWpzIiwidmVyc2lvbiI6IjEuMjEuMCJ9',
    });

    if (body.email && body.email.trim()) {
      params.set('login_hint', body.email.trim());
    }

    const authorizeUrl = `${authBase}/api/accounts/authorize?${params.toString()}`;

    oauthSessions.set(sessionId, {
      codeVerifier,
      state,
      redirectUri,
      email: body.email?.trim(),
      createdAt: Date.now(),
    });

    return {
      sessionId,
      authorizeUrl,
      expiresIn: 600,
    };
  });

  app.get('/api/admin/oauth/authorize', async (request) => {
    requireRole(request, ['owner', 'admin']);
    const session = await app.inject({ method: 'POST', url: '/api/admin/oauth/start', headers: request.headers, payload: {} });
    return JSON.parse(session.payload);
  });

  app.post('/api/admin/oauth/finish', async (request) => {
    requireRole(request, ['owner', 'admin']);
    const body = z.object({
      sessionId: z.string().optional(),
      callback: z.string().min(1),
      accountName: z.string().optional(),
    }).parse(request.body);

    const rawInput = body.callback.trim();
    let code = rawInput;
    let stateParam = '';

    if (rawInput.startsWith('http://') || rawInput.startsWith('https://')) {
      try {
        const parsed = new URL(rawInput);
        code = parsed.searchParams.get('code') || '';
        stateParam = parsed.searchParams.get('state') || '';
        if (!code) {
          const err = parsed.searchParams.get('error_description') || parsed.searchParams.get('error') || 'Callback URL 中未检测到 code 参数';
          throw new Error(err);
        }
      } catch (err) {
        if (err instanceof Error && err.message.includes('Callback URL')) throw err;
        const match = rawInput.match(/code=([^&]+)/);
        if (match) code = match[1];
        const stateMatch = rawInput.match(/state=([^&]+)/);
        if (stateMatch) stateParam = stateMatch[1];
      }
    }

    if (!code) throw Object.assign(new Error('未填写有效的 Code 或 Callback URL'), { statusCode: 400 });

    const stateSid = stateParam ? stateParam.split('.')[0] : '';
    const bodySid = (body.sessionId || '').trim();
    const candidateSids = [stateSid, bodySid].filter(Boolean);

    purgeExpiredSessions();
    let session: OAuthSession | undefined;
    let pickedSid = '';

    for (const sid of candidateSids) {
      if (oauthSessions.has(sid)) {
        session = oauthSessions.get(sid);
        pickedSid = sid;
        break;
      }
    }

    if (!session) {
      throw Object.assign(new Error('OAuth 授权会话已过期或不存在，请输入账号后点击“生成授权链接”重试。'), { statusCode: 400 });
    }

    const authBase = 'https://auth.openai.com';
    const platformBase = 'https://platform.openai.com';

    const tokenRes = await fetch(`${authBase}/api/accounts/oauth/token`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        origin: platformBase,
        referer: `${platformBase}/`,
        'auth0-client': 'eyJuYW1lIjoiYXV0aDAtc3BhLWpzIiwidmVyc2lvbiI6IjEuMjEuMCJ9',
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
      body: JSON.stringify({
        client_id: 'app_2SKx67EdpoN0G6j64rFvigXD',
        code_verifier: session.codeVerifier,
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: session.redirectUri,
      }),
    });

    const tokenData = await tokenRes.json().catch(() => ({})) as { access_token?: string; refresh_token?: string; error_description?: string; error?: string; message?: string };
    if (!tokenRes.ok || !tokenData.access_token) {
      const detail = tokenData.error_description || tokenData.error || tokenData.message || `HTTP ${tokenRes.status}`;
      throw Object.assign(new Error(`OpenAI 拒绝换 Code: ${detail}`), { statusCode: 400 });
    }

    if (!tokenData.refresh_token) {
      throw Object.assign(new Error('OpenAI 未返回 refresh_token（code 可能已被使用过或已过期）'), { statusCode: 400 });
    }

    oauthSessions.delete(pickedSid);

    const accountId = id('acc');
    const name = body.accountName?.trim() || (session.email ? `ChatGPT (${session.email})` : `ChatGPT OAuth ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`);
    const now = Date.now();
    const credentials = { access_token: tokenData.access_token, refresh_token: tokenData.refresh_token };
    const encrypted = seal(credentials);

    db.prepare(`INSERT INTO provider_accounts (id, provider, name, status, priority, created_at, updated_at) VALUES (?, 'chatgpt', ?, 'ready', 50, ?, ?)`).run(accountId, name, now, now);
    db.prepare('INSERT INTO account_credentials (account_id, ciphertext, iv, tag, updated_at) VALUES (?, ?, ?, ?, ?)').run(accountId, encrypted.ciphertext, encrypted.iv, encrypted.tag, now);

    return { id: accountId, name, status: 'ready', provider: 'chatgpt' };
  });

  app.post('/api/admin/oauth/callback', async (request, reply) => {
    return app.inject({ method: 'POST', url: '/api/admin/oauth/finish', headers: request.headers, payload: request.body as Record<string, unknown> }).then((res) => reply.status(res.statusCode).send(JSON.parse(res.payload)));
  });
}
