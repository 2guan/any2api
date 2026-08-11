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
    id: 'chatgpt', name: 'ChatGPT', loginUrl: 'https://chatgpt.com', credentialSummary: 'Refresh Token 优先，其次是 Access Token 或完整会话 Cookie。', refreshPolicy: 'Refresh Token 可在支持的、已授权流程中轮换。会话 Cookie 与 Access Token 失效后需要人工重新授权。',
    fields: [
      { key: 'refresh_token', label: 'Refresh Token', kind: 'password', hint: '推荐。仅填写由你本人在受支持授权流程中获得的值。', preferred: true },
      { key: 'access_token', label: 'Access Token', kind: 'password', hint: '短期凭据，通常以 JWT 形式提供。' },
      { key: 'session_cookie', label: 'Session Cookie', kind: 'textarea', hint: '粘贴完整 Cookie 字符串，不要只填 cookie 名称。' },
      { key: 'session_id', label: '会话 ID', kind: 'password', hint: '可选。仅用于恢复你自己的持续会话。' }
    ],
    steps: ['登录你自己的 ChatGPT 账户。', '优先使用正式可用的 OAuth 授权或账户导出流程获得 Refresh Token。', '若仅有网页会话，请从自己的浏览器会话中复制完整 Cookie，并在账号池中粘贴。', '保存后在连接测试中验证。出现登录、MFA 或验证码时由管理员在官方页面完成。'],
    warning: '不要录入他人账号、验证码或未获授权的会话数据。当前 2.0 不会绕过登录验证或自动处理验证码。'
  },
  {
    id: 'kimi', name: 'Kimi', loginUrl: 'https://kimi.moonshot.cn', credentialSummary: '以 Refresh Token 为主，可选保存当前 Access Token 与会话 ID。', refreshPolicy: '刷新调度器会在过期前尝试刷新。刷新失败会转为“需要人工处理”。',
    fields: [
      { key: 'refresh_token', label: 'Refresh Token', kind: 'password', hint: '推荐的长期授权材料。', preferred: true },
      { key: 'access_token', label: 'Access Token', kind: 'password', hint: '可选的当前访问令牌。' },
      { key: 'session_id', label: '会话 ID', kind: 'password', hint: '可选，用于保持网页会话绑定。' }
    ],
    steps: ['登录你自己的 Kimi 网页账户。', '通过该账户允许的授权或会话管理方式取得 Refresh Token。', '将 Refresh Token 粘贴到账号池，Access Token 仅作为补充。', '连接测试通过后，平台才会将该账号标记为可调度。'],
    warning: '不要频繁退出或切换同一网页会话。授权材料只应保存在本机已加密的账号池中。'
  },
  {
    id: 'deepseek', name: 'DeepSeek', loginUrl: 'https://chat.deepseek.com', credentialSummary: 'User Token 或 Bearer Token 为主，可选保存会话 ID。', refreshPolicy: '若渠道没有公开的 refresh 能力，失效后会停用并要求管理员更新令牌。',
    fields: [
      { key: 'user_token', label: 'User Token', kind: 'password', hint: '优先填写你本人账户的用户令牌。', preferred: true },
      { key: 'access_token', label: 'Bearer Token', kind: 'password', hint: '可选的替代访问令牌。' },
      { key: 'session_id', label: '会话 ID', kind: 'password', hint: '可选，用于持续对话。' }
    ],
    steps: ['登录自己的 DeepSeek 网页账户。', '仅从自己已登录的浏览器会话或正式账户功能中取得可用令牌。', '先粘贴 User Token，必要时补充会话 ID。', '使用连接测试检查推理和搜索能力是否已被该账户授予。'],
    warning: '令牌失效后请重新登录官方页面更新。不要用重试或高并发请求掩盖认证失败。'
  },
  {
    id: 'glm', name: '智谱 GLM', loginUrl: 'https://chatglm.cn', credentialSummary: 'Authorization Token 为主，支持同时保存 Refresh Token 与会话 ID。', refreshPolicy: '同时具备 Refresh Token 时优先刷新，否则按 Access Token 有效期监控。',
    fields: [
      { key: 'access_token', label: 'Authorization Token', kind: 'password', hint: '主要凭据。', preferred: true },
      { key: 'refresh_token', label: 'Refresh Token', kind: 'password', hint: '可选。提供后可参与自动刷新。' },
      { key: 'session_id', label: '会话 ID', kind: 'password', hint: '可选。' }
    ],
    steps: ['登录你自己的智谱清言或 GLM 网页账户。', '按账户允许的方式取得 Authorization Token。', '如同时获得 Refresh Token，请一并录入以启用刷新计划。', '保存后通过连接测试确认该账号实际可见的模型。'],
    warning: '不要把开发者 API Key 与网页账户 Token 混在同一账号记录。它们的权限和生命周期不同。'
  },
  {
    id: 'qwen', name: '通义千问', loginUrl: 'https://chat.qwen.ai', credentialSummary: '完整 Cookie 优先，可选 Bearer Token 与会话 ID。', refreshPolicy: 'Cookie 失效、跳转登录页或风控挑战都会转为人工重新认证。',
    fields: [
      { key: 'cookie', label: '完整 Cookie', kind: 'textarea', hint: '推荐。需包含该网页会话实际使用的登录凭据。', preferred: true },
      { key: 'access_token', label: 'Bearer Token', kind: 'password', hint: '可选。' },
      { key: 'session_id', label: '会话 ID', kind: 'password', hint: '可选。' }
    ],
    steps: ['登录你自己的通义千问网页账户。', '从该账户当前浏览器会话中复制完整 Cookie，而非单个不完整字段。', '录入后先运行连接测试，确认模型目录与能力。', '出现重新登录页时在官方页面人工完成认证，再更新账号池。'],
    warning: 'Cookie 等同于登录权限。不要通过聊天、日志、截图或工单传输完整 Cookie。'
  },
  {
    id: 'jimeng', name: '即梦', loginUrl: 'https://jimeng.jianying.com', credentialSummary: '`sessionid` 或完整 Cookie，用于图像和视频创作任务。', refreshPolicy: '即梦会话失效或权益不足时不重试消耗型任务，直接记录原因。',
    fields: [
      { key: 'sessionid', label: 'sessionid', kind: 'password', hint: '推荐。填入你本人网页会话的 sessionid。', preferred: true },
      { key: 'cookie', label: '完整 Cookie', kind: 'textarea', hint: '可选。兼容需要多个会话字段的情况。' },
      { key: 'session_id', label: '任务会话 ID', kind: 'password', hint: '可选。' }
    ],
    steps: ['登录你自己的即梦网页账户。', '在自己的浏览器会话中取得 sessionid，或复制完整 Cookie。', '录入后选择实际可见的图像或视频模型进行连接测试。', '确认账户额度和生成权益后再用于 API 路由。'],
    warning: '图像与视频任务可能消耗账户额度。连接测试不会自动提交消耗型生成请求。'
  }
];

export function guideFor(provider: string) { return providerGuides.find((guide) => guide.id === provider) ?? providerGuides[0]; }
