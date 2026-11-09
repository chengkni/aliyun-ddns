FROM node:22-alpine

# CI 走 npm 官方源；本地构建可传 --build-arg NPM_REGISTRY=https://registry.npmmirror.com
ARG NPM_REGISTRY=https://registry.npmjs.org

WORKDIR /app

COPY package*.json ./
RUN npm config set registry "$NPM_REGISTRY" \
 && npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && npm cache clean --force

COPY src/ ./src/

# 容器内不需要 root：脚本只读、不写文件、不监听端口
USER 65534:65534

ENTRYPOINT ["node", "/app/src/index.js"]
