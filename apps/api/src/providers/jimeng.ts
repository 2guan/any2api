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

function defaultImageCountForModel(model: string, requestedN?: number): number {
  if (typeof requestedN === 'number' && requestedN > 0) return requestedN;
  const m = model.toLowerCase();
  // 4.7 默认生成 1 张
  if (m.includes('4.7')) return 1;
  // 3.1 默认生成 4 张
  if (m.includes('3.1')) return 4;
  if (m.includes('3.0')) return 4;
  return 1;
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

function crc32(buffer: Buffer): number {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    crc = (table[(crc ^ buffer[i]!) & 0xff]! ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function generateAWSAuthorizationHeader(
  accessKeyID: string,
  secretAccessKey: string,
  sessionToken: string,
  region: string,
  service: string,
  requestMethod: string,
  requestParams: Record<string, any>,
  requestBody: Record<string, any> = {}
) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:\-]|\\.\d{3}/g, '').slice(0, 15) + 'Z';
  const amzDay = amzDate.substring(0, 8);
  const requestHeaders: Record<string, string> = { 'X-Amz-Date': amzDate, 'X-Amz-Security-Token': sessionToken };
  if (Object.keys(requestBody).length > 0) {
    requestHeaders['X-Amz-Content-Sha256'] = crypto.createHash('sha256').update(JSON.stringify(requestBody)).digest('hex');
  }
  const credentialString = `${amzDay}/${region}/${service}/aws4_request`;
  const signedHeaders = Object.keys(requestHeaders).map(k => k.toLowerCase()).sort().join(';');
  const canonicalHeaders = Object.keys(requestHeaders).sort().map(k => `${k.toLowerCase()}:${requestHeaders[k]}`).join('\n') + '\n';
  const bodyHash = Object.keys(requestBody).length > 0
    ? crypto.createHash('sha256').update(JSON.stringify(requestBody)).digest('hex')
    : crypto.createHash('sha256').update('').digest('hex');
  const canonicalRequest = [requestMethod.toUpperCase(), '/', new URLSearchParams(requestParams).toString(), canonicalHeaders, signedHeaders, bodyHash].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialString, crypto.createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');
  const kDate = crypto.createHmac('sha256', `AWS4${secretAccessKey}`).update(amzDay).digest();
  const kRegion = crypto.createHmac('sha256', kDate).update(region).digest();
  const kService = crypto.createHmac('sha256', kRegion).update(service).digest();
  const signingKey = crypto.createHmac('sha256', kService).update('aws4_request').digest();
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  return { ...requestHeaders, 'Authorization': `AWS4-HMAC-SHA256 Credential=${accessKeyID}/${credentialString}, SignedHeaders=${signedHeaders}, Signature=${signature}` };
}

