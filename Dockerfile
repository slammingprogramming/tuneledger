# ---- deps stage: install & compile native modules (better-sqlite3) ----
FROM node:20-bookworm-slim AS deps
WORKDIR /app
# build-essential + python3 are only needed as a fallback if prebuild-install
# can't find a prebuilt binary for the target platform; harmless either way
# since this stage's tools never reach the final image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- runtime stage ----
FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    DB_PATH=/data/library.db \
    PORT=3000

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY public ./public
COPY migrations ./migrations
COPY config ./config

RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 3000

CMD ["node", "server/index.js"]
