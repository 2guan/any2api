import crypto from 'node:crypto';
import { credentialsFor, saveCredentials } from '../credentials.js';
import type { Account } from '../accounts.js';
import type { ProviderAdapter, ProviderEvent, ProviderRequest } from './types.js';
import { browserSupervisor } from '../browser.js';
import { saveRemoteMedia } from '../media.js';
import { extractConversationContent } from '../multimodal.js';

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

function isJWTExpired(jwtToken: string): boolean {
  const payload = parseJWTPayload(jwtToken);
  if (!payload || typeof payload.exp !== 'number') return false;
  const expMs = payload.exp < 10000000000 ? payload.exp * 1000 : payload.exp;
  return Date.now() >= expMs - 30_000;
}

function generateGLMSign() {
  const A = Date.now().toString();
  const e = A.length;
  const i = A.split('').map((x) => Number(x));
  const t = i.reduce((sum, num) => sum + num, 0) - i[e - 2];
  const timestamp = A.substring(0, e - 2) + (t % 10) + A.substring(e - 1, e);
  const xNonce = crypto.randomUUID().replace(/-/g, '');
  const sign = crypto.createHash('md5').update(`${timestamp}-${xNonce}-8a1317a7468aa3ad86e997d08f3f31cb`).digest('hex');
  return { timestamp, xNonce, sign };
}

export class GLMAdapter implements ProviderAdapter {
  readonly provider = 'glm';

  async testConnection(account: Account) {
    const credentials = credentialsFor(account.id);
    const token = credentials.access_token ?? credentials.token ?? credentials.refresh_token;
    if (!token) return { ok: false, detail: '未配置智谱 GLM 凭据，请在【账号池】录入' };

    const payload = parseJWTPayload(token);
    if (payload && (payload as { type?: string }).type === 'refresh') {
      return { ok: true, detail: '智谱 GLM 凭据已录入（检测为 Refresh Token，建议同时填入 Access Token 确保直连与调度稳定）' };
    }

    if (isJWTExpired(token)) {
      return { ok: false, detail: '智谱 GLM Token 已过期，请在网页端 F12 重新复制最新的 Authorization Token' };
    }

    return { ok: true, detail: '智谱 GLM Token 校验成功' };
  }

  async *discoverModels(_account: Account) {
    return;
  }

