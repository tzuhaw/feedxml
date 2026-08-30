# Cloud Run Job image. Build context is the repo root:
#   docker build -f worker/Dockerfile -t feedxml-worker .
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/domain/package.json packages/domain/
COPY worker/package.json worker/
RUN npm ci --workspace @feedxml/shared --workspace @feedxml/domain --workspace @feedxml/worker
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/domain packages/domain
COPY worker worker
# Dependency order matters: domain compiles against shared's emitted types.
RUN npm run build -w packages/shared \
 && npm run build -w packages/domain \
 && npm run build -w worker

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/packages/shared/package.json packages/shared/
COPY --from=build /app/packages/domain/package.json packages/domain/
COPY --from=build /app/worker/package.json worker/
RUN npm ci --omit=dev \
      --workspace @feedxml/shared --workspace @feedxml/domain --workspace @feedxml/worker
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/domain/dist packages/domain/dist
COPY --from=build /app/worker/dist worker/dist
CMD ["node", "worker/dist/index.js"]
