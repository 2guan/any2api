# Any2API · 多模型聚合网关与调度控制台

<p align="center">
  <b>Any2API</b> 是一个高性能、轻量级的 AI 模型聚合网关与多账号调度控制平面。<br>
  提供标准 <b>OpenAI / Anthropic API 兼容接口</b>，支持多上游渠道统一聚合、智能路由调度、账号池负载均衡、多维日志统计审计与全响应式 Web 管理控制台。
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-22.x-green.svg" alt="Node.js" />
  <img src="https://img.shields.io/badge/TypeScript-5.7-blue.svg" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Fastify-5.2-black.svg" alt="Fastify" />
  <img src="https://img.shields.io/badge/React-19.0-61dafb.svg" alt="React" />
  <img src="https://img.shields.io/badge/Fluent_UI-v9-0078d4.svg" alt="Fluent UI" />
  <img src="https://img.shields.io/badge/License-MIT-orange.svg" alt="License" />
</p>

---

> [!IMPORTANT]
> ### ⚠️ 免责声明与使用须知 (Disclaimer)
> 1. 本项目仅供 **个人学习交流、接口协议研究与开发测试** 使用。
> 2. 请使用者严格遵守各模型服务商的服务条款、使用政策及相关法律法规。
> 3. 请勿将本项目用于任何违反法律法规、侵犯第三方权益或商业牟利的场景。使用者对其使用本项目的行为及所产生的后果独立承担全部法律责任。

---

## ✨ 核心特性

### 1. 🔄 标准 OpenAI & Anthropic 协议桥接
- **标准接口覆盖**：支持 `/v1/chat/completions`、`/v1/models`、`/v1/images/generations`、`/v1/messages` 等标准 OpenAI 与 Claude 格式。
- **全特性支持**：
  - ⚡ 流式打字机推流（Server-Sent Events, SSE）；
  - 💭 深度思考链（Thinking Chain / Reasoning Content）；
  - 🌐 联网搜索引用（Web Search Citations）；
  - 🖼️ 多模型文生图（Images Direct Output）；
  - 🛑 规范标准 HTTP 错误状态码（`401` / `404` / `502` / `503`）。
- **零代码迁移**：无缝接入各类主流开源客户端（如 NextChat、Cherry Studio、Chatbox、LobeChat、Cursor、LangChain、Dify 等）。

---

### 2. 👥 账号池智能路由与负载调度
- **多渠道支持**：集成主流大语言模型渠道（ChatGPT、Kimi、DeepSeek、智谱 GLM、通义千问 Qwen、即梦 AI 等）。
- **动态权重与负载均衡**：支持按优先级（Priority）、并发租约限制（Concurrency Leases）与历史响应延迟（EWMA Latency）自动选路。
- **高可用容灾机制**：内置健康探测、熔断冷却（Cooldown）、异常降级与故障自愈。
- **批量导入导出**：支持 Excel（`.xlsx`）一键导入导出账号配置，内置容错解密与自愈机制。

---

### 3. 🎨 现代响应式 Web 控制台
- **设计系统**：基于微软官方 **Fluent UI 9** 现代设计语言，支持明亮/暗黑主题一键切换。
- **移动端深度适配**：手机端自适应为汉堡包抽屉菜单（Drawer Navigation），复杂表格自动转为卡片视图（Card Views）。
- **核心功能模块**：
  - 📊 **全局仪表盘**：系统健康度、并发负载、近 24 小时流量与吞吐监控；
  - 🔑 **API Key 管理**：多角色鉴权体系（Owner / Admin / Operator / User）、一键复制与密钥生命周期管理；
  - 🛣️ **模型路由配置**：公网模型名称与上游实际服务版本的自由映射；
  - 🤖 **在线连接测试器**：沉浸式多轮对话测试，右侧实时置顶可审计事件轨迹；
  - 🖼️ **图片日志画廊**：聚合所有生图模型的画作资产、提示词及关联调用 Key；
  - 📖 **交互式使用指南**：内置 Python / Node.js / cURL 各语言调用示例。

---

### 4. 📈 多维度日志统计与全景审计
- **多维交叉分析**：支持按**时间段（近1h/今日/24h/7d/30d/自定义）**、**API Key**、**账号池**、**渠道**、**模型**多维度交叉透视。
- **时序流量直方图**：毫秒级聚合成功/失败请求量、成功率与 P95 尾部延迟分布。
- **单条请求深度检查器**：一键查看单次请求的元数据、上游 Prompt 上下文、模型思考链、Markdown 回复与全生命周期审计事件。

