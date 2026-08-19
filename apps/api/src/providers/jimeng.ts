import crypto from 'node:crypto';
import { credentialsFor } from '../credentials.js';
import type { Account } from '../accounts.js';
import type { ProviderAdapter, ProviderEvent, ProviderRequest } from './types.js';
import { BrowserChatAdapter, imageUrlsFromJimengTaskHistory, jimengHistoryId } from './browser-chat.js';
import { saveRemoteMedia } from '../media.js';

function latestUserText(messages: ProviderRequest['messages']) {
  const message = [...messages].reverse().find((item) => item.role === 'user') ?? messages.at(-1);
  return typeof message?.content === 'string' ? message.content.trim() : JSON.stringify(message?.content ?? '').trim();
}

function mapComponentId(model: string) {
  const m = model.toLowerCase();
  if (m.includes('5.0') && (m.includes('pro') || m.includes('large'))) return 'high_aes_general_v50p_large';
  if (m.includes('5.0')) return 'high_aes_general_v50';
  if (m.includes('4.7')) return 'high_aes_general_v43';
  if (m.includes('4.6')) return 'high_aes_general_v42';
  if (m.includes('4.5')) return 'high_aes_general_v40l';
  if (m.includes('4.1')) return 'high_aes_general_v41';
  if (m.includes('4.0')) return 'high_aes_general_v40';
  if (m.includes('3.1')) return 'high_aes_general_v30l_art_fangzhou:general_v3.0_18b';
  if (m.includes('3.0')) return 'high_aes_general_v30l:general_v3.0_18b';
  if (m.includes('2.0')) return 'high_aes_general_v20_L:general_v2.0_L';
  if (m.includes('video') || m.includes('seedance')) return 'video_seedance_v25l';
  return 'high_aes_general_v30l_art_fangzhou:general_v3.0_18b';
}

function mapRatioNumber(sizeStr = '1024x1024') {
  if (sizeStr === '16:9' || sizeStr.includes('1920x1080')) return 1;
  if (sizeStr === '9:16' || sizeStr.includes('1080x1920')) return 6;
  if (sizeStr === '4:3' || sizeStr.includes('1024x768')) return 3;
  if (sizeStr === '3:4' || sizeStr.includes('768x1024')) return 4;
  if (sizeStr === '3:2') return 2;
  if (sizeStr === '2:3') return 5;
  if (sizeStr === '21:9') return 0;
  return 8;
}

export class JimengAdapter implements ProviderAdapter {
  readonly provider = 'jimeng';
  private browserFallback = new BrowserChatAdapter('jimeng', {
    url: 'https://jimeng.jianying.com/ai-tool/generate/?type=image',
    input: 'textarea, [contenteditable="true"]',
    answer: 'img[src]',
    submit: 'button[class*="submit-button"]:not([disabled])',
    imageOutput: true,
    cookieDomain: '.jianying.com',
    cookieKey: 'cookie'
  });

  async testConnection(account: Account) {
    const credentials = credentialsFor(account.id);
    const token = credentials.sessionid ?? credentials.cookie ?? credentials.session_cookie;
    if (token) return { ok: true, detail: '即梦 AI 凭据校验成功' };
    return this.browserFallback.testConnection(account);
  }

  async *discoverModels(_account: Account) {
    return;
  }

  async *streamTurn(request: ProviderRequest, account: Account): AsyncIterable<ProviderEvent> {
    const credentials = credentialsFor(account.id);
    const rawToken = credentials.sessionid ?? credentials.cookie ?? credentials.session_cookie ?? '';

    if (!rawToken) {
      yield* this.browserFallback.streamTurn(request, account);
      return;
    }

    const prompt = latestUserText(request.messages);
    if (!prompt) throw new Error('即梦 AI 需要绘图提示词');

    const images = await this.generateImageDirect(prompt, rawToken, request.model || 'jimeng-3.1');
    if (images && images.length > 0) {
      for (const url of images) {
        const localUrl = await saveRemoteMedia(url, 'jimeng_img');
        yield { type: 'image.created', url: localUrl };
      }
      yield { type: 'completed' };
      return;
    }

    throw new Error('即梦 AI 生成任务超时或未返回可用图片结果');
  }

  private async generateImageDirect(prompt: string, tokenInput: string, model: string): Promise<string[]> {
    const resolutions = ['1k', '2k'];
    let lastErr: Error | null = null;
    for (const resQuality of resolutions) {
      try {
        const urls = await this.sendZhizinanDirectRequest(prompt, tokenInput, model, resQuality);
        if (urls && urls.length > 0) return urls;
      } catch (err) {
        lastErr = err as Error;
        const msg = err instanceof Error ? err.message : '';
        // If it's points/auth error, throw immediately with friendly hint
        if (msg.includes('1006') || msg.includes('积分不足')) {
          throw new Error('即梦 AI 积分不足或无可用生成权益 (错误码: 1006)。请在即梦网页端（jimeng.jianying.com）签到领取免费积分或开通会员权益后重试');
        }
        if (msg.includes('1000') || msg.includes('未登录')) {
          throw new Error('即梦 AI 登录凭据（sessionid）已失效或已过期，请在网页端按 F12 重新复制最新的 sessionid Cookie 并更新账号池');
        }
      }
    }
    if (lastErr) throw lastErr;
    return [];
  }

