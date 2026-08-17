# 阶段 1: 依赖安装与构建
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# 安装必要的构建工具与依赖
COPY package*.json ./
COPY apps/admin/package*.json ./apps/admin/
COPY apps/api/package*.json ./apps/api/

RUN npm install

# 复制源码
COPY . .

# 构建前端管理控制台与后端服务
RUN npm run build

# 阶段 2: 生产运行镜像 (集成 Playwright 无头浏览器依赖)
FROM node:22-bookworm-slim AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV ANY2API_HOST=0.0.0.0
ENV ANY2API_PORT=8788
ENV ANY2API_DATA_DIR=/app/data

# 安装 Playwright / Chromium 所需的系统依赖库
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# 从构建阶段复制必要文件
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/api/package*.json ./apps/api/
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/apps/admin/dist ./apps/admin/dist

# 安装 Playwright Chromium 浏览器内核
RUN npx playwright install chromium

# 创建数据持久化目录
RUN mkdir -p /app/data

VOLUME ["/app/data"]
EXPOSE 8788

CMD ["node", "apps/api/dist/server.js"]
