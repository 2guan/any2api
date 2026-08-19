import { credentialsFor } from '../credentials.js';
import type { Account } from '../accounts.js';
import type { ProviderAdapter, ProviderEvent, ProviderRequest } from './types.js';
import { browserSupervisor } from '../browser.js';
import { extractConversationContent } from '../multimodal.js';

export class DeepSeekAdapter implements ProviderAdapter {
  readonly provider = 'deepseek';

  async testConnection(account: Account) {
    const credentials = credentialsFor(account.id);
    let token = credentials.user_token ?? credentials.access_token ?? credentials.token;
    if (!token) return { ok: false, detail: '未配置 DeepSeek 凭据，请在【账号池】录入' };

    if (token.startsWith('{')) {
      try {
        const parsed = JSON.parse(token) as { value?: string; token?: string };
        token = parsed.value || parsed.token || token;
      } catch {}
    }

    const cleanToken = token.replace(/^Bearer\s+/i, '').replace(/^"|"$/g, '').trim();

    try {
      const res = await fetch('https://chat.deepseek.com/api/v0/users/current', {
        headers: {
          'Authorization': `Bearer ${cleanToken}`,
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
        }
      });
      if (res.ok) {
        const data = await res.json() as { code?: number; data?: { biz_data?: { email?: string; mobile_number?: string } } };
        if (data.code === 0) {
          const email = data.data?.biz_data?.email || data.data?.biz_data?.mobile_number || '';
          return { ok: true, detail: `DeepSeek Token 校验成功（用户: ${email || '已认证'}）` };
        }
      }
      return { ok: false, detail: `DeepSeek 认证响应异常 (HTTP ${res.status})，请重新在网页端控制台提取 User Token` };
    } catch (e: unknown) {
      const err = e as Error;
      return { ok: false, detail: `DeepSeek 连接检测失败: ${err.message}` };
    }
  }

  async *discoverModels(_account: Account) {
    return;
  }

  async *streamTurn(request: ProviderRequest, account: Account): AsyncIterable<ProviderEvent> {
    const credentials = credentialsFor(account.id);
    let rawToken = credentials.user_token ?? credentials.access_token ?? credentials.token ?? '';

    if (rawToken.startsWith('{')) {
      try {
        const parsed = JSON.parse(rawToken) as { value?: string; token?: string };
        if (parsed.value) rawToken = parsed.value;
        else if (parsed.token) rawToken = parsed.token;
      } catch {}
    }

    const cleanToken = rawToken.replace(/^Bearer\s+/i, '').replace(/^"|"$/g, '').trim();
    if (!cleanToken) {
      throw new Error('当前 DeepSeek 账号尚未配置有效的 User Token，请在【使用指南】查看提取步骤并录入账号池');
    }

    const modelName = (request.model || 'deepseek-v3').toLowerCase();
    const isReasoner = modelName.includes('r1') || modelName.includes('reasoner') || modelName.includes('think') || request.reasoning?.effort !== 'off';
    const isSearch = request.webSearch ?? true;

    const { systemPrompt, latestText } = extractConversationContent(request.messages);
    let prompt = latestText || '你好';
    if (systemPrompt) {
      prompt = `[系统指示]: ${systemPrompt}\n\n${prompt}`;
    }

    // 运行仿真浏览器交互通道
    yield* this.streamInBrowser(prompt, cleanToken, isReasoner, isSearch, account);
  }