  async *streamTurn(request: ProviderRequest, account: Account): AsyncIterable<ProviderEvent> {
    const credentials = credentialsFor(account.id);
    let rawToken = credentials.access_token ?? credentials.token ?? credentials.refresh_token ?? '';

    if (rawToken.startsWith('{')) {
      try {
        const parsed = JSON.parse(rawToken) as { access_token?: string; token?: string; refresh_token?: string };
        if (parsed.access_token) rawToken = parsed.access_token;
        else if (parsed.token) rawToken = parsed.token;
        else if (parsed.refresh_token) rawToken = parsed.refresh_token;
      } catch {}
    }

    const cleanToken = rawToken.replace(/^Bearer\s+/i, '').replace(/^"|"$/g, '').trim();
    if (!cleanToken) {
      throw new Error('未配置智谱 GLM 凭据，请在【使用指南】查看如何复制 Token 并录入账号池');
    }

    const payload = parseJWTPayload(cleanToken);
    if (payload && (payload as { type?: string }).type === 'refresh') {
      throw new Error('当前填入的是智谱清言的 Refresh Token。请在网页端（chatglm.cn）按 F12，从网络请求标头中复制 Authorization: Bearer eyJ...（Access Token 访问令牌）并填入账号池。');
    }

    if (isJWTExpired(cleanToken)) {
      throw new Error('智谱 ChatGLM Authorization Token 已过期（有效期通常为 2 小时），请在网页端 F12 重新复制最新的 Authorization 标头并保存');
    }

    const { systemPrompt, latestText, images } = extractConversationContent(request.messages);
    let prompt = latestText || (images.length > 0 ? '请分析这张图片' : '');
    if (systemPrompt) prompt = `[系统设定]: ${systemPrompt}\n\n${prompt}`;
    const model = request.model || 'glm-4';

    // 尝试 1: 直接高性能 HTTP POST 请求（带逆向签名）
    let directFailed = false;
    try {
      const { timestamp, xNonce, sign } = generateGLMSign();
      const requestId = crypto.randomUUID().replace(/-/g, '');
      const deviceId = (payload as { device_id?: string })?.device_id || crypto.randomUUID().replace(/-/g, '');
      const isImageModel = /image|cogview|draw|paint|pic/i.test(model);

      const requestPayload = {
        assistant_id: '65940acff94777010aa6b796',
        conversation_id: credentials.session_id || '',
        project_id: '',
        chat_type: 'user_chat',
        meta_data: {
          cogview: { rm_label_watermark: false },
          is_test: false,
          input_question_type: 'xxxx',
          channel: '',
          draft_id: '',
          chat_mode: !isImageModel && /think|5\.2|5v/i.test(model) ? 'thinking' : 'normal',
          is_networking: request.webSearch ?? true,
          quote_log_id: '',
          platform: 'pc'
        },
        messages: [
          {
            role: 'user',
            content: [
              ...(images.map((img) => ({ type: 'image', image: [img] }))),
              { type: 'text', text: prompt }
            ]
          }
        ]
      };

      const response = await fetch('https://chatglm.cn/chatglm/backend-api/assistant/stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json;charset=UTF-8',
          'Authorization': `Bearer ${cleanToken}`,
          'App-Name': 'chatglm',
          'X-App-Platform': 'pc',
          'X-App-Version': '0.0.1',
          'X-App-fr': 'default',
          'X-Lang': 'zh',
          'X-Device-Id': deviceId,
          'X-Request-Id': requestId,
          'X-Timestamp': timestamp,
          'X-Nonce': xNonce,
          'X-Sign': sign,
          'accept': 'text/event-stream',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36'
        },
        body: JSON.stringify(requestPayload)
      });

      if (response.ok && response.body) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let lastThinkLength = 0;
        let lastTextLength = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const dataStr = trimmed.replace(/^data:\s*/, '').trim();
            if (!dataStr || dataStr === '[DONE]') continue;

