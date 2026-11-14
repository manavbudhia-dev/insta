FROM node:22-bookworm-slim AS build
WORKDIR /app

# Fallback toolchain: if the prebuilt better-sqlite3 binary can't be downloaded
# on the build server, npm compiles it from source and needs these.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production DATA_DIR=/data
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY public ./public
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN mkdir -p /data && chmod +x /usr/local/bin/docker-entrypoint.sh

# NOTE: no VOLUME instruction (Railway-style platforms reject it). Attach a
# persistent volume at /data in the platform dashboard instead.
# The entrypoint starts as root only to chown /data (platform volumes are
# mounted root-owned), then drops to the unprivileged `node` user. If that
# fails it runs as root, as before.

# The platform injects PORT; the app already reads it (src/config.ts).
EXPOSE 3000
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/server.js"]