async function uploadImageToJimeng(token: string, imageSource: string): Promise<string> {
  let buffer: Buffer;
  if (imageSource.startsWith('data:image/')) {
    const base64Data = imageSource.split(';base64,')[1] ?? imageSource.split(',')[1] ?? '';
    buffer = Buffer.from(base64Data, 'base64');
  } else if (imageSource.startsWith('http://') || imageSource.startsWith('https://')) {
    const res = await fetch(imageSource);
    if (!res.ok) throw new Error(`获取参考图失败 (${res.status}): ${imageSource}`);
    const ab = await res.arrayBuffer();
    buffer = Buffer.from(ab);
  } else {
    // Treat as raw base64 or file path
    buffer = Buffer.from(imageSource, 'base64');
  }

  const tokenRes = await fetch('https://jimeng.jianying.com/mweb/v1/get_upload_token?aid=513695&da_version=3.2.2&aigc_features=app_lip_sync', {
    method: 'POST',
    headers: {
      'Cookie': `sessionid=${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    },
    body: JSON.stringify({ scene: 2 })
  });
  if (!tokenRes.ok) {
    throw new Error(`即梦获取上传 Token 失败 (${tokenRes.status})`);
  }
  const tokenData = await tokenRes.json() as any;
  const uploadAuth = tokenData.data || tokenData;
  const { access_key_id, secret_access_key, session_token } = uploadAuth;
  if (!access_key_id || !secret_access_key || !session_token) {
    throw new Error('即梦上传 Token 返回异常，可能 Cookie/sessionid 已失效');
  }

  const crc32Val = (crc32(buffer) >>> 0).toString(16);
  const applyParams = {
    Action: 'ApplyImageUpload',
    FileSize: buffer.length,
    ServiceId: 'tb4s082cfz',
    Version: '2018-08-01',
    s: Math.random().toString(36).substring(2, 12)
  };
  const applyHeaders = generateAWSAuthorizationHeader(access_key_id, secret_access_key, session_token, 'cn-north-1', 'imagex', 'GET', applyParams);
  const applyRes = await fetch(`https://imagex.bytedanceapi.com/?${new URLSearchParams(applyParams as any).toString()}`, {
    headers: applyHeaders
  });
  const applyData = await applyRes.json() as any;
  const UploadAddress = applyData?.Result?.UploadAddress;
  if (!UploadAddress?.UploadHosts?.[0] || !UploadAddress?.StoreInfos?.[0]) {
    throw new Error(`即梦申请上传通道失败: ${JSON.stringify(applyData)}`);
  }

  const uploadImgUrl = `https://${UploadAddress.UploadHosts[0]}/upload/v1/${UploadAddress.StoreInfos[0].StoreUri}`;
  const putRes = await fetch(uploadImgUrl, {
    method: 'POST',
    headers: {
      Authorization: UploadAddress.StoreInfos[0].Auth,
      'Content-Crc32': crc32Val,
      'Content-Type': 'application/octet-stream'
    },
    body: new Uint8Array(buffer)
  });
  const putData = await putRes.json() as any;
  if (putData?.code !== 2000) {
    throw new Error(`即梦上传二进制图片失败: ${JSON.stringify(putData)}`);
  }

  const commitParams = { Action: 'CommitImageUpload', FileSize: buffer.length, ServiceId: 'tb4s082cfz', Version: '2018-08-01' };
  const commitBody = { SessionKey: UploadAddress.SessionKey };
  const commitHeaders = generateAWSAuthorizationHeader(access_key_id, secret_access_key, session_token, 'cn-north-1', 'imagex', 'POST', commitParams, commitBody);
  const commitRes = await fetch(`https://imagex.bytedanceapi.com/?${new URLSearchParams(commitParams as any).toString()}`, {
    method: 'POST',
    headers: { ...commitHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify(commitBody)
  });
  const commitData = await commitRes.json() as any;
  const uri = commitData?.Result?.Results?.[0]?.Uri;
  if (!uri) throw new Error(`即梦提交图片结果失败: ${JSON.stringify(commitData)}`);
  return uri;
}

function extractReferenceImages(messages: ProviderRequest['messages']): { prompt: string; referenceImages: string[] } {
  const referenceImages: string[] = [];
  let prompt = '';

  for (const msg of messages) {
    if (msg.role !== 'user') continue;
    if (typeof msg.content === 'string') {
      let text = msg.content;
      // Extract [Init Image: ...]
      text = text.replace(/\[Init Image:\s*([^\]]+)\]/g, (_, img) => {
        referenceImages.push(img.trim());
        return '';
      });
      // Extract markdown images ![...](url)
      text = text.replace(/!\[[^\]]*\]\(([^)]+)\)/g, (_, img) => {
        referenceImages.push(img.trim());
        return '';
      });
      prompt = text.trim();
    } else if (Array.isArray(msg.content)) {
      const parts: string[] = [];
      for (const item of msg.content) {
        if (!item || typeof item !== 'object') continue;
        const part = item as Record<string, any>;
        if (part.type === 'text' && typeof part.text === 'string') {
          let text = part.text;
          text = text.replace(/\[Init Image:\s*([^\]]+)\]/g, (_, img) => {
            referenceImages.push(img.trim());
            return '';
          });
          text = text.replace(/!\[[^\]]*\]\(([^)]+)\)/g, (_, img) => {
            referenceImages.push(img.trim());
            return '';
          });
          parts.push(text.trim());
        } else if (part.type === 'image_url') {
          const url = part.image_url?.url || part.imageUrl?.url;
          if (url && typeof url === 'string') {
            referenceImages.push(url.trim());
          }
        }
      }
      prompt = parts.join(' ').trim();
    }
  }

  // Deduplicate reference images
  const uniqueImages = [...new Set(referenceImages)].filter(Boolean);
  return { prompt: prompt || latestUserText(messages), referenceImages: uniqueImages };
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

    const { prompt, referenceImages } = extractReferenceImages(request.messages);
    if (!prompt) throw new Error('即梦 AI 需要绘图提示词');

    const model = request.model || 'seedream-4.7';
    const targetCount = defaultImageCountForModel(model, request.n);
    const size = request.size || '1024x1024';

    const images = await this.generateImageDirect(prompt, rawToken, model, targetCount, size, referenceImages);
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

  private async generateImageDirect(
    prompt: string,
    tokenInput: string,
    model: string,
    targetCount = 1,
    size = '1024x1024',
    referenceImages: string[] = []
  ): Promise<string[]> {
    const isFullCookie = tokenInput.includes('=');
    const token = isFullCookie ? (tokenInput.match(/sessionid=([^;]+)/)?.[1] ?? tokenInput) : tokenInput;

    // Upload reference images if any
    const referenceUris: string[] = [];
    for (const refImg of referenceImages) {
      try {
        const uri = await uploadImageToJimeng(token, refImg);
        if (uri) referenceUris.push(uri);
      } catch (err) {
        throw new Error(`即梦上传参考图失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const resolutions = ['1k', '2k'];
    let lastErr: Error | null = null;
    for (const resQuality of resolutions) {
      try {
        const urls = await this.sendZhizinanDirectRequest(prompt, tokenInput, model, resQuality, targetCount, size, referenceUris);
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

  private async sendZhizinanDirectRequest(
    prompt: string,
    tokenInput: string,
    model: string,
    resolutionQuality = '1k',
    targetCount = 1,
    size = '1024x1024',
    referenceUris: string[] = []
  ): Promise<string[]> {
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
    const benefitCountVal = targetCount;
    const isBlend = referenceUris.length > 0;

    const requestData: Record<string, any> = {
      extend: { root_model: modelReqKey },
      submit_id: submitId,
      http_common_info: { aid: DEFAULT_ASSISTANT_ID }
    };

    if (!isBlend) {
      requestData.metrics_extra = JSON.stringify({
        promptSource: 'custom',
        generateCount: targetCount,
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
      });
    }

    const componentAbilities: Record<string, any> = isBlend
      ? {
        type: '',
        id: crypto.randomUUID(),
        blend: {
          type: '',
          id: crypto.randomUUID(),
          min_features: [],
          core_param: {
            type: '',
            id: crypto.randomUUID(),
            model: modelReqKey,
            prompt: `${prompt}##`,
            sample_strength: 0.5,
            image_ratio: mapRatioNumber(size),
            large_image_info: { type: '', id: crypto.randomUUID(), height: sideDim, width: sideDim, resolution_type: resolutionQuality }
          },
          ability_list: [{
            type: '',
            id: crypto.randomUUID(),
            name: 'byte_edit',
            image_uri_list: referenceUris,
            image_list: referenceUris.map((uri) => ({
              type: 'image',
              id: crypto.randomUUID(),
              source_from: 'upload',
              platform_type: 1,
              name: '',
              image_uri: uri,
              width: 0,
              height: 0,
              format: '',
              uri
            })),
            strength: 0.5
          }],
          history_option: { type: '', id: crypto.randomUUID() },
          prompt_placeholder_info_list: [{ type: '', id: crypto.randomUUID(), ability_index: 0 }],
          postedit_param: { type: '', id: crypto.randomUUID(), generate_type: 0 }
        },
        gen_option: {
          type: '',
          id: crypto.randomUUID(),
          gen_count: targetCount,
          generate_all: false
        }
      }
      : {
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
            image_ratio: mapRatioNumber(size),
            large_image_info: { type: '', id: crypto.randomUUID(), height: sideDim, width: sideDim, resolution_type: resolutionQuality },
            generate_type: 0
          },
          history_option: { type: '', id: crypto.randomUUID() }
        },
        gen_option: {
          type: '',
          id: crypto.randomUUID(),
          gen_count: targetCount,
          generate_all: false
        }
      };

    requestData.draft_content = JSON.stringify({
      type: 'draft',
      id: crypto.randomUUID(),
      min_version: '3.0.2',
      min_features: [],
      is_from_tsn: true,
      version: '3.0.2',
      main_component_id: componentId,
      component_list: [{
        type: 'image_base_component',
        id: componentId,
        min_version: '3.0.2',
        generate_type: isBlend ? 'blend' : 'generate',
        aigc_mode: 'workbench',
        gen_type: 1,
        abilities: componentAbilities
      }]
    });

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
        if (historyId) return await this.pollTaskHistory(historyId, cookieHeader, targetCount);
      } else {
        throw new Error(`[即梦 API 错误]: ${data.errmsg ?? 'common error'} (错误码: ${data.ret})`);
      }
    }
    return [];
  }

  private async pollTaskHistory(historyId: string, cookieHeader: string, expectedCount = 1): Promise<string[]> {
    const pollUrl = 'https://jimeng.jianying.com/mweb/v1/get_history_by_ids?aid=513695&device_platform=web&region=CN';
    const headers = { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Cookie': cookieHeader };
    const pollBody = {
      history_ids: [historyId],
      image_info: { width: 2048, height: 2048, format: 'webp', image_scene_list: [{ scene: 'normal', width: 2400, height: 2400, uniq_key: '2400', format: 'webp' }, { scene: 'normal', width: 1080, height: 1080, uniq_key: '1080', format: 'webp' }] },
      http_common_info: { aid: 513695 }
    };

    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const res = await fetch(pollUrl, { method: 'POST', headers, body: JSON.stringify(pollBody) });
        if (res.ok) {
          const data = await res.json() as any;
          const rec = data?.data?.[historyId];
          const urls = imageUrlsFromJimengTaskHistory(data, historyId);
          if (urls.length >= expectedCount || (urls.length > 0 && attempt >= 20)) {
            return urls.slice(0, expectedCount);
          }
          if (rec?.status === 30 && (!urls || urls.length === 0)) {
            const failMsg = rec.fail_msg || rec.failed_item_list?.[0]?.gen_result_data?.result_msg || '任务生成失败';
            throw new Error(`即梦生成任务失败: ${failMsg} (错误码: ${rec.fail_code ?? 30})`);
          }
        }
      } catch (err) {
        if (err instanceof Error && err.message.includes('即梦生成任务失败')) throw err;
        /* Ignore transient poll errors */
      }
    }
    return [];
  }
}
