FROM node:24.18.0-bookworm-slim AS base
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json eslint.config.js ./
COPY src ./src
RUN npm run build

FROM base AS runtime
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force \
  && apt-get purge -y python3 make g++ && apt-get autoremove -y \
  && apt-get update && apt-get install -y --no-install-recommends sqlite3 \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/dist ./dist
RUN mkdir -p /data && chown -R node:node /data
USER node

EXPOSE 3000
CMD ["node", "dist/server.js"]