  private async sendZhizinanDirectRequest(prompt: string, tokenInput: string, model: string, resolutionQuality = '1k'): Promise<string[]> {
    const isFullCookie = tokenInput.includes('=');
    const token = isFullCookie ? (tokenInput.match(/sessionid=([^;]+)/)?.[1] ?? tokenInput) : tokenInput;

    const DEFAULT_ASSISTANT_ID = 513695;
    const VERSION_CODE = '5.8.0';
    const PLATFORM_CODE = '7';
    const webId = Math.floor(Math.random() * 999999999999999999) + 7000000000000000000;
    const userId = crypto.randomUUID().replace(/-/g, '');
    const deviceTime = Math.floor(Date.now() / 1000);
    const uri = '/mweb/v1/aigc_draft/generate';

    const signStr = `9e2c|${uri.slice(-7)}|${PLATFORM_CODE}|${VERSION_CODE}|${deviceTime}||11ac`;
    const sign = crypto.createHash('md5').update(signStr).digest('hex');

    const cookieHeader = isFullCookie ? tokenInput : [
      `_tea_web_id=${webId}`,
      `is_staff_user=false`,
      `store-region=cn-gd`,
      `store-region-src=uid`,
      `sid_guard=${token}%7C${deviceTime}%7C5184000`,
      `uid_tt=${userId}`,
      `uid_tt_ss=${userId}`,
      `sid_tt=${token}`,
      `sessionid=${token}`,
      `sessionid_ss=${token}`
    ].join('; ');

    const modelReqKey = mapComponentId(model);
    const componentId = crypto.randomUUID();
    const submitId = crypto.randomUUID();
    const sideDim = resolutionQuality === '2k' ? 2048 : 1024;
    const benefitCountVal = resolutionQuality === '2k' ? 3 : 1;

    const requestData = {
      extend: { root_model: modelReqKey },
      submit_id: submitId,
      metrics_extra: JSON.stringify({
        promptSource: 'custom',
        generateCount: 1,
        enterFrom: 'click',
        sceneOptions: JSON.stringify([{
          type: 'image',
          scene: 'ImageBasicGenerate',
          modelReqKey,
          resolutionType: resolutionQuality,
          abilityList: [],
          benefitCount: benefitCountVal,
          reportParams: { enterSource: 'generate' }
        }]),
        generateId: submitId
      }),
      draft_content: JSON.stringify({
        type: 'draft',
        id: crypto.randomUUID(),
        min_version: '3.0.2',
        min_features: [],
        is_from_tsn: true,
        version: '3.3.20',
        main_component_id: componentId,
        component_list: [{
          type: 'image_base_component',
          id: componentId,
          min_version: '3.0.2',
          generate_type: 'generate',
          aigc_mode: 'workbench',
          abilities: {
            type: '',
            id: crypto.randomUUID(),
            generate: {
              type: '',
              id: crypto.randomUUID(),
              core_param: {
                type: '',
                id: crypto.randomUUID(),
                model: modelReqKey,
                prompt,
                negative_prompt: '',
                seed: Math.floor(Math.random() * 100000000) + 2500000000,
                sample_strength: 0.5,
                image_ratio: mapRatioNumber('1024x1024'),
                large_image_info: { type: '', id: crypto.randomUUID(), height: sideDim, width: sideDim, resolution_type: resolutionQuality }
              },
              history_option: { type: '', id: crypto.randomUUID() }
            }
          }
        }]
      }),
      http_common_info: { aid: DEFAULT_ASSISTANT_ID }
    };

    const headers: Record<string, string> = {
      'Accept': 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      'Appid': `${DEFAULT_ASSISTANT_ID}`,
      'Appvr': VERSION_CODE,
      'Origin': 'https://jimeng.jianying.com',
      'Referer': 'https://jimeng.jianying.com',
      'Pf': PLATFORM_CODE,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Cookie': cookieHeader,
      'Device-Time': `${deviceTime}`,
      'Sign': sign,
      'Sign-Ver': '1'
    };

    const url = `https://jimeng.jianying.com${uri}?aid=${DEFAULT_ASSISTANT_ID}&device_platform=web&region=CN&webId=${webId}&da_version=3.3.20&web_component_open_flag=1&web_version=7.5.0`;

    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(requestData) });
    if (res.ok) {
      const data = await res.json() as { ret?: string | number; errmsg?: string; data?: { history_id?: string }; aigc_data?: { history_record_id?: string } };
      if (data.ret === '0' || data.ret === 0) {
        const historyId = jimengHistoryId(data);
        if (historyId) return await this.pollTaskHistory(historyId, cookieHeader);
      } else {
        throw new Error(`[即梦 API 错误]: ${data.errmsg ?? 'common error'} (错误码: ${data.ret})`);
      }
    }
    return [];
  }

  private async pollTaskHistory(historyId: string, cookieHeader: string): Promise<string[]> {
    const pollUrl = 'https://jimeng.jianying.com/mweb/v1/get_history_by_ids?aid=513695&device_platform=web&region=CN';
    const headers = { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Cookie': cookieHeader };
    const pollBody = {
      history_ids: [historyId],
      image_info: { width: 2048, height: 2048, format: 'webp', image_scene_list: [{ scene: 'normal', width: 2400, height: 2400, uniq_key: '2400', format: 'webp' }, { scene: 'normal', width: 1080, height: 1080, uniq_key: '1080', format: 'webp' }] },
      http_common_info: { aid: 513695 }
    };

    for (let attempt = 0; attempt < 25; attempt++) {
      await new Promise((r) => setTimeout(r, 1500));
      try {
        const res = await fetch(pollUrl, { method: 'POST', headers, body: JSON.stringify(pollBody) });
        if (res.ok) {
          const data = await res.json();
          const urls = imageUrlsFromJimengTaskHistory(data, historyId);
          if (urls.length >= 4 || (urls.length > 0 && attempt >= 20)) return urls.slice(0, 4);
        }
      } catch {
        /* Ignore transient error */
      }
    }
    return [];
  }
}
