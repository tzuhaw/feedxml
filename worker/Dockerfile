# Cloud Run Job image. Build context is the repo root:
#   docker build -f worker/Dockerfile -t feedxml-worker .
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY worker/package.json worker/
RUN npm ci --workspace @feedxml/shared --workspace @feedxml/worker
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY worker worker
RUN npm run build -w packages/shared -w worker

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/packages/shared/package.json packages/shared/
COPY --from=build /app/worker/package.json worker/
RUN npm ci --omit=dev --workspace @feedxml/shared --workspace @feedxml/worker
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/worker/dist worker/dist
CMD ["node", "worker/dist/index.js"]
