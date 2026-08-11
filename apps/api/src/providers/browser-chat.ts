import { browserSupervisor, type BrowserCookie } from '../browser.js';
import { credentialsFor } from '../credentials.js';
import type { Account } from '../accounts.js';
import type { ProviderAdapter, ProviderEvent, ProviderRequest } from './types.js';
import type { Page, Response as BrowserResponse } from 'playwright';

type Profile = { url: string; input: string; answer: string; submit?: string; imageOutput?: boolean; cookieDomain?: string; cookieKey?: string; tokenStorage?: string[] };

function cookiePairs(value: string, domain: string): BrowserCookie[] {
  return value.split(';').map((part) => { const [name, ...parts] = part.trim().split('='); return { name, value: parts.join('='), domain, path: '/' }; }).filter((cookie) => cookie.name && cookie.value);
}

function requestText(messages: ProviderRequest['messages']) { return messages.map((message) => `${message.role}: ${typeof message.content === 'string' ? message.content : JSON.stringify(message.content)}`).join('\n'); }
function latestUserText(messages: ProviderRequest['messages']) {
  const message = [...messages].reverse().find((item) => item.role === 'user') ?? messages.at(-1);
  return typeof message?.content === 'string' ? message.content.trim() : JSON.stringify(message?.content ?? '').trim();
}
function jimengComponentId(model: string) {
  if (model.includes('3.1')) return 'high_aes_general_v31l';
  if (model.includes('5.0') || model.includes('Seedream')) return 'high_aes_general_v50l';
  return 'high_aes_general_v30l';
}

type JsonObject = Record<string, unknown>;
const asObject = (value: unknown): JsonObject => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};

export function imageUrlsFromJimengHistory(payload: unknown) {
  const record = asObject(asObject(payload).data); const detail = asObject(record.history_detail);
  const items = Array.isArray(record.item_list) ? record.item_list : Array.isArray(detail.item_list) ? detail.item_list : [];
  return items.map((item) => {
    const image = asObject(item); const common = asObject(image.common_attr);
    return [image.image_url, image.url, image.cover_url, common.cover_url].find((url): url is string => typeof url === 'string' && url.startsWith('http'));
  }).filter((url): url is string => Boolean(url));
}

export function jimengHistoryId(payload: unknown) {
  const root = asObject(payload); const data = asObject(root.data);
  const candidates = [root, data, asObject(root.aigc_data), asObject(data.aigc_data)];
  return candidates.flatMap((item) => [item.history_id, item.history_record_id]).find((id): id is string => typeof id === 'string' && id.length > 0);
}

export function imageUrlsFromJimengTaskHistory(payload: unknown, historyId: string) {
  const data = asObject(asObject(payload).data);
  return imageUrlsFromJimengHistory({ data: data[historyId] });
}

export class BrowserChatAdapter implements ProviderAdapter {
  constructor(readonly provider: string, private readonly profile: Profile) {}

  async testConnection(account: Account) {
    try {
      const { context, credentials } = await this.context(account); const page = await context.newPage();
      await page.goto(this.profile.url, { waitUntil: 'commit', timeout: 30_000 });
      const input = page.locator(this.profile.input).first(); await input.waitFor({ state: 'visible', timeout: 15_000 });
      await page.close(); browserSupervisor.release(account.id);
      return { ok: true, detail: `${this.provider} browser workspace is reachable with ${Object.keys(credentials).length} encrypted credential fields` };
    } catch (error) { browserSupervisor.release(account.id); return { ok: false, detail: error instanceof Error ? error.message : `${this.provider} browser verification failed` }; }
  }

  async *discoverModels(_account: Account) { return; }

  async *streamTurn(request: ProviderRequest, account: Account): AsyncIterable<ProviderEvent> {
    const { context } = await this.context(account); const page = await context.newPage();
    try {
      await page.goto(this.profile.url, { waitUntil: 'commit', timeout: 30_000 });
      if (this.provider === 'jimeng') {
        for (const url of await this.jimengImages(page, request)) yield { type: 'image.created', url };
        yield { type: 'completed' };
        return;
      }
      const input = page.locator(this.profile.input).first(); await input.waitFor({ state: 'visible', timeout: 15_000 });
      const knownOutputs = new Set(await this.outputs(page));
      const outputCountBeforeSend = knownOutputs.size;
      await input.fill(requestText(request.messages));
      const submit = this.profile.submit ? page.locator(this.profile.submit).first() : undefined;
      if (submit) { await submit.waitFor({ state: 'visible', timeout: 15_000 }); await submit.click(); }
      else await input.press('Enter');
      let previous = ''; let quiet = 0;
      for (let attempt = 0; attempt < 180; attempt++) {
        await page.waitForTimeout(750);
        const answers = await this.outputs(page);
        const current = answers.filter((text) => !knownOutputs.has(text)).at(-1) ?? '';
        if (current.length > previous.length) { yield { type: 'message.delta', text: current.slice(previous.length) }; previous = current; quiet = 0; }
        else if (previous) { quiet++; if (quiet >= 4) break; }
      }
      if (!previous) throw new Error(`${this.provider} did not produce a browser response; verify the saved session and complete any official login step manually`);
      yield { type: 'completed' };
    } finally { await page.close().catch(() => {}); browserSupervisor.release(account.id); }
  }

