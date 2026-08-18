import { credentialsFor } from '../credentials.js';
import type { Account } from '../accounts.js';
import type { ProviderAdapter, ProviderEvent, ProviderRequest } from './types.js';
import { browserSupervisor } from '../browser.js';
import { saveRemoteMedia } from '../media.js';
import { extractConversationContent } from '../multimodal.js';

function extractQwenToken(raw: string): { bearer: string; cookie: string } {
  const clean = raw.trim();
  if (clean.startsWith('eyJ') || clean.startsWith('Bearer eyJ')) {
    const b = clean.replace(/^Bearer\s+/i, '');
    return { bearer: b, cookie: `token=${b}` };
  }
  const tokenMatch = clean.match(/(?:^|;\s*)token=([^;]+)/);
  if (tokenMatch) {
    return { bearer: tokenMatch[1], cookie: clean };
  }
  return { bearer: '', cookie: clean };
}

export class QwenAdapter implements ProviderAdapter {
  readonly provider = 'qwen';

  async testConnection(account: Account) {
    const credentials = credentialsFor(account.id);
    const token = credentials.cookie ?? credentials.access_token ?? credentials.token;
    if (!token) return { ok: false, detail: '未配置通义千问 Qwen 凭据，请在【账号池】添加账号' };

    const { bearer, cookie } = extractQwenToken(token);
    const headers: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36'
    };
    if (bearer) headers['Authorization'] = `Bearer ${bearer}`;
    if (cookie) headers['Cookie'] = cookie;