---

### 5. 🔐 轻量级安全与数据持久化
- **零外部数据库依赖**：采用 Node.js 原生内置 SQLite (`node:sqlite`)，开启 WAL 模式，毫秒级读写并发。
- **高强度凭据加密**：账号凭据使用 **AES-256-GCM** 在落库前完成加密存储，内存中按需解密。
- **会话与权限控制**：基于安全 Cookie + Scrypt 加盐哈希，提供细粒度 RBAC 权限隔离。

---

## 🏗️ 技术架构

```
Any2API (Monorepo)
├── apps/
│   ├── api/          # 后端网关服务 (Fastify 5 + Node.js 22 + TypeScript)
│   │   ├── src/
│   │   │   ├── gateway.ts      # 调度核心引擎与流式生成器
│   │   │   ├── accounts.ts     # 账号池租约管理与 EWMA 负载均衡
│   │   │   ├── catalog.ts      # 模型目录与路由映射
│   │   │   ├── crypto.ts       # AES-256-GCM 凭据加密机
│   │   │   ├── db.ts           # SQLite 数据库与表结构
│   │   │   ├── providers/      # 各渠道上游协议适配器
│   │   │   └── routes/         # OpenAI / Anthropic 标准 API 路由
│   └── admin/        # 前端管理控制台 (React 19 + Vite 6 + Fluent UI 9)
└── data/             # 本地数据库与持久化媒体目录 (自动生成)
```

---

## 🚀 快速开始

### 1. 环境准备
- **Node.js**: `v20.0.0` 或更高版本（推荐 `v22.x`）
- **npm**: `v10.x` 或更高版本

### 2. 克隆仓库与安装依赖
```bash
git clone https://github.com/2guan/any2api.git
cd any2api

# 安装项目依赖 (Monorepo 自动安装所有工作区)
npm install
```

### 3. 配置环境变量
复制环境变量配置文件：
```bash
cp .env.example .env
```
根据需要调整 `.env` 中的基础配置：
```ini
ANY2API_PORT=8788
ADMIN_PORT=3300
APP_MASTER_KEY=any2api-master-secure-secret-key-32chars
LOG_LEVEL=info
```

### 4. 启动本地开发服务
```bash
# 启动后端 API 网关 (端口 8788)
npm run dev

# 启动前端管理控制台 (端口 3300)
npm run dev:admin
```

启动完成后：
- 访问管理控制台：**`http://localhost:3300/`**
- 默认管理员账号：`admin` / `admin123`（首次登录后建议立即在【用户管理】修改密码）

---

### 5. 生产构建与启动
```bash
# 构建全站生产产物
npm run build

# 启动生产服务
npm start
```

---

## 💻 API 调用示例

### 1. Python (使用官方 `openai` SDK)
```python
from openai import OpenAI

client = OpenAI(
    api_key="sk-a2a-your-api-key",          # 在 Any2API 控制台【API 密钥】中创建
    base_url="http://localhost:8788/v1"      # 指向 Any2API 网关地址
)

response = client.chat.completions.create(
    model="gpt-5.6",                         # 控制台【模型路由】中配置的公网模型名
    messages=[
        {"role": "user", "content": "你好，请写一首关于科技与未来的现代诗。"}
    ],
    stream=True
)

for chunk in response:
    if chunk.choices and chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="", flush=True)
print()
```

---

### 2. cURL (流式请求)
```bash
curl -N http://localhost:8788/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-a2a-your-api-key" \
  -d '{
    "model": "qwen3.8-max",
    "messages": [{"role": "user", "content": "你好！"}],
    "stream": true
  }'
```

---

### 3. 文生图 (Image Generation)
```bash
curl http://localhost:8788/v1/images/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-a2a-your-api-key" \
  -d '{
    "model": "jimeng-3.1",
    "prompt": "深秋森林中清澈的溪流与小鹿，清晨薄雾，光影交错，8k分辨率",
    "size": "1024x1024"
  }'
```

---

## 📄 开源许可证

本项目采用 [MIT License](LICENSE) 授权开源。