  private async jimengImages(page: Page, request: ProviderRequest) {
    const prompt = latestUserText(request.messages);
    if (!prompt) throw new Error('即梦需要绘图提示词');
    await page.waitForTimeout(1_500);
    const created = await page.evaluate(async ({ prompt, componentId }) => {
      const draft = { component_id: componentId, generate_type: 'generate', core_param: { prompt, image_ratio: '1:1', resolution: '1K', sample_count: 4, seed: Math.floor(Math.random() * 10_000_000) } };
      const response = await fetch('/mweb/v1/aigc_draft/generate?aid=513695&device_platform=web&region=CN&web_version=7.5.0&da_version=3.3.23&aigc_features=app_lip_sync', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ draft_content: JSON.stringify(draft), submit_id: `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` })
      });
      return { ok: response.ok, status: response.status, data: await response.json().catch(() => ({})) };
    }, { prompt, componentId: jimengComponentId(request.model) });
    const createdData = asObject(created.data);
    const upstreamError = [createdData.errmsg, createdData.message, asObject(createdData.data).errmsg, asObject(createdData.data).message].find((value): value is string => typeof value === 'string' && value.length > 0);
    if (!created.ok) throw new Error(`即梦生成任务提交失败 (${created.status})${upstreamError ? `：${upstreamError}` : ''}`);
    const historyId = jimengHistoryId(created.data);
    if (!historyId) throw new Error(`即梦未返回生成任务 ID${upstreamError ? `：${upstreamError}` : ''}`);

    for (let attempt = 0; attempt < 25; attempt++) {
      await page.waitForTimeout(1_500);
      const result = await page.evaluate(async (taskId) => {
        const response = await fetch('/mweb/v1/get_history_by_ids?aid=513695&device_platform=web&region=CN', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ history_ids: [taskId], image_info: { width: 2048, height: 2048, format: 'webp', image_scene_list: [{ scene: 'normal', width: 2400, height: 2400, uniq_key: '2400', format: 'webp' }, { scene: 'normal', width: 1080, height: 1080, uniq_key: '1080', format: 'webp' }] }, http_common_info: { aid: 513695 } })
        });
        return { ok: response.ok, data: await response.json().catch(() => ({})) };
      }, historyId);
      const urls = result.ok ? imageUrlsFromJimengTaskHistory(result.data, historyId) : [];
      if (urls.length >= 4 || (urls.length > 0 && attempt >= 20)) return urls.slice(0, 4);
    }
    throw new Error('即梦任务超时，未返回图片结果');
  }

  private async context(account: Account) {
    const credentials = credentialsFor(account.id); const rawCookie = credentials[this.profile.cookieKey ?? 'cookie'] ?? credentials.cookie ?? credentials.session_cookie ?? (credentials.sessionid ? `sessionid=${credentials.sessionid}` : '');
    const cookies = rawCookie.includes('=') && this.profile.cookieDomain ? cookiePairs(rawCookie, this.profile.cookieDomain) : [];
    if (!cookies.length && !this.profile.tokenStorage?.some((key) => credentials[key])) throw new Error(`${this.provider} requires a full Cookie or supported account token`);
    const token = credentials.user_token ?? credentials.access_token ?? '';
    const storage = Object.fromEntries((this.profile.tokenStorage ?? []).filter(() => token).map((key) => [key, key === 'userToken' ? JSON.stringify(token) : token]));
    return { context: await browserSupervisor.prepare(account.id, cookies, storage), credentials };
  }

  private async outputs(page: Page) {
    if (!this.profile.imageOutput) return page.locator(this.profile.answer).allTextContents();
    return page.locator(this.profile.answer).evaluateAll((items) => items.map((item) => item.getAttribute('src') ?? '').filter((src) => src.startsWith('http')));
  }
}
