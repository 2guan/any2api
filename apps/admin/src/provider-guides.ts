export type CredentialField = {
  key: string;
  label: string;
  kind?: 'password' | 'textarea';
  hint: string;
  preferred?: boolean;
};

export type ExtractionMethod = {
  title: string;
  badge?: string;
  desc: string;
  code?: string;
  steps: string[];
};

export type FAQItem = {
  question: string;
  answer: string;
};

export type ProviderGuide = {
  id: 'chatgpt' | 'kimi' | 'deepseek' | 'glm' | 'qwen' | 'jimeng';
  name: string;
  tagline: string;
  loginUrl: string;
  credentialSummary: string;
  refreshPolicy: string;
  supportedModels: string[];
  features: string[];
  fields: CredentialField[];
  quickScript?: string;
  quickScriptTitle?: string;
  methods: ExtractionMethod[];
  faqs: FAQItem[];
  warning: string;
};

export const providerGuides: ProviderGuide[] = [
  {
    id: 'chatgpt',
    name: 'ChatGPT (OpenAI)',
    tagline: '支持 GPT-5.6、GPT-5.5-mini、GPT-Image-2 高清绘图与多模态 Python 沙盒',
    loginUrl: 'https://chatgpt.com',
    credentialSummary: '首选官方 OAuth 授权（永久免维护），其次是 Refresh Token 或 Session Token。',
    refreshPolicy: '系统内置 OAuth 与 Session 双通道续签：通过 OAuth 绑定的账号将全自动在后台续期，长效免维护。',
    supportedModels: ['gpt-5.6', 'gpt-5.5', 'gpt-5.5-mini', 'gpt-image-2', 'o3', 'o4'],
    features: ['GPT-5.6 推理', '联网实时搜索', '多模态看图', 'Python 代码沙盒', 'DALL-E 3 / GPT-Image-2 生图'],
    fields: [
      { key: 'refresh_token', label: 'Refresh Token', kind: 'password', hint: '强烈推荐。通过上方「ChatGPT OAuth 授权」按钮或导出授权获取。', preferred: true },
      { key: 'access_token', label: 'Access Token (JWT)', kind: 'password', hint: '短期访问令牌，从 F12 请求头中复制的 eyJ... 字符串。' },
      { key: 'session_cookie', label: 'Session Cookie', kind: 'textarea', hint: '完整 Cookie 字符串（必须包含 __Secure-next-auth.session-token）。' },
      { key: 'session_id', label: '会话 ID', kind: 'password', hint: '可选。用于持续多轮会话绑定。' }
    ],
    quickScript: `document.cookie.match(/__Secure-next-auth\\.session-token=([^;]+)/)?.[1] || document.cookie`,
    quickScriptTitle: '控制台一键提取 Session Token',
    methods: [
      {
        title: '方法一：官方 OAuth 一键授权（最推荐）',
        badge: '永久免维护',
        desc: '无需手动抓包复制 Cookie，直接通过 OpenAI 官方登录流授权，系统获得长效 Refresh Token 并在后台自动无感续签。',
        steps: [
          '在上方账号池页面，点击右上角「ChatGPT OAuth 授权」按钮。',
          '在弹出的窗口中登录你的 OpenAI / ChatGPT 账户并确认授权。',
          '授权成功后，账号将自动录入账号池并开启永久自动续签。'
        ]
      },
      {
        title: '方法二：控制台一行代码提取 Session Token',
        badge: '快速提取',
        desc: '在已登录的 ChatGPT 网页端控制台执行代码，直接复制 Session Token。',
        code: `document.cookie.match(/__Secure-next-auth\\.session-token=([^;]+)/)?.[1] || document.cookie`,
        steps: [
          '在浏览器中登录 ChatGPT 网页版（https://chatgpt.com）。',
          '按 F12 打开开发者工具，切换到「控制台 / Console」标签页。',
          '粘贴上方提取代码并回车，复制输出的长字符串。',
          '在账号池中添加 ChatGPT 账号，将字符串粘贴到「Session Cookie」或「Access Token」字段中保存。'
        ]
      },
      {
        title: '方法三：F12 网络面板抓取 Authorization 标头',
        desc: '通过浏览器网络抓包获取当前的 Bearer Token。',
        steps: [
          '在 ChatGPT 网页端按 F12，切换到「网络 / Network」标签页。',
          '发送一条测试消息，在请求列表中找到 conversation 或 backend-api 请求。',
          '在右侧「标头 / Headers」中复制 Authorization 字段（以 Bearer eyJ... 开头）并填入。'
        ]
      }
    ],
    faqs: [
      {
        question: '为什么调用生图模型 gpt-image-2 或看图时需要特别注意？',
        answer: 'Any2API 已深度对齐 ChatGPT 逆向协议的多模态与沙盒渲染通道。多模态图片会自动上传至 OpenAI 临时存储并挂载附件，生图会自动捕获 DALL-E 产物并转存为本地永久 WebP 链接。'
      },
      {
        question: '提取 Token 后网页端需要保持打开吗？',
        answer: '不需要。提取凭据后直接关闭网页标签页即可。切勿在网页端点击“Log out / 退出登录”，否则服务端会立即注销该凭据。'
      }
    ],
    warning: '提取凭据后切勿在浏览器中点击“Log out / 退出登录”，否则 OpenAI 服务端会立刻废弃该 Token。关闭网页即可。'
  },
  {
    id: 'kimi',
    name: 'Kimi (月之暗面 Moonshot)',
    tagline: '支持 K1.5 深度思考、K3 智能体集群架构、长文深度理解与实时联网检索',
    loginUrl: 'https://kimi.moonshot.cn',
    credentialSummary: '强烈推荐 Refresh Token（长达数月有效），系统后台每 5 分钟自动静默续签；亦支持短效 Token。',
    refreshPolicy: 'Kimi 的 Authorization Token 仅 15 分钟有效！只要录入 Refresh Token，Any2API 会在后台定时换发全新 Access Token 并持久化存储，实现数月免维护。',
    supportedModels: ['kimi-k1.5-thinking', 'kimi-k3', 'kimi-k2.6', 'kimi-k2', 'kimi'],
    features: ['K1.5 深度推理', 'K3 智能体群协同', '超长上下文窗口', '联网精准检索', '多模态视觉理解'],
    fields: [
      { key: 'refresh_token', label: 'Refresh Token / 刷新令牌 (长达数月有效)', kind: 'password', hint: '强烈推荐。控制台执行 localStorage.getItem(\'refresh_token\') 一键获取，实现长期免维护自动续签。', preferred: true },
      { key: 'token', label: 'Authorization Token / 访问令牌 (临时 15 分钟)', kind: 'password', hint: '可选。在 Kimi 网页按 F12 从请求头中复制（仅 15 分钟有效，仅建议临时测试）。' },
      { key: 'session_id', label: '会话 ID', kind: 'password', hint: '可选，用于保持持续对话会话。' }
    ],
    quickScript: `localStorage.getItem('refresh_token') || document.cookie.match(/k_refresh_token=([^;]+)/)?.[1]`,
    quickScriptTitle: '控制台一键提取 Kimi 长效 Refresh Token（推荐）',
    methods: [
      {
        title: '方法一：控制台一键提取长效 Refresh Token（强烈推荐）',
        badge: '长效免维护',
        desc: '仅需在 Kimi 页面控制台执行一行指令，获取有效期长达数月的 Refresh Token，系统将全自动在后台无限期静默续签。',
        code: `localStorage.getItem('refresh_token') || document.cookie.match(/k_refresh_token=([^;]+)/)?.[1]`,
        steps: [
          '在浏览器中打开并登录 Kimi 网页版（https://kimi.moonshot.cn）。',
          '按 F12 打开开发者工具，切换到「控制台 / Console」标签页。',
          '粘贴上方代码并回车，复制输出的长字符串（以 eyJ 开头）。',
          '在账号池中添加 Kimi 账号，粘贴到「Refresh Token」字段保存即可！'
        ]
      },
      {
        title: '方法二：从 Application / 本地存储中提取',
        desc: '通过浏览器的存储管理器直接查看并复制 refresh_token。',
        steps: [
          '在 Kimi 网页端按 F12，切换到「应用 / Application」标签页。',
          '在左侧展开「本地存储空间 / Local Storage」并点击 https://kimi.moonshot.cn。',
          '在右侧列表中找到键名为 refresh_token 的项，双击复制其完整的 Value 值。',
          '粘贴至 Any2API 账号池中的 Refresh Token 字段。'
        ]
      },
      {
        title: '方法三：网络抓包提取 Authorization 标头（仅临时使用）',
        desc: '抓取当前会话的短效 Access Token，有效期仅 15 分钟。',
        steps: [
          '在 Kimi 网页端按 F12，切换到「网络 / Network」标签页。',
          '在输入框发送一条消息，在请求列表中找到 /api/chat 请求。',
          '在右侧「标头 / Headers」中找到 Authorization: Bearer eyJ...，复制该字符串。',
          '注意：该令牌仅 15 分钟有效，建议尽快更换为 Refresh Token。'
        ]
      }
    ],
    faqs: [
      {
        question: '为什么之前使用 Kimi 过了 15 分钟就报错 Token 已过期？',
        answer: '因为 Kimi 网页端发送普通对话请求时使用的是 15 分钟的短效 Access Token。只要在账号池中录入长效的「Refresh Token」，Any2API 就会自动在后台调用 /api/auth/token/refresh 持续换发新令牌并自动存入数据库，彻底告别频繁掉线。'
      },
      {
        question: '提示 user_stream_pushing 或高峰期繁忙怎么办？',
        answer: 'Any2API 已内置全自动容灾引擎：当遇到并发会话冲突时会自动新建独立隔离会话；当遭遇 K1.5 高峰期限流（429/500/busy）时，会自动平滑降级至快速模型保障服务高可用。'
      }
    ],
    warning: '提取 Token 后切勿在 Kimi 网页端点击“退出登录”，否则服务端会立即注销 Refresh Token。直接关闭网页即可。'
  },
  {
    id: 'glm',
    name: '智谱 GLM (智谱清言)',
    tagline: '支持 GLM-5.2 超长百万上下文、GLM-5V 视觉理解、GLM-Image CogView 绘图',
    loginUrl: 'https://chatglm.cn',
    credentialSummary: '强烈推荐 Refresh Token（180 天长效有效），系统全自动静默续签；亦支持 Access Token（2 小时）。',
    refreshPolicy: '只要录入 Refresh Token（或包含 chatglm_refresh_token 的 Cookie），系统会在后台每 5 分钟及请求前自动调用智谱 MD5 动态签名续签接口换发令牌，180 天完全免维护。',
    supportedModels: ['glm-4-flash', 'glm-4-plus', 'glm-4', 'glm-5.2', 'glm-5v-turbo', 'glm-image', 'cogvideox-3'],
    features: ['GLM-5.2 深度思维链', '1M 超长上下文', 'CogView 创意绘图', 'GLM-5V 视觉分析', '实时联网检索'],
    fields: [
      { key: 'refresh_token', label: 'Refresh Token / 刷新令牌 (180 天有效)', kind: 'password', hint: '强烈推荐。控制台执行 localStorage.getItem(\'chatglm_refresh_token\') 一键获取，实现 180 天长效免维护。', preferred: true },
      { key: 'access_token', label: 'Authorization Token / 访问令牌 (2 小时有效)', kind: 'password', hint: '可选。在智谱网页按 F12 从请求头复制（仅 2 小时有效，建议录入 Refresh Token）。' },
      { key: 'session_id', label: '会话 ID', kind: 'password', hint: '可选，用于保持网页端会话历史。' }
    ],
    quickScript: `localStorage.getItem('chatglm_refresh_token') || document.cookie.match(/chatglm_refresh_token=([^;]+)/)?.[1]`,
    quickScriptTitle: '控制台一键提取智谱 180 天 Refresh Token（推荐）',
    methods: [
      {
        title: '方法一：控制台一键提取 180 天长效 Refresh Token（强烈推荐）',
        badge: '180天免维护',
        desc: '智谱清言在 Cookie 与 LocalStorage 中存有有效期长达 180 天的 Refresh Token。执行脚本即可一键取出。',
        code: `localStorage.getItem('chatglm_refresh_token') || document.cookie.match(/chatglm_refresh_token=([^;]+)/)?.[1]`,
        steps: [
          '在浏览器中打开并登录智谱清言网页版（https://chatglm.cn）。',
          '按 F12 打开开发者工具，切换到「控制台 / Console」标签页。',
          '粘贴上方代码并回车，复制输出的长字符串。',
          '在账号池中添加 GLM 账号，粘贴到「Refresh Token」字段保存即可！'
        ]
      },
      {
        title: '方法二：从 Cookies 管理器中复制 chatglm_refresh_token',
        desc: '直接在浏览器的 Cookies 面板中查找长效令牌。',
        steps: [
          '在智谱清言网页端按 F12，切换到「应用 / Application」标签页。',
          '展开左侧「Cookies」并点击 https://chatglm.cn。',
          '在列表中找到 chatglm_refresh_token，双击复制其 Value 值。',
          '粘贴到 Any2API 账号池的 Refresh Token 字段。'
        ]
      },
      {
        title: '方法三：网络面板抓取 Authorization 标头（仅临时使用）',
        desc: '抓取当前的 Access Token，有效期通常为 2 小时。',
        steps: [
          '在智谱清言网页端按 F12，切换到「网络 / Network」标签页。',
          '刷新页面或发送消息，在请求列表中找到 assistant/stream 或 user/info 请求。',
          '在右侧 Headers 中复制 Authorization: Bearer eyJ... 字符串。',
          '建议后续尽快在账号池中补充录入 Refresh Token 以启用 180 天长效续签。'
        ]
      }
    ],
    faqs: [
      {
        question: '智谱 Refresh Token 是如何实现自动续签的？',
        answer: 'Any2API 完整逆向对齐了智谱清言官方 /user-api/user/refresh 端点，自动注入 X-Sign 算法动态签名、X-Device-Id 与时间戳。当 Access Token 临期或失效时，系统自动换取新 Token 并写回数据库，全程对调用方完全无感透明。'
      },
      {
        question: 'GLM 绘图与视频生成如何获取结果？',
        answer: '当选择 glm-image 等模型时，系统会自动向智谱后端下发画图指令，智能拦截并提取 CogView 生成的高清图像，并转存为本地服务器 URL 供调用方直接加载。'
      }
    ],
    warning: '提取 Token 后切勿在网页端点击“退出登录”，否则服务端会注销该 Refresh Token。关闭网页标签页即可。'
  },
  {
    id: 'deepseek',
    name: 'DeepSeek (深度求索)',
    tagline: '支持 DeepSeek-V3 快速推理、DeepSeek-R1 深度思维链与全透明推理过程流式输出',
    loginUrl: 'https://chat.deepseek.com',
    credentialSummary: 'User Token（用户令牌）或 Authorization 请求头。控制台一行代码即可快速提取。',
    refreshPolicy: 'User Token 有效期约 30 天。系统支持直连 API 与无头仿真双通道，自动提取透明思维链与搜索引用。',
    supportedModels: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-v3', 'deepseek-r1'],
    features: ['DeepSeek-R1 深度思考', '透明思维链流式输出', '实时联网搜索与引用', '30天超长有效期', '高性能双通道容灾'],
    fields: [
      { key: 'user_token', label: 'User Token / 用户令牌 (30 天有效)', kind: 'password', hint: '强烈推荐。控制台执行 JSON.parse(localStorage.getItem(\'userToken\')).value 快速获取。', preferred: true },
      { key: 'access_token', label: 'Bearer Token', kind: 'password', hint: '可选。从网络标头中复制 Authorization: Bearer eyJ... 字符串。' },
      { key: 'session_id', label: '会话 ID', kind: 'password', hint: '可选，用于持续对话。' }
    ],
    quickScript: `JSON.parse(localStorage.getItem('userToken') || '{}').value || localStorage.getItem('userToken')`,
    quickScriptTitle: '控制台一键提取 DeepSeek User Token（推荐）',
    methods: [
      {
        title: '方法一：控制台一键提取 User Token（强烈推荐）',
        badge: '30天长效',
        desc: 'DeepSeek 网页端将用户令牌保存在 LocalStorage 中，有效期长达约 30 天。',
        code: `JSON.parse(localStorage.getItem('userToken') || '{}').value || localStorage.getItem('userToken')`,
        steps: [
          '在浏览器中登录 DeepSeek 网页版（https://chat.deepseek.com）。',
          '按 F12 打开开发者工具，切换到「控制台 / Console」标签页。',
          '粘贴上方代码并回车，复制输出的以 eyJ 开头的长 Token 字符串。',
          '在 Any2API 账号池中添加 DeepSeek 账号，粘贴至「User Token」字段保存即可！'
        ]
      },
      {
        title: '方法二：从网络请求标头中抓取 Authorization',
        desc: '通过网络面板抓取对话请求的 Bearer 令牌。',
        steps: [
          '在 DeepSeek 页面按 F12，切换到「网络 / Network」标签页。',
          '发送一条测试消息，在请求列表中找到 /chat/completions 请求。',
          '在右侧 Headers 中复制 Authorization 标头（以 Bearer eyJ... 开头）并填入。'
        ]
      }
    ],
    faqs: [
      {
        question: 'Any2API 如何支持 DeepSeek-R1 的思考过程（Reasoning Content）？',
        answer: '系统在流式解析中自动捕获 DeepSeek-R1 输出的 reasoning_content 字段，并通过 OpenAI 兼容的 reasoning_summary.delta / reasoning_content 实时推送给客户端，上层客户端（如 Cherry Studio、Chatbox 等）可原生展示折叠思考链。'
      }
    ],
    warning: '提取 Token 后切勿在网页端点击“退出登录”，否则服务端会注销该 Token。关闭网页标签页即可。'
  },
  {
    id: 'qwen',
    name: '通义千问 (阿里 Qwen)',
    tagline: '支持 Qwen3.8-Max、Qwen-Turbo、Qwen-VL-Max 多模态视觉识图与超长文档分析',
    loginUrl: 'https://chat.qwen.ai',
    credentialSummary: 'Authorization Token（Bearer eyJ...）或包含完整 token= 的 Cookie。',
    refreshPolicy: '系统内置真实鉴权探测、HTTP API 直连与 Playwright 无头浏览器仿真双通道容灾。',
    supportedModels: ['qwen3.8-max', 'qwen3.8-plus', 'qwen-turbo', 'qwen-vl-max', 'qwen-max'],
    features: ['Qwen3.8 超强推理', 'Qwen-VL 视觉多模态分析', '实时联网搜索与知识库', '阿里云 TOS 高速图床', '双通道高可用'],
    fields: [
      { key: 'cookie', label: 'Authorization 或 Cookie', kind: 'textarea', hint: '强烈推荐。从 chat.qwen.ai 网络请求标头复制 Authorization 或完整 Cookie。', preferred: true },
      { key: 'access_token', label: 'Bearer Token', kind: 'password', hint: '可选。在控制台执行 localStorage.getItem(\'token\') 提取。' },
      { key: 'session_id', label: '会话 ID', kind: 'password', hint: '可选。' }
    ],
    quickScript: `localStorage.getItem('token') || document.cookie.match(/token=([^;]+)/)?.[1] || document.cookie`,
    quickScriptTitle: '控制台一键提取通义千问 Token / Cookie（推荐）',
    methods: [
      {
        title: '方法一：控制台一键提取 Token（强烈推荐）',
        badge: '快速提取',
        desc: '在千问控制台一键读取登录凭据。',
        code: `localStorage.getItem('token') || document.cookie.match(/token=([^;]+)/)?.[1] || document.cookie`,
        steps: [
          '在浏览器中登录通义千问网页版（https://chat.qwen.ai）。',
          '按 F12 打开开发者工具，切换到「控制台 / Console」标签页。',
          '粘贴上方代码并回车，复制输出的字符串。',
          '在账号池中添加通义千问账号，粘贴保存即可！'
        ]
      },
      {
        title: '方法二：网络面板复制 Authorization 或 Cookie 标头',
        desc: '从千问网络请求中抓取完整的认证材料。',
        steps: [
          '在千问网页端按 F12，切换到「网络 / Network」标签页。',
          '发送一条消息，点击任意 /api/ 请求（如 /api/v1/chat 或 /api/v2/）。',
          '在右侧 Headers 中复制 Authorization（以 Bearer eyJ... 开头）或整串 Cookie 并填入。'
        ]
      }
    ],
    faqs: [
      {
        question: '通义千问如何支持多模态传图分析？',
        answer: 'Any2API 逆向打通了通义千问底层的阿里云 TOS 直传签名通道。当用户在 OpenAI 格式中发送 Base64 图片或图片 URL 时，系统会自动将图片转码直传至千问 OSS 节点并自动发起视觉多模态分析。'
      }
    ],
    warning: 'Cookie / Token 包含当前登录会话，提取后请直接关闭网页，切勿点击“退出登录”。'
  },
  {
    id: 'jimeng',
    name: '即梦 AI (剪映灵感)',
    tagline: '支持文生图 3.1、3.0、图片 5.0 Pro/Lite、4.0 等全系列多画质专业级 AI 图像创作',
    loginUrl: 'https://jimeng.jianying.com',
    credentialSummary: 'sessionid（32 位核心凭据）或完整 Cookie。控制台一行代码即可提取。',
    refreshPolicy: '系统默认优先使用 1K 标准分辨率（单次仅消耗 1 赠送/免费积分 gift_credit），完美支持每日签到免费积分与 VIP 会员积分，生成的画作自动转存至本地服务器持久化托管。',
    supportedModels: ['文生图 3.1 (jimeng-3.1)', '文生图 3.0 (jimeng-3.0)', '图片 5.0 Pro', '图片 5.0 Lite', '图片 4.7', '图片 4.0'],
    features: ['文生图 3.1 旗舰画质', '全系列模型 1K/2K 适配', '免费赠送积分优先抵扣', '单次批量生成 4 张高清图', '本地图片持久化托管'],
    fields: [
      { key: 'sessionid', label: 'sessionid (核心会话凭据)', kind: 'password', hint: '强烈推荐。在即梦控制台执行脚本提取 32 位 sessionid 字符串。', preferred: true },
      { key: 'cookie', label: '完整 Cookie 字符串', kind: 'textarea', hint: '可选。控制台执行 document.cookie 复制全部内容。' },
      { key: 'session_id', label: '任务会话 ID', kind: 'password', hint: '可选。' }
    ],
    quickScript: `document.cookie.match(/sessionid=([^;]+)/)?.[1] || document.cookie`,
    quickScriptTitle: '控制台一键提取即梦 sessionid（强烈推荐）',
    methods: [
      {
        title: '方法一：控制台一键提取 sessionid（强烈推荐）',
        badge: '极简提取',
        desc: '只需执行一行提取脚本，即可直接取出即梦核心会话凭据。',
        code: `document.cookie.match(/sessionid=([^;]+)/)?.[1] || document.cookie`,
        steps: [
          '在浏览器中登录即梦 AI 网页版（https://jimeng.jianying.com）。',
          '按 F12 打开开发者工具，切换到「控制台 / Console」标签页。',
          '粘贴上方代码并回车，复制输出的 32 位 sessionid 字符串（例如 1a2b3c4d5e...）。',
          '在账号池中添加即梦账号，将该字符串粘贴到「sessionid」字段保存即可！'
        ]
      },
      {
        title: '方法二：从 Application / Cookies 面板复制',
        desc: '在浏览器 Cookies 列表中查找 sessionid。',
        steps: [
          '在即梦网页端按 F12，切换到「应用 / Application」标签页。',
          '展开左侧「Cookies」并点击 https://jimeng.jianying.com。',
          '在列表中找到 sessionid，双击复制其完整的 Value 值并保存到账号池。'
        ]
      }
    ],
    faqs: [
      {
        question: '为什么使用文生图 3.1 时会优先消耗免费积分？',
        answer: '即梦官方为每个注册账号每天赠送免费积分（gift_credit）。Any2API 已优化了官方底层计费场景参数，默认优先采用 1K 标准分辨率（单次消耗 1 点免费积分），避免因强制调用 2K VIP 通道导致非会员账号报错 1006。'
      },
      {
        question: '生成的图片链接会过期吗？',
        answer: '不会。Any2API 收到即梦生成的图片后，会自动将高清 WebP 图像异步下载并转存至本地服务器持久化存储，生成的 /api/media/... 链接永久有效。'
      }
    ],
    warning: '提取凭据后切勿在即梦网页端点击“退出登录”，否则服务端会立即废除该 sessionid。直接关闭网页即可。'
  }
];

export function guideFor(provider: string) {
  return providerGuides.find((guide) => guide.id === provider) ?? providerGuides[0];
}