    try {
      const res = await fetch('https://chat.qwen.ai/api/v1/auths/', { headers });
      if (res.status === 401) {
        return {
          ok: false,
          detail: '通义千问 Cookie/Token 已失效或未登录。请访问 chat.qwen.ai 登录，按 F12 在请求标头中复制 Authorization: Bearer eyJ... 或包含 token=eyJ... 的完整 Cookie'
        };
      }
      if (res.ok) {
        return { ok: true, detail: '通义千问 Qwen 登录凭据校验成功' };
      }
      return { ok: true, detail: `通义千问凭据已保存 (HTTP ${res.status})` };
    } catch {
      return { ok: true, detail: '通义千问凭据格式已保存' };
    }
  }

  async *discoverModels(_account: Account) {
    return;
  }

  async *streamTurn(request: ProviderRequest, account: Account): AsyncIterable<ProviderEvent> {
    const credentials = credentialsFor(account.id);
    const rawToken = credentials.cookie ?? credentials.access_token ?? credentials.token ?? '';

    if (!rawToken) {
      throw new Error('未配置通义千问 Qwen 凭据，请在【账号池】添加账号凭据');
    }

    const { systemPrompt, latestText, images } = extractConversationContent(request.messages);
    let prompt = latestText || '请帮我分析这张图片';
    if (systemPrompt) prompt = `[系统设定]: ${systemPrompt}\n\n${prompt}`;
    const model = request.model || 'qwen3.8-max';

    // 使用自动化无头浏览器仿真驱动
    yield* this.streamInBrowser(prompt, images, rawToken, model, account);
  }

  private async *streamInBrowser(prompt: string, images: string[], rawToken: string, _model: string, account: Account): AsyncIterable<ProviderEvent> {
    const browser = await browserSupervisor.getBrowser();
    const { bearer, cookie } = extractQwenToken(rawToken);

    const cookies = cookie.split(';').map(pair => {
      const [name, ...val] = pair.trim().split('=');
      return {
        name: (name || '').trim(),
        value: (val.join('=') || '').trim(),
        domain: '.qwen.ai',
        path: '/'
      };
    }).filter(c => c.name && c.value);

    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    });

    if (cookies.length > 0) {
      await context.addCookies(cookies);
    }

    // 挂载全局 fetch 流式打字机进度拦截器
    await context.addInitScript(() => {
      const origFetch = window.fetch;
      window.fetch = async function (url, options) {
        const res = await origFetch.apply(this, [url as string, options]);
        const urlStr = typeof url === 'string' ? url : ((url as { url?: string })?.url || '');
        if (urlStr.includes('/api/v2/chat/completions') || urlStr.includes('/chat/completions')) {
          try {
            const clonedRes = res.clone();
            if (clonedRes.body) {
              const reader = clonedRes.body.getReader();
              const decoder = new TextDecoder();
              void (async () => {
                try {
                  while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    const chunkText = decoder.decode(value, { stream: true });
                    if (chunkText && (window as unknown as { __qwen_push_chunk?: (s: string) => void }).__qwen_push_chunk) {
                      (window as unknown as { __qwen_push_chunk: (s: string) => void }).__qwen_push_chunk(chunkText);
                    }
                  }
                } catch {
                } finally {
                  if ((window as unknown as { __qwen_end_stream?: () => void }).__qwen_end_stream) {
                    (window as unknown as { __qwen_end_stream: () => void }).__qwen_end_stream();
                  }
                }
              })();
            }
          } catch {}
        }
        return res;
      };
    });

    try {
      const page = await context.newPage();
      const queue: string[] = [];
      let resolveNext: (() => void) | null = null;
      let isEnded = false;

      const isImageModel = _model.toLowerCase().includes('image') || _model.toLowerCase().includes('wanx') || _model.toLowerCase().includes('draw');
      const capturedImages: string[] = [];

      await page.exposeFunction('__qwen_push_chunk', (chunkText: string) => {
        queue.push(chunkText);
        if (resolveNext) {
          const r = resolveNext;
          resolveNext = null;
          r();
        }
      });

      await page.exposeFunction('__qwen_end_stream', () => {
        isEnded = true;
        if (resolveNext) {
          const r = resolveNext;
          resolveNext = null;
          r();
        }
      });

      if (bearer) {
        await page.addInitScript((tok) => {
          localStorage.setItem('token', tok);
          localStorage.setItem('access_token', tok);
        }, bearer);
      }

      await page.goto('https://chat.qwen.ai/', { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
      await page.waitForTimeout(2000);

      // 如果有多模态图片，通过文件输入控件上传图片
      if (images.length > 0) {
        for (let i = 0; i < images.length; i++) {
          const rawImg = images[i];
          let buffer: Buffer;
          let mime = 'image/png';
          if (rawImg.startsWith('data:')) {
            const commaIdx = rawImg.indexOf(',');
            if (commaIdx !== -1) {
              const header = rawImg.slice(0, commaIdx);
              const match = header.match(/^data:([^;]+);base64/i);
              if (match) mime = match[1];
              buffer = Buffer.from(rawImg.slice(commaIdx + 1).replace(/\s+/g, ''), 'base64');
            } else {
              buffer = Buffer.from(rawImg.replace(/\s+/g, ''), 'base64');
            }
          } else if (rawImg.startsWith('http://') || rawImg.startsWith('https://')) {
            const res = await fetch(rawImg);
            const arr = await res.arrayBuffer();
            buffer = Buffer.from(arr);
            mime = res.headers.get('content-type') || mime;
          } else {
            buffer = Buffer.from(rawImg.replace(/\s+/g, ''), 'base64');
          }

          const fileInput = page.locator('input[type="file"]').first();
          if (await fileInput.count() > 0) {
            await fileInput.setInputFiles({
              name: `image_${i + 1}.png`,
              mimeType: mime,
              buffer
            }).catch(() => {});
            await page.waitForTimeout(1500);
          }
        }
      }

      // 定位输入框并输入
      const inputEl = page.locator('textarea, [contenteditable="true"]').first();
      if (await inputEl.count() === 0) {
        throw new Error('无法定位通义千问输入框，请确认 Cookie 是否有效并包含登录态');
      }

      // 仅在发送当前轮次提问后才开始监听图片生成网络请求，避免抓取历史会话或首页头像/缩略图
      page.on('request', (req) => {
        const u = req.url();
        if (u.includes('avatar') || u.includes('logo') || u.includes('icon') || u.endsWith('.svg') || u.endsWith('.ico')) return;
        if ((u.includes('cdn.qwenlm.ai/output/') || u.includes('dashscope-result') || u.includes('image_gen')) && (u.includes('.png') || u.includes('.jpg') || u.includes('.jpeg') || u.includes('.webp') || u.includes('oss-'))) {
          if (!capturedImages.includes(u)) {
            capturedImages.push(u);
          }
        }
      });

      await inputEl.click();
      await inputEl.fill(prompt);
      await page.waitForTimeout(400);

      const sendBtn = page.locator('button[aria-label*="发送"], button[type="submit"], .send-button, .chat-input-send-button').first();
      if (await sendBtn.count() > 0 && await sendBtn.isEnabled()) {
        await sendBtn.click();
      } else {
        await page.keyboard.press('Enter');
      }

      let pendingBuffer = '';
      let lastReasoningText = '';
      let fullAssistantText = '';
      const timeoutMs = 90000;
      const startTime = Date.now();
      let receivedAny = false;

      while (!isEnded || queue.length > 0) {
        if (queue.length === 0) {
          if (Date.now() - startTime > timeoutMs) break;
          await Promise.race([
            new Promise<void>((r) => { resolveNext = () => r(); }),
            new Promise<void>((r) => setTimeout(r, 400)),
          ]);
          continue;
        }

        const rawChunk = queue.shift();
        if (!rawChunk) continue;
        pendingBuffer += rawChunk;

        if (pendingBuffer.includes('FAIL_SYS_USER_VALIDATE') || pendingBuffer.includes('_____tmd_____')) {
          throw new Error('Qwen 触发安全人机验证 (x5sec/punish)，请在浏览器中访问 chat.qwen.ai 完成验证并重新提取 Cookie');
        }

        const lines = pendingBuffer.split('\n');
        pendingBuffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const dataStr = trimmed.replace(/^data:\s*/, '').trim();
          if (!dataStr || dataStr === '[DONE]') continue;

          try {
            const parsed = JSON.parse(dataStr) as {
              choices?: Array<{
                delta?: {
                  content?: string;
                  reasoning_content?: string;
                  reasoning?: string;
                  phase?: string;
                  extra?: { summary_thought?: { content?: string[] | string } };
                };
              }>;
              phase?: string;
              output?: { text?: string; reasoning_content?: string };
              text?: string;
            };

            const delta = parsed.choices?.[0]?.delta;
            const phase = delta?.phase || parsed?.phase || '';

            // 1. 思考链
            let reasoning = '';
            if (phase === 'thinking_summary' || phase === 'thinking') {
              const summaryThought = delta?.extra?.summary_thought?.content;
              if (Array.isArray(summaryThought)) {
                reasoning = summaryThought.join('');
              } else if (typeof summaryThought === 'string') {
                reasoning = summaryThought;
              } else {
                reasoning = delta?.reasoning_content || delta?.reasoning || delta?.content || '';
              }
            } else {
              reasoning = delta?.reasoning_content || delta?.reasoning || parsed.output?.reasoning_content || '';
            }

            if (reasoning) {
              if (reasoning.startsWith(lastReasoningText)) {
                const diffReasoning = reasoning.slice(lastReasoningText.length);
                lastReasoningText = reasoning;
                if (diffReasoning) {
                  receivedAny = true;
                  yield { type: 'reasoning.summary.delta', text: diffReasoning };
                }
              } else {
                lastReasoningText = reasoning;
                receivedAny = true;
                yield { type: 'reasoning.summary.delta', text: reasoning };
              }
            }

            // 2. 正文回答
            if (phase !== 'thinking_summary' && phase !== 'thinking') {
              const chunkText = delta?.content || parsed.output?.text || parsed.text || '';
              if (chunkText && !reasoning) {
                receivedAny = true;
                fullAssistantText += chunkText;
                yield { type: 'message.delta', text: chunkText };
              }
            }
          } catch {}
        }
      }

      // 如果流式拦截未捕获到任何内容，作为保底尝试从 DOM 节点提取已渲染的文本
      if (!receivedAny) {
        const domContent = await page.evaluate(() => {
          const items = document.querySelectorAll('[class*="message"], [class*="chat-item"], [class*="bubble"], [class*="response"], .markdown');
          const last = items[items.length - 1];
          return last?.textContent?.trim() || '';
        });
        if (domContent) {
          fullAssistantText = domContent;
          yield { type: 'message.delta', text: domContent };
        }
      }

      // 提取生图模型或回答中显式生成的图片
      // 1. 从回答正文中的 Markdown 图片链接匹配
      const textImageMatches = Array.from(fullAssistantText.matchAll(/!\[.*?\]\((https?:\/\/[^\s\)]+)\)/g)).map(m => m[1]);

      // 2. 从当前轮次最后一个对话气泡中提取生成的图片
      const domImages = await page.evaluate(() => {
        const items = document.querySelectorAll('[class*="message"], [class*="chat-item"], [class*="bubble"], [class*="response"], .markdown');
        const last = items[items.length - 1];
        if (!last) return [];
        const imgs = Array.from(last.querySelectorAll<HTMLImageElement>('img'));
        return imgs.map(i => i.src).filter(src => {
          if (!src || src.startsWith('data:image/svg') || src.includes('avatar') || src.includes('logo') || src.includes('icon')) return false;
          return src.includes('/output/') || src.includes('dashscope-result') || src.includes('image_gen');
        });
      }).catch(() => [] as string[]);

      // 仅当是生图模型，或回答中实际包含了生成图片时才派发 image.created 事件
      const candidateImages: string[] = [];
      if (textImageMatches.length > 0) {
        candidateImages.push(...textImageMatches);
      }
      if (domImages.length > 0) {
        candidateImages.push(...domImages);
      }
      if (isImageModel && capturedImages.length > 0) {
        candidateImages.push(...capturedImages);
      }

      const uniqueImageUrls = Array.from(new Set(candidateImages));
      const emittedImages = new Set<string>();

      for (const rawImgUrl of uniqueImageUrls) {
        const cleanKey = rawImgUrl.split('?')[0] || rawImgUrl;
        if (!emittedImages.has(cleanKey)) {
          emittedImages.add(cleanKey);
          try {
            const localUrl = await saveRemoteMedia(rawImgUrl, 'qwen_img');
            yield { type: 'image.created', url: localUrl };
          } catch {
            yield { type: 'image.created', url: rawImgUrl };
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
