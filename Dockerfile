# Dockerfile - Phase 12 (item 5): builds and runs the JARVIS API process.
#
# Honest architecture note (read before "fixing" this into 3 containers):
# this repo's API, Autonomous Worker, and Scheduler are NOT separate
# processes - apps/api/src/index.ts starts the worker loop (core/worker) and
# the scheduler (scheduler/index.ts) IN-PROCESS, inside the same Node
# process that serves HTTP (see docs/PHASE5_AUTONOMOUS_WORKER.md's own
# disclosure of this). There is therefore exactly ONE application container
# to supervise here, not three - deploy/docker-compose.yml reflects this
# honestly instead of fabricating a multi-process topology this codebase
# doesn't have. apps/web (the dashboard) is a separate, optional static
# build - see deploy/docker-compose.yml's `web` service.
FROM node:20-bookworm-slim AS base
WORKDIR /app
ENV NODE_ENV=production

# Playwright (tools/browser) needs its browser binaries and a handful of
# system libraries - installed here rather than assumed present, so a
# container build is honest about what "browser automation is available"
# actually requires.
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY database/schema.prisma database/schema.prisma

RUN npm ci

COPY . .

RUN npx prisma generate --schema=database/schema.prisma
# Playwright browser binaries for tools/browser (Phase 10) - a genuinely
# separate, sizeable install step, explicit rather than hidden inside `npm ci`.
RUN npx playwright install --with-deps chromium

EXPOSE 4000

# Runs the process the exact same way `npm run dev:api` / apps/api's own
# "start" script does (tsx, not a separate tsc build step) - one fewer place
# for a compiled-output path to drift from what's actually tested. Honest
# tradeoff, documented: this means the container pays tsx's transpile-on-
# start cost every restart (milliseconds, not worth a separate build stage
# for this codebase's size) rather than shipping precompiled JS.
CMD ["sh", "-c", "npx prisma migrate deploy --schema=database/schema.prisma && npm run start -w apps/api"]
