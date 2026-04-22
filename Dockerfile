# syntax=docker/dockerfile:1.7
# ─── Build stage ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app

# Install production deps first for better layer caching.
# .npmrc sets ignore-scripts=true — skips blue-js-sdk's V2Ray/WireGuard
# postinstall which we don't need for the plan manager.
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev

# ─── Runtime stage ───────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app

# Tini gives us proper PID 1 signal handling so `docker stop` exits fast.
RUN apk add --no-cache tini

ENV NODE_ENV=production \
    PORT=3003 \
    DATA_DIR=/data

COPY --from=build /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY server.js cli.js index.html ./
COPY lib ./lib

# All persistent state (.wallet.json, my-plans.json, nodes-cache.json) is
# written under DATA_DIR. Mount a volume here to keep it across restarts.
RUN mkdir -p /data && chown -R node:node /app /data
VOLUME ["/data"]
USER node

EXPOSE 3003

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
