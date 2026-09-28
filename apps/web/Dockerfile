# apps/web/Dockerfile - Phase 12 (item 5): optional static build + preview
# server for the React dashboard, referenced by deploy/docker-compose.yml's
# `web` service (profile "with-web", not started by default). Most real
# deployments should instead publish apps/web's `dist/` output to a static
# host/CDN in front of the API - this exists for a one-command, all-in-one
# local/staging deployment only.
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps/web/package.json apps/web/package.json
RUN npm ci
COPY apps/web ./apps/web
RUN npm run build -w apps/web

FROM node:20-bookworm-slim
WORKDIR /app
COPY --from=build /app/apps/web/package.json ./package.json
COPY --from=build /app/apps/web/dist ./dist
COPY --from=build /app/node_modules ./node_modules
EXPOSE 4173
CMD ["npx", "vite", "preview", "--host", "0.0.0.0", "--port", "4173"]