            try {
              const parsed = JSON.parse(dataStr) as {
                conversation_id?: string;
                meta_data?: { search_result?: Array<{ title?: string; name?: string; link?: string; url?: string }> };
                parts?: Array<{
                  content?: Array<{
                    type?: string;
                    text?: string;
                    think?: string;
                    image?: Array<{ image_url?: string; url?: string } | string>;
                    image_url?: string;
                    url?: string;
                  }>;
                  image?: Array<{ image_url?: string; url?: string } | string>;
                }>;
              };

              if (parsed.conversation_id && !credentials.session_id) {
                saveCredentials(account.id, { ...credentials, session_id: parsed.conversation_id });
              }

              // 搜索引用提取
              if (Array.isArray(parsed.meta_data?.search_result)) {
                for (const item of parsed.meta_data.search_result) {
                  if (item.title || item.name || item.link || item.url) {
                    yield {
                      type: 'search.citation',
                      title: item.title || item.name || '',
                      url: item.link || item.url || ''
                    };
                  }
                }
              }

              // 思维链、消息增量与生成图片提取
              if (Array.isArray(parsed.parts)) {
                for (const part of parsed.parts) {
                  // 1. 检查 part 顶层的图片
                  if (Array.isArray(part.image)) {
                    for (const img of part.image) {
                      const rawUrl = typeof img === 'string' ? img : (img?.image_url || img?.url || '');
                      if (rawUrl) {
                        const localUrl = await saveRemoteMedia(rawUrl, 'glm_img');
                        yield { type: 'image.created', url: localUrl };
                      }
                    }
                  }

                  // 2. 检查 part.content
                  if (Array.isArray(part.content)) {
                    for (const c of part.content) {
                      if ((c.type === 'think' || c.type === 'thought' || c.type === 'thinking' || c.type === 'reasoning') && (c.think || c.text)) {
                        const fullThink = c.think || c.text || '';
                        const delta = fullThink.slice(lastThinkLength);
                        if (delta) {
                          lastThinkLength = fullThink.length;
                          yield { type: 'reasoning.summary.delta', text: delta };
                        }
                      } else if (c.type === 'image') {
                        const images = Array.isArray(c.image) ? c.image : (c.image_url || c.url ? [c.image_url || c.url || ''] : []);
                        for (const img of images) {
                          const rawUrl = typeof img === 'string' ? img : (img?.image_url || img?.url || '');
                          if (rawUrl) {
                            const localUrl = await saveRemoteMedia(rawUrl, 'glm_img');
                            yield { type: 'image.created', url: localUrl };
                          }
                        }
                      } else if (c.type === 'text' && c.text) {
                        const fullText = c.text;
                        const delta = fullText.slice(lastTextLength);
                        if (delta) {
                          lastTextLength = fullText.length;
                          yield { type: 'message.delta', text: delta };
                        }
                      }
                    }
                  }
                }
              }
            } catch {}
          }
        }
        yield { type: 'completed' };
        return;
      } else {
        directFailed = true;
      }
    } catch {
      directFailed = true;
    }

    // 尝试 2: 无头浏览器仿真执行
    if (directFailed) {
      yield* this.streamInBrowser(prompt, cleanToken, model, account);
    }
  }

  private async *streamInBrowser(prompt: string, tokenInput: string, _model: string, account: Account): AsyncIterable<ProviderEvent> {
    const browser = await browserSupervisor.getBrowser();
    const cleanToken = tokenInput.replace(/^Bearer\s+/i, '').replace(/^"|"$/g, '').trim();

    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
    });

    const queue: string[] = [];
    let resolveNext: (() => void) | null = null;
    let isEnded = false;

    try {
      const page = await context.newPage();

      await page.exposeFunction('__glm_push_chunk', (chunkText: string) => {
        queue.push(chunkText);
        if (resolveNext) {
          const r = resolveNext;
          resolveNext = null;
          r();
        }
      });

      await page.exposeFunction('__glm_end_stream', () => {
        isEnded = true;
        if (resolveNext) {
          const r = resolveNext;
          resolveNext = null;
          r();
        }
      });

      await page.goto('https://chatglm.cn', { waitUntil: 'domcontentloaded', timeout: 25000 });

      // 注入 Cookie 与 LocalStorage
      await page.evaluate((tok) => {
        document.cookie = `chatglm_token=${tok}; path=/; domain=.chatglm.cn`;
        document.cookie = `token=${tok}; path=/; domain=.chatglm.cn`;
        document.cookie = `access_token=${tok}; path=/; domain=.chatglm.cn`;
        localStorage.setItem('chatglm_token', tok);
        localStorage.setItem('token', tok);
        localStorage.setItem('access_token', tok);
        localStorage.setItem('chatglm_user', JSON.stringify({ token: tok, access_token: tok, is_login: true }));
      }, cleanToken);

      await page.goto('https://chatglm.cn', { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});

      // 关闭可能的弹窗遮罩
      await page.evaluate(() => {
        document.querySelectorAll<HTMLElement>('.el-dialog__headerbtn, .close-icon, [class*="modal-close"], [class*="dialog-close"]').forEach(el => el.click());
      }).catch(() => {});

      // 寻找输入框并输入
      const inputEl = await page.$('textarea, [contenteditable="true"]');
      if (!inputEl) {
        throw new Error('智谱 ChatGLM 输入框定位失败，请检查账号 Token 是否有效');
      }

      await inputEl.focus();
      await page.keyboard.type(prompt, { delay: 10 });
      await page.waitForTimeout(300);

      // 发送消息
      const sendBtn = await page.$('.enter_icon, .enter-icon-container, .send-btn, .enter-btn, button[class*="send"], div[class*="send"], [class*="submit"]');
      if (sendBtn) {
        await sendBtn.click();
      } else {
        await page.keyboard.press('Enter');
      }

      let pendingBuffer = '';
      let lastThinkLength = 0;
      let lastTextLength = 0;
      const timeoutMs = 90000;
      const startTime = Date.now();

      while (!isEnded || queue.length > 0) {
        if (queue.length === 0) {
          if (Date.now() - startTime > timeoutMs) break;
          await Promise.race([
            new Promise<void>((r) => { resolveNext = () => r(); }),
            new Promise<void>((r) => setTimeout(r, 500)),
          ]);
          continue;
        }

        const rawChunk = queue.shift();
        if (!rawChunk) continue;
        pendingBuffer += rawChunk;
        const lines = pendingBuffer.split('\n');
        pendingBuffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const dataStr = trimmed.replace(/^data:\s*/, '').trim();
          if (!dataStr || dataStr === '[DONE]') continue;

          try {
            const parsed = JSON.parse(dataStr) as {
              meta_data?: { search_result?: Array<{ title?: string; name?: string; link?: string; url?: string }> };
              parts?: Array<{
                content?: Array<{
                  type?: string;
                  text?: string;
                  think?: string;
                  image?: Array<{ image_url?: string; url?: string } | string>;
                  image_url?: string;
                  url?: string;
                }>;
                image?: Array<{ image_url?: string; url?: string } | string>;
              }>;
            };

            // 搜索引用提取
            if (Array.isArray(parsed.meta_data?.search_result)) {
              for (const item of parsed.meta_data.search_result) {
                if (item.title || item.name || item.link || item.url) {
                  yield {
                    type: 'search.citation',
                    title: item.title || item.name || '',
                    url: item.link || item.url || ''
                  };
                }
              }
            }

            // 思维链与回答内容增量提取
            if (Array.isArray(parsed.parts)) {
              for (const part of parsed.parts) {
                if (Array.isArray(part.image)) {
                  for (const img of part.image) {
                    const rawUrl = typeof img === 'string' ? img : (img?.image_url || img?.url || '');
                    if (rawUrl) {
                      const localUrl = await saveRemoteMedia(rawUrl, 'glm_img');
                      yield { type: 'image.created', url: localUrl };
                    }
                  }
                }

                if (Array.isArray(part.content)) {
                  for (const c of part.content) {
                    if ((c.type === 'think' || c.type === 'thought' || c.type === 'thinking' || c.type === 'reasoning') && (c.think || c.text)) {
                      const fullThink = c.think || c.text || '';
                      const delta = fullThink.slice(lastThinkLength);
                      if (delta) {
                        lastThinkLength = fullThink.length;
                        yield { type: 'reasoning.summary.delta', text: delta };
                      }
                    } else if (c.type === 'image') {
                      const images = Array.isArray(c.image) ? c.image : (c.image_url || c.url ? [c.image_url || c.url || ''] : []);
                      for (const img of images) {
                        const rawUrl = typeof img === 'string' ? img : (img?.image_url || img?.url || '');
                        if (rawUrl) {
                          const localUrl = await saveRemoteMedia(rawUrl, 'glm_img');
                          yield { type: 'image.created', url: localUrl };
                        }
                      }
                    } else if (c.type === 'text' && c.text) {
                      const fullText = c.text;
                      const delta = fullText.slice(lastTextLength);
                      if (delta) {
                        lastTextLength = fullText.length;
                        yield { type: 'message.delta', text: delta };
                      }
                    }
                  }
                }
              }
            }
          } catch {}
        }
      }

      yield { type: 'completed' };
    } finally {
      await context.close().catch(() => {});
      browserSupervisor.release(account.id);
    }
  }
}
