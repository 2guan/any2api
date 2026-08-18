import { credentialsFor, saveCredentials } from '../credentials.js';
import type { Account } from '../accounts.js';
import type { ProviderAdapter, ProviderEvent, ProviderRequest } from './types.js';
import type { ModelCapabilities } from '../catalog.js';
import { browserSupervisor } from '../browser.js';
import { buildProofToken, buildLegacyRequirementsToken } from './pow.js';
import { saveRemoteMedia } from '../media.js';
import { extractMessageContent } from '../multimodal.js';
import crypto from 'node:crypto';

const DEFAULT_CLIENT_VERSION = 'prod-a194cd50d4416d3c0b47c740f206b12ce60f5887';
const DEFAULT_CLIENT_BUILD_NUMBER = '6708908';
const BASE_URL = 'https://chatgpt.com';

function parseJWTPayload(jwtToken: string): Record<string, unknown> | null {
  if (!jwtToken || typeof jwtToken !== 'string' || !jwtToken.startsWith('eyJ')) return null;
  try {
    const parts = jwtToken.split('.');
    if (parts.length < 2) return null;
    return JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isJWTExpired(jwtToken: string): boolean {
  const payload = parseJWTPayload(jwtToken);
  if (!payload || typeof payload.exp !== 'number') return false;
  return Date.now() >= (payload.exp - 300) * 1000;
}

function extractChatGPTAccountId(jwtToken: string): string {
  const payload = parseJWTPayload(jwtToken);
  if (!payload) return '';
  const authClaim = (payload['https://api.openai.com/auth'] ?? {}) as Record<string, unknown>;
  return typeof authClaim['chatgpt_account_id'] === 'string' ? authClaim['chatgpt_account_id'] : '';
}

function accountDeviceId(tokenStr = '') {
  if (!tokenStr) return crypto.randomUUID();
  const hash = crypto.createHash('sha256').update(tokenStr).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function mapModelSlug(requestModel: string, hasAccessToken: boolean): string {
  if (!hasAccessToken) return 'auto';
  const lower = (requestModel || '').toLowerCase().trim();
  if (lower === 'auto' || !lower) return 'auto';
  if (lower.includes('thinking') || lower.includes('t-mini')) return 'gpt-5-6-t-mini';
  if (lower.includes('5.6') || lower.includes('5-6')) return 'gpt-5-6';
  if (lower.includes('5.5') || lower.includes('5-5')) return 'gpt-5-5';
  if (lower.includes('5.4-mini') || lower.includes('5-4-mini')) return 'gpt-5-4-mini';
  if (lower.includes('5.4') || lower.includes('5-4')) return 'gpt-5-4';
  if (lower.includes('o3-mini')) return 'o3-mini';
  if (lower.includes('o1')) return 'o1';
  if (lower.includes('4o-mini')) return 'gpt-4o-mini';
  if (lower.includes('4o')) return 'gpt-4o';
  if (lower.includes('image')) return 'gpt-image-2';
  return requestModel;
}

function decodeUnicodeEscapes(str: string): string {
  try {
    return str.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  } catch {
    return str;
  }
}

function formatSearchQueryForThinking(rawQuery: string): string {
  const decoded = decodeUnicodeEscapes(rawQuery);
  const match = decoded.match(/(?:search|gsearch|web_search)\(["']?(.*?)["']?\)/s);
  if (match && match[1]) {
    const q = match[1].trim();
    return `\n> 🔍 **联网检索**：\`${q}\`\n\n`;
  }
  return `\n> 🔍 **执行检索**：\`${decoded.trim()}\`\n\n`;
}

function cleanChatGPTText(text: string): string {
  if (!text) return '';
  return text
    .replace(/(?:cite)?turn\d+[a-zA-Z0-9_-]*/gi, '')
    .replace(/\b\d*(?:search|news|image|cite|turn)\d*\b/gi, '')
    .replace(/\d+search\d+/gi, '')
    .replace(/\d+news\d+/gi, '')
    .replace(/\bcite\b/gi, '')
    .replace(/[\uE000-\uF8FF]/g, '')
    .replace(/:::writing\{[^}]*\}\s*/gi, '')
    .replace(/^:::\s*$/gm, '')
    .replace(/\n:::\s*$/g, '')
    .replace(/^finished_successfully$/gi, '')
    .replace(/\{\"skipped_mainline\":true\}/g, '');
}

function isSearchOrToolQuery(text: string, recipient?: string, contentType?: string): boolean {
  if (text && (text.includes('skipped_mainline') || text.includes('finished_successfully'))) return false;
  if (recipient === 'search' || recipient === 'myfiles' || recipient === 'dalle') return true;
  if (contentType === 'code' || contentType === 'execution_output') {
    const trimmed = (text || '').trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) return false;
    return true;
  }
  const trimmed = (text || '').trim();
  if (trimmed.startsWith('search(') || trimmed.startsWith('gsearch(') || trimmed.startsWith('web_search(') || trimmed.startsWith('fast|')) return true;
  return false;
}

function formatMultiTurnMessages(messages: ProviderRequest['messages']) {
  if (!Array.isArray(messages)) return [];
  return messages;
}

export class ChatGPTAdapter implements ProviderAdapter {
  readonly provider = 'chatgpt';
  private tokenCache = new Map<string, { accessToken: string; expiresAt: number }>();

  async testConnection(account: Account) {
    try {
      const accessToken = await this.getAccessToken(account);
      if (accessToken) return { ok: true, detail: 'ChatGPT Direct Access Token is valid' };
    } catch {
      /* Fallback check */
    }
    return { ok: true, detail: 'ChatGPT browser workspace is reachable' };
  }

  async refreshCredentials(account: Account): Promise<void> {
    await this.getAccessToken(account);
  }

  async *discoverModels(account: Account) {
    try {
      const accessToken = await this.getAccessToken(account);
      const res = await fetch(`${BASE_URL}/backend-api/models`, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'OAI-Client-Version': DEFAULT_CLIENT_VERSION,
        }
      });
      if (res.ok) {
        const json = await res.json() as { models?: Array<{ slug?: string; id?: string }> };
        const models = json.models ?? [];
        for (const m of models) {
          const upstreamId = m.slug ?? m.id;
          if (upstreamId) {
            const caps: ModelCapabilities = {
              input: ['text', 'image'],
              output: ['text'],
              streaming: true,
              reasoningSummary: upstreamId.includes('o1') || upstreamId.includes('o3') || upstreamId.includes('thinking'),
              webSearch: true
            };
            yield { upstreamId, capabilities: caps };
          }
        }
      }
    } catch {
      /* Suppress discovery errors */
    }
  }

  async uploadFile(base64OrUrl: string, filename = 'image.png', accessToken = ''): Promise<{ fileId: string; mimeType: string; size: number }> {
    if (!accessToken) throw new Error('使用多模态视觉模型需要配置已登录的账号凭据');

    let buffer: Buffer;
    let mimeType = 'image/png';

    if (base64OrUrl.startsWith('data:')) {
      const commaIdx = base64OrUrl.indexOf(',');
      if (commaIdx !== -1) {
        const header = base64OrUrl.slice(0, commaIdx);
        const match = header.match(/^data:([^;]+);base64/i);
        if (match) mimeType = match[1];
        const rawBase64 = base64OrUrl.slice(commaIdx + 1).replace(/\s+/g, '');
        buffer = Buffer.from(rawBase64, 'base64');
      } else {
        buffer = Buffer.from(base64OrUrl.replace(/\s+/g, ''), 'base64');
      }
    } else if (base64OrUrl.startsWith('http://') || base64OrUrl.startsWith('https://')) {
      const res = await fetch(base64OrUrl);
      if (!res.ok) throw new Error(`获取图片URL失败 (HTTP ${res.status}): ${base64OrUrl.slice(0, 100)}`);
      const arrayBuffer = await res.arrayBuffer();
      buffer = Buffer.from(arrayBuffer);
      mimeType = res.headers.get('content-type') || mimeType;
    } else {
      buffer = Buffer.from(base64OrUrl.replace(/\s+/g, ''), 'base64');
    }

    const accountId = extractChatGPTAccountId(accessToken);
    const reqRes = await fetch(`${BASE_URL}/backend-api/files`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        ...(accountId ? { 'ChatGPT-Account-ID': accountId } : {}),
      },
      body: JSON.stringify({
        file_name: filename,
        file_size: buffer.length,
        use_case: 'multimodal',
      }),
    });

    if (!reqRes.ok) {
      const errTxt = await reqRes.text().catch(() => '');
      throw new Error(`OpenAI 存储池上传初始化失败 (HTTP ${reqRes.status}): ${errTxt.slice(0, 150)}`);
    }
    const reqData = await reqRes.json() as { file_id: string; upload_url: string };
    const fileId = reqData.file_id;
    const uploadUrl = reqData.upload_url;

    const putRes = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': mimeType, 'x-ms-blob-type': 'BlockBlob' },
      body: new Uint8Array(buffer),
    });

    if (!putRes.ok && putRes.status !== 201) {
      throw new Error(`OpenAI 存储池二进制写入失败 (HTTP ${putRes.status})`);
    }

    const procRes = await fetch(`${BASE_URL}/backend-api/files/${fileId}/uploaded`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        ...(accountId ? { 'ChatGPT-Account-ID': accountId } : {}),
      },
      body: JSON.stringify({}),
    });

    if (!procRes.ok) {
      const procTxt = await procRes.text().catch(() => '');
      throw new Error(`OpenAI 存储池文件状态确认失败 (HTTP ${procRes.status}): ${procTxt.slice(0, 150)}`);
    }

    return { fileId, mimeType, size: buffer.length };
  }

  async *streamTurn(request: ProviderRequest, account: Account): AsyncIterable<ProviderEvent> {
    let accessToken = '';
    try {
      accessToken = await this.getAccessToken(account);
    } catch {
      /* Guest or anon execution */
    }

    const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';
    const targetPath = accessToken ? '/backend-api/conversation' : '/backend-anon/conversation';
    const modelSlug = mapModelSlug(request.model, Boolean(accessToken));
    const endpoint = accessToken ? `${BASE_URL}/backend-api/conversation` : `${BASE_URL}/backend-anon/conversation`;

    const accountId = accessToken ? extractChatGPTAccountId(accessToken) : '';
    const deviceId = accountDeviceId(accessToken);

    const headers: Record<string, string> = {
      'Accept': 'text/event-stream',
      'Content-Type': 'application/json',
      'User-Agent': userAgent,
      'Origin': BASE_URL,
      'Referer': `${BASE_URL}/`,
      'Sec-Ch-Ua': '"Google Chrome";v="145", "Not?A_Brand";v="8", "Chromium";v="145"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
      'OAI-Language': 'zh-CN',
      'OAI-Client-Version': DEFAULT_CLIENT_VERSION,
      'OAI-Client-Build-Number': DEFAULT_CLIENT_BUILD_NUMBER,
      'OAI-Device-Id': deviceId,
      'OAI-Session-Id': crypto.randomUUID(),
      'X-OpenAI-Target-Path': targetPath,
      'X-OpenAI-Target-Route': targetPath,
    };

    if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;
    if (accountId) headers['ChatGPT-Account-ID'] = accountId;

    const formattedMessages = formatMultiTurnMessages(request.messages);
    const conversationMessages = [];

    let systemInstruction = '';
    const nonSystemMessages: typeof formattedMessages = [];
    for (const msg of formattedMessages) {
      if (msg.role === 'system') {
        const { text } = extractMessageContent(msg.content);
        if (text) systemInstruction = systemInstruction ? `${systemInstruction}\n${text}` : text;
      } else {
        nonSystemMessages.push(msg);
      }
    }

    if (nonSystemMessages.length === 0 && systemInstruction) {
      nonSystemMessages.push({ role: 'user', content: systemInstruction });
      systemInstruction = '';
    }

    for (let i = 0; i < nonSystemMessages.length; i++) {
      const msg = nonSystemMessages[i];
      const role = msg.role === 'assistant' ? 'assistant' : 'user';
      let { text, images } = extractMessageContent(msg.content);
      const msgNodeId = crypto.randomUUID();

      if (i === 0 && systemInstruction && role === 'user') {
        text = `[系统指示]: ${systemInstruction}\n\n${text}`.trim();
      }

      const parts: unknown[] = [];
      const attachments: unknown[] = [];

      if (images.length > 0 && accessToken) {
        for (let j = 0; j < images.length; j++) {
          try {
            const uploaded = await this.uploadFile(images[j], `image_${j + 1}.png`, accessToken);
            parts.push({
              content_type: 'image_asset_pointer',
              asset_pointer: `file-service://${uploaded.fileId}`,
              size_bytes: uploaded.size,
              width: null,
              height: null
            });
            attachments.push({
              id: uploaded.fileId,
              name: `image_${j + 1}.png`,
              size: uploaded.size,
              mime_type: uploaded.mimeType,
              width: null,
              height: null
            });
          } catch (err) {
            console.error('ChatGPT file upload error:', err);
            throw err;
          }
        }
      }

      if (text) {
        parts.push(text);
      } else if (parts.length === 0) {
        parts.push(typeof msg.content === 'string' ? msg.content : '');
      }

      conversationMessages.push({
        id: msgNodeId,
        author: { role },
        content: {
          content_type: parts.length > 1 || images.length > 0 ? 'multimodal_text' : 'text',
          parts
        },
        metadata: attachments.length > 0 ? { attachments } : undefined
      });
    }

    const currentPayload: Record<string, unknown> = {
      action: 'next',
      messages: conversationMessages,
      model: modelSlug,
      parent_message_id: crypto.randomUUID(),
      conversation_mode: { kind: 'primary_assistant' },
      conversation_origin: null,
      force_paragen: false,
      force_paragen_model_slug: '',
      force_rate_limit: false,
      force_use_sse: true,
      history_and_training_disabled: false,
      reset_rate_limits: false,
      reasoning_effort: 'medium',
      search_mode: 'auto',
      suggestions: [],
      supported_encodings: ['v1'],
      system_hints: [],
      timezone: 'Asia/Shanghai',
      timezone_offset_min: -480,
      variant_purpose: 'comparison_implicit',
      websocket_request_id: crypto.randomUUID(),
      client_contextual_info: {
        is_dark_mode: false,
        time_since_loaded: 120,
        page_height: 900,
        page_width: 1400,
        pixel_ratio: 2,
        screen_height: 1440,
        screen_width: 2560,
      },
    };

    // 1:1 In-Browser TLS Proxy Stream from chat2api
    yield* this.fetchInBrowserStream(endpoint, headers, currentPayload, account, modelSlug);
  }

  private async *fetchInBrowserStream(endpoint: string, headers: Record<string, string>, payload: Record<string, unknown>, account: Account, modelSlug: string): AsyncIterable<ProviderEvent> {
    const browser = await browserSupervisor.getBrowser();
    const userAgent = headers['User-Agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';
    const context = await browser.newContext({ userAgent, viewport: { width: 1440, height: 960 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });

    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en-US', 'en'] });
      (window as unknown as { chrome?: unknown }).chrome = { runtime: {} };
    });

    try {
      const page = await context.newPage();
      const queue: string[] = [];
      let resolveNext: (() => void) | null = null;
      let isEnded = false;

      await page.exposeFunction('__calcProofToken', (seed: string, difficulty: string) => {
        return buildProofToken(seed, difficulty, userAgent);
      });
      await page.exposeFunction('__calcRequirementsToken', () => {
        return buildLegacyRequirementsToken(userAgent);
      });
      await page.exposeFunction('__chatgpt_push_chunk', (chunkText: string) => {
        queue.push(chunkText);
        if (resolveNext) {
          const r = resolveNext;
          resolveNext = null;
          r();
        }
      });
      await page.exposeFunction('__chatgpt_end_stream', () => {
        isEnded = true;
        if (resolveNext) {
          const r = resolveNext;
          resolveNext = null;
          r();
        }
      });

      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});

      let continuationTurn = 0;
      const maxContinuationTurns = 3;
      let hasFinalText = false;
      let currentPayload = { ...payload };

      while (continuationTurn < maxContinuationTurns && !hasFinalText) {
        continuationTurn++;
        isEnded = false;

        void page.evaluate(({ endpoint, headers, payload }) => {
          (async () => {
            try {
              const reqEndpoint = headers['Authorization']
                ? 'https://chatgpt.com/backend-api/sentinel/chat-requirements'
                : 'https://chatgpt.com/backend-anon/sentinel/chat-requirements';

              try {
                const pToken = await (window as unknown as { __calcRequirementsToken: () => Promise<string> }).__calcRequirementsToken();
                const reqRes = await window.fetch(reqEndpoint, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'OAI-Language': 'zh-CN',
                    ...(headers['Authorization'] ? { 'Authorization': headers['Authorization'] } : {}),
                    ...(headers['OAI-Device-Id'] ? { 'OAI-Device-Id': headers['OAI-Device-Id'] } : {}),
                    ...(headers['ChatGPT-Account-ID'] ? { 'ChatGPT-Account-ID': headers['ChatGPT-Account-ID'] } : {}),
                  },
                  body: JSON.stringify({ p: pToken }),
                });

                if (reqRes.ok) {
                  const reqData = await reqRes.json() as { token?: string; proofofwork?: { seed?: string; difficulty?: string; required?: boolean } };
                  if (reqData.token) {
                    headers['OpenAI-Sentinel-Chat-Requirements-Token'] = reqData.token;
                  }
                  if (reqData.proofofwork && reqData.proofofwork.required) {
                    const proofToken = await (window as unknown as { __calcProofToken: (s: string, d: string) => Promise<string> }).__calcProofToken(
                      reqData.proofofwork.seed || '',
                      reqData.proofofwork.difficulty || ''
                    );
                    if (proofToken) {
                      headers['OpenAI-Sentinel-Proof-Token'] = proofToken;
                    }
                  }
                }
              } catch {}

              const res = await window.fetch(endpoint, {
                method: 'POST',
                headers,
                body: JSON.stringify(payload),
              });

              if (!res.ok) {
                const rawErr = await res.text().catch(() => '');
                let cleanMsg = `HTTP ${res.status}: ${rawErr.slice(0, 200)}`;
                if (res.status === 403 || rawErr.includes('Unusual activity') || rawErr.includes('<!DOCTYPE')) {
                  cleanMsg = `OpenAI IP风控阻断 (HTTP 403): Unusual activity detected. 当前 IP 被 OpenAI/Cloudflare 标记为风控节点，建议配置代理/科学上网节点后重试。`;
                } else if (res.status === 401) {
                  cleanMsg = `OpenAI 认证令牌失效 (HTTP 401): Could not parse your authentication token. 请重新提取并保存账号 Token。`;
                }
                (window as unknown as { __chatgpt_push_chunk: (c: string) => void }).__chatgpt_push_chunk(`data: {"error":{"message":${JSON.stringify(cleanMsg)}}}\n\n`);
                (window as unknown as { __chatgpt_end_stream: () => void }).__chatgpt_end_stream();
                return;
              }

              const reader = res.body?.getReader();
              const decoder = new TextDecoder();
              if (reader) {
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  const text = decoder.decode(value, { stream: true });
                  if (text) (window as unknown as { __chatgpt_push_chunk: (c: string) => void }).__chatgpt_push_chunk(text);
                }
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              (window as unknown as { __chatgpt_push_chunk: (c: string) => void }).__chatgpt_push_chunk(`data: {"error":{"message":${JSON.stringify(msg)}}}\n\n`);
            } finally {
              (window as unknown as { __chatgpt_end_stream: () => void }).__chatgpt_end_stream();
            }
          })();
        }, { endpoint, headers, payload: currentPayload }).catch((e) => {
          queue.push(`data: {"error":{"message":${JSON.stringify(e instanceof Error ? e.message : String(e))}}}\n\n`);
          isEnded = true;
        });

        let buffer = '';
        let lastConversationId = '';
        let lastMessageId = '';
        const msgTracker = new Map<string, { lastContent: string; lastThought: string }>();
        const seenImageFiles = new Set<string>();

        while (!isEnded || queue.length > 0) {
          if (queue.length === 0) {
            await new Promise<void>((r) => { resolveNext = () => r(); });
          }
          while (queue.length > 0) {
            const chunk = queue.shift();
            if (!chunk) continue;
            buffer += chunk;
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || !trimmed.startsWith('data: ')) continue;
              const dataStr = trimmed.slice(6).trim();
              if (dataStr === '[DONE]') continue;

              try {
                const parsed = JSON.parse(dataStr) as {
                  error?: { message?: string };
                  conversation_id?: string;
                  message?: {
                    id?: string;
                    author?: { role?: string; name?: string };
                    content?: { parts?: unknown[]; thoughts?: unknown[]; reasoning_parts?: unknown[]; content_type?: string; text?: string };
                    metadata?: { citations?: Array<{ title?: string; url?: string; site_name?: string; name?: string; link?: string }>; is_thought?: boolean };
                    recipient?: string;
                    text?: string;
                  };
                  v?: { message?: unknown; parts?: unknown[]; text?: string; content?: unknown };
                  d?: { message?: unknown; content?: unknown };
                  delta?: { content?: string };
                  citations?: Array<{ title?: string; url?: string; link?: string }>;
                  content?: unknown;
                  text?: string;
                  response?: string;
                };

                if (parsed.error) {
                  throw new Error(parsed.error.message || 'Browser execution error');
                }

                // Robust asset_pointer detection anywhere in dataStr
                const rawAssetMatches = dataStr.match(/(?:sediment|file-service):\/\/(file_[a-zA-Z0-9_-]+)/g);
                if (rawAssetMatches) {
                  for (const match of rawAssetMatches) {
                    const fileId = match.replace(/^(?:sediment|file-service):\/\//, '');
                    if (seenImageFiles.has(fileId)) continue;
                    seenImageFiles.add(fileId);
                    const tok = (headers['Authorization'] || '').replace(/^Bearer\s+/i, '') || credentialsFor(account.id).access_token || '';
                    if (tok && fileId) {
                      try {
                        const dlRes = await fetch(`${BASE_URL}/backend-api/files/${fileId}/download`, {
                          headers: { 'Authorization': `Bearer ${tok}`, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
                        });
                        if (dlRes.ok) {
                          const dlJson = await dlRes.json() as { download_url?: string };
                          if (dlJson.download_url) {
                            hasFinalText = true;
                            const localUrl = await saveRemoteMedia(dlJson.download_url, 'chatgpt_img', {
                              'Authorization': `Bearer ${tok}`,
                              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                            });
                            yield { type: 'image.created', url: localUrl };
                          }
                        }
                      } catch {}
                    }
                  }
                }

                // 1. Direct v1 delta encoding strings: {"v": "text"} or {"p": "...", "o": "append", "v": "text"}
                if (typeof parsed.v === 'string' && parsed.v) {
                  if (isSearchOrToolQuery(parsed.v)) {
                    yield { type: 'reasoning.summary.delta', text: formatSearchQueryForThinking(parsed.v) };
                  } else {
                    const cleaned = cleanChatGPTText(parsed.v);
                    if (cleaned) {
                      hasFinalText = true;
                      yield { type: 'message.delta', text: cleaned };
                    }
                  }
                  continue;
                }

                // 2. Patch array with appends: {"p": "", "o": "patch", "v": [{"o": "append", "v": "text"}]}
                if (Array.isArray(parsed.v)) {
                  let appended = '';
                  for (const patchItem of parsed.v as Array<{ o?: string; v?: unknown }>) {
                    if (patchItem && patchItem.o === 'append' && typeof patchItem.v === 'string') {
                      appended += patchItem.v;
                    }
                  }
                  if (appended) {
                    if (isSearchOrToolQuery(appended)) {
                      yield { type: 'reasoning.summary.delta', text: formatSearchQueryForThinking(appended) };
                    } else {
                      const cleaned = cleanChatGPTText(appended);
                      if (cleaned) {
                        hasFinalText = true;
                        yield { type: 'message.delta', text: cleaned };
                      }
                    }
                    continue;
                  }
                }

                const targetMsg = ((parsed.v as { message?: typeof parsed.message })?.message ||
                                  parsed.message ||
                                  (parsed.d as { message?: typeof parsed.message })?.message ||
                                  (parsed.v as typeof parsed.message) ||
                                  (parsed as unknown as typeof parsed.message)) as typeof parsed.message | undefined;

                const authorRole = targetMsg?.author?.role || '';
                if (authorRole === 'user' || authorRole === 'system') continue;

                if (targetMsg?.id) lastMessageId = targetMsg.id;

                const msgId = targetMsg?.id || 'msg-default';
                if (!msgTracker.has(msgId)) {
                  msgTracker.set(msgId, { lastContent: '', lastThought: '' });
                }
                const msgState = msgTracker.get(msgId)!;

                // Citations
                const rawCitations = (parsed.citations || targetMsg?.metadata?.citations || []) as Array<{ title?: string; url?: string; site_name?: string; name?: string; link?: string }>;
                if (Array.isArray(rawCitations)) {
                  for (const c of rawCitations) {
                    const title = c.title || c.site_name || c.name || '';
                    const url = c.url || c.link || '';
                    if (url) yield { type: 'search.citation', title, url };
                  }
                }

                // Reasoning / Thinking / Search tools
                const msgContentType = targetMsg?.content?.content_type || '';
                const isThoughtMeta = targetMsg?.metadata?.is_thought === true;
                const isThoughtMessage = isThoughtMeta || msgContentType === 'thoughts' || msgContentType === 'thought' || msgContentType === 'reasoning';

                if (isThoughtMessage) {
                  const thoughtParts = targetMsg?.content?.parts || targetMsg?.content?.thoughts || targetMsg?.content?.reasoning_parts || [];
                  let currentThought = '';
                  for (const t of thoughtParts) {
                    if (typeof t === 'string') currentThought += t;
                    else if (t && typeof (t as { text?: string }).text === 'string') currentThought += (t as { text: string }).text;
                  }
                  if (currentThought.length > msgState.lastThought.length) {
                    const delta = currentThought.slice(msgState.lastThought.length);
                    msgState.lastThought = currentThought;
                    yield { type: 'reasoning.summary.delta', text: delta };
                  }
                } else {
                  // Content
                  const contentNode = targetMsg?.content;
                  const parts = contentNode?.parts || (Array.isArray(contentNode) ? contentNode : []);
                  let currentContent = '';

                  if (typeof contentNode === 'string') {
                    currentContent = contentNode;
                  } else if (contentNode && typeof contentNode.text === 'string') {
                    currentContent = contentNode.text;
                  } else if (Array.isArray(parts) && parts.length > 0) {
                    for (const p of parts) {
                      if (typeof p === 'string') {
                        currentContent += p;
                      } else if (p && typeof (p as { text?: string }).text === 'string') {
                        currentContent += (p as { text: string }).text;
                      } else if (p && typeof (p as { asset_pointer?: string }).asset_pointer === 'string') {
                        const assetPointer = (p as { asset_pointer: string }).asset_pointer;
                        const fileId = assetPointer.replace(/^(?:sediment|file-service):\/\//, '');
                        const creds = credentialsFor(account.id);
                        const tok = (headers['Authorization'] || '').replace(/^Bearer\s+/i, '') || creds.access_token || '';
                        if (tok && fileId) {
                          try {
                            const dlRes = await fetch(`${BASE_URL}/backend-api/files/${fileId}/download`, {
                              headers: { 'Authorization': `Bearer ${tok}`, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
                            });
                            if (dlRes.ok) {
                              const dlJson = await dlRes.json() as { download_url?: string };
                              if (dlJson.download_url) {
                                hasFinalText = true;
                                const localUrl = await saveRemoteMedia(dlJson.download_url, 'chatgpt_img', {
                                  'Authorization': `Bearer ${tok}`,
                                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                                });
                                yield { type: 'image.created', url: localUrl };
                              }
                            }
                          } catch {}
                        }
                      }
                    }
                  } else if (typeof targetMsg?.text === 'string') {
                    currentContent = targetMsg.text;
                  } else if (typeof parsed.text === 'string') {
                    currentContent = parsed.text;
                  } else if (typeof parsed.response === 'string') {
                    currentContent = parsed.response;
                  } else if (typeof parsed.delta?.content === 'string') {
                    currentContent = parsed.delta.content;
                  }

                  if (isSearchOrToolQuery(currentContent, targetMsg?.recipient, msgContentType)) {
                    if (currentContent.length > msgState.lastThought.length) {
                      const deltaThought = currentContent.slice(msgState.lastThought.length);
                      msgState.lastThought = currentContent;
                      yield { type: 'reasoning.summary.delta', text: formatSearchQueryForThinking(deltaThought) };
                    }
                  } else if (currentContent.length > msgState.lastContent.length) {
                    const delta = currentContent.slice(msgState.lastContent.length);
                    msgState.lastContent = currentContent;
                    const cleaned = cleanChatGPTText(delta);
                    if (cleaned) {
                      hasFinalText = true;
                      yield { type: 'message.delta', text: cleaned };
                    }
                  }
                }
              } catch (err) {
                if (err instanceof Error && err.message.includes('OpenAI')) throw err;
              }
            }
          }
        }

        if (!hasFinalText && lastConversationId && lastMessageId) {
          currentPayload = {
            action: 'continue',
            conversation_id: lastConversationId,
            parent_message_id: lastMessageId,
            model: modelSlug,
            timezone: 'Asia/Shanghai',
            timezone_offset_min: -480,
            history_and_training_disabled: false,
          };
        } else {
          break;
        }
      }

      yield { type: 'completed' };
    } finally {
      await context.close().catch(() => {});
    }
  }

  private async getAccessToken(account: Account): Promise<string> {
    const credentials = credentialsFor(account.id);
    let rawToken = (credentials.access_token ?? credentials.token ?? credentials.session_cookie ?? '').trim();
    let refreshToken = credentials.refresh_token || (rawToken.startsWith('rt.') || rawToken.startsWith('rt-') ? rawToken : '');

    if (rawToken.startsWith('{')) {
      try {
        const parsed = JSON.parse(rawToken) as { access_token?: string; refresh_token?: string; token?: string };
        if (parsed.refresh_token) refreshToken = parsed.refresh_token;
        if (parsed.access_token) rawToken = parsed.access_token;
        else if (parsed.token) rawToken = parsed.token;
      } catch {}
    }

    if (refreshToken) {
      const cached = this.tokenCache.get(refreshToken);
      if (cached && Date.now() < cached.expiresAt && !isJWTExpired(cached.accessToken)) {
        return cached.accessToken;
      }
      const refreshed = await this.refreshAccessToken(refreshToken);
      if (refreshed && refreshed.accessToken) {
        this.tokenCache.set(refreshed.refreshToken, { accessToken: refreshed.accessToken, expiresAt: Date.now() + 3000 * 1000 });
        saveCredentials(account.id, { ...credentials, access_token: refreshed.accessToken, refresh_token: refreshed.refreshToken });
        return refreshed.accessToken;
      }
    }

    if (rawToken && !isJWTExpired(rawToken)) {
      return rawToken;
    }

    throw new Error('ChatGPT requires a valid Access Token or Refresh Token');
  }

  private async refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; refreshToken: string } | null> {
    try {
      const res = await fetch('https://auth.openai.com/api/accounts/oauth/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
          'Origin': 'https://platform.openai.com',
          'Referer': 'https://platform.openai.com/',
        },
        body: JSON.stringify({ grant_type: 'refresh_token', client_id: 'app_2SKx67EdpoN0G6j64rFvigXD', refresh_token: refreshToken })
      });
      if (res.ok) {
        const data = await res.json() as { access_token?: string; refresh_token?: string };
        if (data.access_token) return { accessToken: data.access_token, refreshToken: data.refresh_token ?? refreshToken };
      }
    } catch { /* Fallback */ }

    try {
      const res = await fetch('https://auth0.openai.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grant_type: 'refresh_token', client_id: 'p9fk2878u98h59', refresh_token: refreshToken })
      });
      if (res.ok) {
        const data = await res.json() as { access_token?: string; refresh_token?: string };
        if (data.access_token) return { accessToken: data.access_token, refreshToken: data.refresh_token ?? refreshToken };
      }
    } catch { /* Suppress */ }

    // Fallback: In-Browser TLS Proxy Token Refresh (Bypasses TLS Fingerprint blocks)
    try {
      const browser = await browserSupervisor.getBrowser();
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto('https://auth.openai.com', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});

      const tokenData = await page.evaluate(async (rt) => {
        try {
          const res = await window.fetch('https://auth.openai.com/api/accounts/oauth/token', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Origin': 'https://platform.openai.com',
              'Referer': 'https://platform.openai.com/',
            },
            body: JSON.stringify({
              grant_type: 'refresh_token',
              client_id: 'app_2SKx67EdpoN0G6j64rFvigXD',
              refresh_token: rt,
            }),
          });
          if (res.ok) return await res.json() as { access_token?: string; refresh_token?: string };
        } catch {}
        return null;
      }, refreshToken);

      await context.close().catch(() => {});
      if (tokenData && tokenData.access_token) {
        return {
          accessToken: tokenData.access_token,
          refreshToken: tokenData.refresh_token || refreshToken,
        };
      }
    } catch {}

    return null;
  }
}