  private async *streamInBrowser(prompt: string, token: string, isReasoner: boolean, isSearch: boolean, account: Account): AsyncIterable<ProviderEvent> {
    // 1. 获取用户信息 ID（用于在 localStorage 中写入正确的用户会话模型）
    let userId: string | null = null;
    try {
      const uRes = await fetch('https://chat.deepseek.com/api/v0/users/current', {
        headers: {
          'Authorization': `Bearer ${token}`,
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
        }
      });
      if (uRes.ok) {
        const uData = await uRes.json() as { data?: { biz_data?: { id?: string } } };
        userId = uData.data?.biz_data?.id || null;
      }
    } catch {}

    const browser = await browserSupervisor.getBrowser();
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    });

    // 在页面加载前直接注入登录凭据
    await context.addInitScript(({ tok, uid }) => {
      localStorage.setItem('userToken', JSON.stringify({ value: tok, __version: '0' }));
      if (uid) {
        localStorage.setItem('__appKit_userInfo', JSON.stringify({ value: { id: uid }, __version: '0' }));
      }
      localStorage.setItem('user_session', JSON.stringify({ token: tok }));
    }, { tok: token, uid: userId });

    // 挂载全通道流式打字机拦截器 (fetch + XHR)
    await context.addInitScript(() => {
      const origFetch = window.fetch;
      window.fetch = async function (url, options) {
        const res = await origFetch.apply(this, [url as string, options]);
        const urlStr = typeof url === 'string' ? url : ((url as { url?: string })?.url || '');
        if (urlStr.includes('/api/v0/chat/completion') || urlStr.includes('/chat/completion')) {
          try {
            const cloned = res.clone();
            if (cloned.body) {
              const reader = cloned.body.getReader();
              const decoder = new TextDecoder();
              void (async () => {
                try {
                  while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    const text = decoder.decode(value, { stream: true });
                    if (text && (window as unknown as { __ds_push_chunk?: (s: string) => void }).__ds_push_chunk) {
                      (window as unknown as { __ds_push_chunk: (s: string) => void }).__ds_push_chunk(text);
                    }
                  }
                } catch {
                } finally {
                  if ((window as unknown as { __ds_end_stream?: () => void }).__ds_end_stream) {
                    (window as unknown as { __ds_end_stream: () => void }).__ds_end_stream();
                  }
                }
              })();
            }
          } catch {}
        }
        return res;
      };

      const origOpen = XMLHttpRequest.prototype.open;
      const origSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, ...args: unknown[]) {
        (this as unknown as { _url: unknown })._url = args[1];
        return (origOpen as (...a: unknown[]) => void).apply(this, args);
      } as typeof XMLHttpRequest.prototype.open;

      XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, ...args: unknown[]) {
        const xhr = this as unknown as { _url: string; addEventListener: (event: string, fn: () => void) => void; responseText: string };
        if (xhr._url && typeof xhr._url === 'string' && xhr._url.includes('/api/v0/chat/completion')) {
          let lastIndex = 0;
          xhr.addEventListener('progress', () => {
            const text = xhr.responseText || '';
            const newChunk = text.slice(lastIndex);
            lastIndex = text.length;
            if (newChunk && (window as unknown as { __ds_push_chunk?: (s: string) => void }).__ds_push_chunk) {
              (window as unknown as { __ds_push_chunk: (s: string) => void }).__ds_push_chunk(newChunk);
            }
          });
          xhr.addEventListener('loadend', () => {
            if ((window as unknown as { __ds_end_stream?: () => void }).__ds_end_stream) {
              (window as unknown as { __ds_end_stream: () => void }).__ds_end_stream();
            }
          });
        }
        return (origSend as (...a: unknown[]) => void).apply(this, args);
      } as typeof XMLHttpRequest.prototype.send;
    });

    try {
      const page = await context.newPage();
      const queue: string[] = [];
      let resolveNext: (() => void) | null = null;
      let isEnded = false;

      await page.exposeFunction('__ds_push_chunk', (chunkText: string) => {
        queue.push(chunkText);
        if (resolveNext) {
          const r = resolveNext;
          resolveNext = null;
          r();
        }
      });

      await page.exposeFunction('__ds_end_stream', () => {
        isEnded = true;
        if (resolveNext) {
          const r = resolveNext;
          resolveNext = null;
          r();
        }
      });

      // 直接进入主界面
      await page.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded', timeout: 25000 });

      // 定位输入框（等待 React 挂载）
      const inputEl = page.locator('textarea, [contenteditable="true"]').first();
      await inputEl.waitFor({ state: 'visible', timeout: 20000 });

      // 辅助函数：检查按钮是否已激活
      const isButtonActive = async (selector: string) => {
        const btn = page.locator(selector).first();
        if (await btn.count() === 0) return false;
        return btn.evaluate((el) => {
          if (el.getAttribute('aria-pressed') === 'true') return true;
          let node: HTMLElement | null = el as HTMLElement;
          while (node) {
            const cls = node.className || '';
            if (typeof cls === 'string' && (cls.includes('active') || cls.includes('selected') || cls.includes('--on') || cls.includes('ds-button--primary'))) return true;
            node = node.parentElement;
            if (!node || node === document.body) break;
          }
          return false;
        }).catch(() => false);
      };

      // 处理 深度思考 开关
      if (isReasoner) {
        const deepThinkSelector = 'xpath=//*[contains(text(), "DeepThink") or contains(text(), "深度思考")]';
        const deepThinkBtn = page.locator(deepThinkSelector).first();
        if (await deepThinkBtn.count() > 0) {
          const active = await isButtonActive(deepThinkSelector);
          if (!active) {
            await deepThinkBtn.click().catch(() => {});
            await page.waitForTimeout(200);
          }
        }
      }

      // 处理 联网搜索 开关
      if (isSearch) {
        const searchSelector = 'xpath=//*[contains(text(), "Search") or contains(text(), "联网搜索")]';
        const searchBtn = page.locator(searchSelector).first();
        if (await searchBtn.count() > 0) {
          const active = await isButtonActive(searchSelector);
          if (!active) {
            await searchBtn.click().catch(() => {});
            await page.waitForTimeout(200);
          }
        }
      }

      // 填入 Prompt 并提交
      await inputEl.click();
      await inputEl.fill(prompt);
      await page.waitForTimeout(300);

      const sendBtn = page.locator('div.ds-button--primary, div[role="button"].ds-button--circle, button[type="submit"], button[aria-label*="发送"], button[aria-label*="Send"]').first();
      if (await sendBtn.count() > 0 && !(await sendBtn.getAttribute('class'))?.includes('disabled')) {
        await sendBtn.click();
      } else {
        await inputEl.press('Enter');
      }

      let buffer = '';
      let isResponseStarted = !isReasoner;
      let hasReceivedAnyDelta = false;
      const timeoutMs = 90000;
      const startTime = Date.now();

      while (!isEnded || queue.length > 0) {
        if (queue.length === 0) {
          if (Date.now() - startTime > timeoutMs) break;
          await Promise.race([
            new Promise<void>((r) => { resolveNext = () => r(); }),
            new Promise<void>((r) => setTimeout(r, 400)),
          ]);
          continue;
        }

        const chunk = queue.shift();
        if (!chunk) continue;
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const raw = trimmed.replace(/^data:\s*/, '').trim();
          if (!raw || raw === '[DONE]') continue;

          try {
            const parsed = JSON.parse(raw) as {
              v?: string | Array<{ type?: string; content?: string; references?: Array<{ title?: string; url?: string }> }>;
              p?: string;
              o?: string;
            };

            if (parsed.p === 'response' || parsed.p === 'response/status' || (typeof parsed.v === 'string' && parsed.v.includes('RESPONSE'))) {
              isResponseStarted = true;
            }

            if (Array.isArray(parsed.v)) {
              for (const item of parsed.v) {
                if (item?.type === 'RESPONSE') isResponseStarted = true;
                if (item?.references) {
                  for (const ref of item.references) {
                    if (ref.url) yield { type: 'search.citation', title: ref.title ?? '', url: ref.url };
                  }
                }
                const textClean = (item?.content ?? '').replace(/FINISHEDSEARCH/gi, '').replace(/FINISHED/gi, '');
                if (textClean) {
                  hasReceivedAnyDelta = true;
                  if (isResponseStarted) yield { type: 'message.delta', text: textClean };
                  else yield { type: 'reasoning.summary.delta', text: textClean };
                }
              }
            } else if (typeof parsed.v === 'string') {
              const textClean = parsed.v.replace(/FINISHEDSEARCH/gi, '').replace(/FINISHED/gi, '');
              if (textClean) {
                hasReceivedAnyDelta = true;
                if (isResponseStarted) yield { type: 'message.delta', text: textClean };
                else yield { type: 'reasoning.summary.delta', text: textClean };
              }
            }
          } catch {}
        }
      }

      // 如果流式拦截未捕获到任何增量，进行 DOM 文本兜底
      if (!hasReceivedAnyDelta) {
        const domTexts = await page.evaluate(() => {
          const els = Array.from(document.querySelectorAll('.ds-markdown, .markdown, [class*="markdown"]'));
          return els.map(el => (el as HTMLElement).innerText || '').filter(t => t.trim().length > 0);
        }).catch(() => []);

        if (domTexts.length > 0) {
          const lastDomAnswer = domTexts.at(-1)?.trim() || '';
          if (lastDomAnswer) {
            yield { type: 'message.delta', text: lastDomAnswer };
          }
        }
      }

      yield { type: 'completed' };
    } finally {
      await context.close().catch(() => {});
      browserSupervisor.release(account.id);
    }
  }
}
