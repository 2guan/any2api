export type CredentialField = {
  key: string;
  label: string;
  kind?: 'password' | 'textarea';
  hint: string;
  preferred?: boolean;
};

export type ProviderGuide = {
  id: 'chatgpt' | 'kimi' | 'deepseek' | 'glm' | 'qwen' | 'jimeng';
  name: string;
  loginUrl: string;
  credentialSummary: string;
  refreshPolicy: string;
  fields: CredentialField[];
  steps: string[];
  warning: string;
};

export const providerGuides: ProviderGuide[] = [
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    loginUrl: 'https://chatgpt.com',
    credentialSummary: 'Refresh Token 优先，其次是 Access Token 或完整会话 Cookie。',
    refreshPolicy: '内置自动续签：Refresh Token 会在临期时自动调用 OAuth 换取新 Token 并写回数据库。',
    fields: [
      { key: 'refresh_token', label: 'Refresh Token', kind: 'password', hint: '推荐。通过官方 OAuth 授权或账户导出流程获取。', preferred: true },
      { key: 'access_token', label: 'Access Token', kind: 'password', hint: '短期凭据，通常以 eyJ 开头的 JWT 格式提供。' },
      { key: 'session_cookie', label: 'Session Cookie', kind: 'textarea', hint: '粘贴完整 Cookie 字符串（包含 __Secure-next-auth.session-token）。' },
      { key: 'session_id', label: '会话 ID', kind: 'password', hint: '可选。用于持续对话会话。' }
    ],
    steps: [
      '登录你自己的 ChatGPT 网页版（https://chatgpt.com）。',
      '优先使用正式 OAuth 授权或账户导出流程获得 Refresh Token。',
      '若使用网页会话，从浏览器 F12 网络标头中复制 Authorization 或 Cookie 粘贴至账号池。',
      '保存后在连接测试中选择 gpt-5.6 或 gpt-image-2 验证。'
    ],
    warning: '提取凭据后切勿在浏览器中点击“Log out / 退出登录”，否则服务端会立即注销该 Token。关闭网页即可。'
  },
  {
    id: 'kimi',
    name: 'Kimi (月之暗面)',
    loginUrl: 'https://kimi.moonshot.cn',
    credentialSummary: '强烈推荐 Refresh Token（长达数月有效），系统全自动静默续签；亦支持 Authorization Token（临时 15 分钟）。',
    refreshPolicy: '只要填入 Refresh Token 或完整 Cookie，系统后台定时与请求前均会自动静默换发新令牌并持久化保存，彻底无需频繁手动更新。',
    fields: [
      { key: 'refresh_token', label: 'Refresh Token / 刷新令牌 (长达数月有效，强烈推荐)', kind: 'password', hint: '强烈推荐。控制台执行 localStorage.getItem(\'refresh_token\') 一键获取，实现长期免维护自动续签。', preferred: true },
      { key: 'token', label: 'Authorization Token / 访问令牌 (临时 15 分钟)', kind: 'password', hint: '可选。在 Kimi 网页按 F12 从请求头中复制（仅 15 分钟有效，建议优先录入 Refresh Token）。' },
      { key: 'session_id', label: '会话 ID', kind: 'password', hint: '可选，用于保持网页会话绑定。' }
    ],
    steps: [
      '在浏览器中登录你自己的 Kimi 网页版（https://kimi.moonshot.cn）。',
      '【推荐做法】按 F12 打开开发者工具，切换到「控制台 / Console」标签页。',
      '粘贴执行代码：localStorage.getItem(\'refresh_token\') || document.cookie.match(/k_refresh_token=([^;]+)/)?.[1] 并回车。',
      '复制输出的 Refresh Token 字符串，粘贴至账号池的「Refresh Token」字段并保存。系统将永久自动续签！',
      '【临时测试】亦可在「网络 / Network」请求标头中复制 Authorization（但仅 15 分钟有效，建议优先录入 Refresh Token）。'
    ],
    warning: '提取 Token 后切勿在网页端点击“退出登录”，否则服务端会注销该 Token。关闭网页标签页即可。'
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    loginUrl: 'https://chat.deepseek.com',
    credentialSummary: 'User Token（用户令牌）或 Authorization 请求头。控制台一行代码即可快速提取。',
    refreshPolicy: '有效期约 30 天。系统支持直连 API 与无头仿真双通道，自动识别思维链与搜索引用。',
    fields: [
      { key: 'user_token', label: 'User Token / 访问令牌', kind: 'password', hint: '推荐。控制台执行 JSON.parse(localStorage.getItem(\'userToken\')).value 快速获取。', preferred: true },
      { key: 'access_token', label: 'Bearer Token', kind: 'password', hint: '可选。从网络标头中复制 Authorization: Bearer eyJ... 字符串。' },
      { key: 'session_id', label: '会话 ID', kind: 'password', hint: '可选，用于持续对话。' }
    ],
    steps: [
      '在浏览器中登录你自己的 DeepSeek 网页版（https://chat.deepseek.com）。',
      '按 F12 打开开发者工具，切换到「控制台 / Console」标签页。',
      '粘贴执行代码：JSON.parse(localStorage.getItem(\'userToken\')).value 并回车。',
      '直接复制控制台输出的以 eyJ 开头的 Token 字符串。',
      '粘贴至账号池中保存即可！亦可在「网络 / Network」请求标头中复制 Authorization 字符串。'
    ],
    warning: '提取 Token 后切勿在网页端点击“退出登录”，否则服务端会注销该 Token。关闭网页标签页即可。'
  },
  {
    id: 'glm',
    name: '智谱 GLM',
    loginUrl: 'https://chatglm.cn',
    credentialSummary: '强烈推荐 Refresh Token（180 天长效有效），系统全自动静默续签；亦支持 Access Token（2 小时有效）。',
    refreshPolicy: '只要填入 Refresh Token 或包含 chatglm_refresh_token 的 Cookie，系统后台定时与请求前均会自动调用智谱后台续签并存入数据库，180 天免维护。',
    fields: [
      { key: 'refresh_token', label: 'Refresh Token / 刷新令牌 (180 天有效，强烈推荐)', kind: 'password', hint: '强烈推荐。控制台执行 localStorage.getItem(\'chatglm_refresh_token\') 一键获取，实现 180 天免维护自动续签。', preferred: true },
      { key: 'access_token', label: 'Authorization Token / 访问令牌 (2 小时有效)', kind: 'password', hint: '可选。在智谱网页按 F12 从请求头复制（仅 2 小时有效）。' },
      { key: 'session_id', label: '会话 ID', kind: 'password', hint: '可选。' }
    ],
    steps: [
      '在浏览器中登录你自己的智谱清言网页版（https://chatglm.cn）。',
      '【推荐做法】按 F12 打开开发者工具，切换到「控制台 / Console」标签页。',
      '粘贴执行代码：localStorage.getItem(\'chatglm_refresh_token\') || document.cookie.match(/chatglm_refresh_token=([^;]+)/)?.[1] 并回车。',
      '复制输出的 Refresh Token 字符串，粘贴至账号池的「Refresh Token」字段并保存。系统将在后台永久自动续签（180 天有效）！',
      '【临时测试】亦可在「网络 / Network」中复制 Authorization 标头（但仅 2 小时有效）。'
    ],
    warning: '提取后直接关闭网页，切勿在浏览器中点击“退出登录”按钮。'
  },
  {
    id: 'qwen',
    name: '通义千问',
    loginUrl: 'https://chat.qwen.ai',
    credentialSummary: 'Authorization Token（Bearer eyJ...）或包含 token= 的完整 Cookie。',
    refreshPolicy: '系统内置真实鉴权探测、直接 HTTP API 直连与 Playwright 无头浏览器仿真双通道。',
    fields: [
      { key: 'cookie', label: 'Authorization 或 Cookie', kind: 'textarea', hint: '推荐。从 chat.qwen.ai 网络请求标头复制 Authorization (Bearer eyJ...) 或整串 Cookie。', preferred: true },
      { key: 'access_token', label: 'Bearer Token', kind: 'password', hint: '可选。在控制台执行 localStorage.getItem(\'token\') 提取。' },
      { key: 'session_id', label: '会话 ID', kind: 'password', hint: '可选。' }
    ],
    steps: [
      '在浏览器中登录你自己的通义千问网页版（https://chat.qwen.ai）。',
      '按 F12 打开开发者工具，切换到「网络 / Network」标签页。',
      '在千问页面发送一条消息或刷新页面，在网络请求列表中点击任意 /api/ 请求（如 /api/v1/auths 或 /api/v2/chat/completions）。',
      '在右侧「标头 / Headers」中复制「Authorization」标头的值（以 Bearer eyJ... 开头）或「Cookie」标头的值。',
      '亦可在「控制台 / Console」执行 localStorage.getItem(\'token\') 提取，粘贴至账号池保存即可！'
    ],
    warning: 'Cookie / Token 包含登录会话，提取后请直接关闭网页，切勿点击“退出登录”。'
  },
  {
    id: 'jimeng',
    name: '即梦 AI',
    loginUrl: 'https://jimeng.jianying.com',
    credentialSummary: 'sessionid（会话凭据）或完整 Cookie。在控制台一行代码即可提取。',
    refreshPolicy: '支持 2K 遇限额自动无感降级 1K 重试机制，生成的画作会自动转存至本地服务器持久化托管。',
    fields: [
      { key: 'sessionid', label: 'sessionid', kind: 'password', hint: '推荐。在即梦控制台执行 document.cookie.match(/sessionid=([^;]+)/)[1] 提取 32 位字符串。', preferred: true },
      { key: 'cookie', label: '完整 Cookie', kind: 'textarea', hint: '可选。控制台执行 document.cookie 复制全部内容。' },
      { key: 'session_id', label: '任务会话 ID', kind: 'password', hint: '可选。' }
    ],
    steps: [
      '在浏览器中登录你自己的即梦 AI 网页版（https://jimeng.jianying.com）。',
      '按 F12 打开开发者工具，切换到「控制台 / Console」标签页。',
      '粘贴执行代码：document.cookie.match(/sessionid=([^;]+)/)?.[1] || document.cookie 并回车。',
      '复制输出的 sessionid（32位字符串）或整串 Cookie，粘贴至账号池保存。',
      '在【连接测试】中选择 jimeng-3.1 等绘图模型发送生图提示词即可体验！'
    ],
    warning: '提取凭据后切勿在即梦网页端点击“退出登录”，否则服务端会注销该 sessionid。'
  }
];

export function guideFor(provider: string) {
  return providerGuides.find((guide) => guide.id === provider) ?? providerGuides[0];
}
