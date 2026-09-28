# JARVIS — Prime Pak Packages

Autonomous AI operating system for Prime Pak Packages, a packaging manufacturer.

**This repository currently implements Phase 1 ("FOUNDATION") only.** See
[`docs/PHASE_STATUS.md`](docs/PHASE_STATUS.md) for a precise, honest account
of what works, what doesn't, and what's next. See
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for how it's organized.

Phase 1's success condition: **a user can communicate with JARVIS, and JARVIS
can execute registered tools.** That works end-to-end today, on top of a
real (if minimal) database, memory system, decision engine, agent registry,
scheduler, and dashboard shell.

## Requirements

- Node.js 20+
- npm 10+
- No external database server required (SQLite via Prisma, file-based).
- An `ANTHROPIC_API_KEY` is optional but required for `/chat` to produce a
  real AI reply — without it, JARVIS responds with a clear
  `CONFIGURATION_REQUIRED` message instead of failing silently or faking a
  response.

## Setup

```bash
npm install                 # installs all workspaces + runs `prisma generate`
cp .env.example .env        # fill in ANTHROPIC_API_KEY if you have one
npm run prisma:migrate      # creates database/dev.db and applies the schema
```

`npm install`'s `postinstall` step only generates the Prisma client; running
`npm run prisma:migrate` once is what actually creates `database/dev.db` and
applies the schema. After that, `npm run dev -w apps/api` will also
auto-apply any pending migrations on startup, so a fresh clone that already
ran `prisma:migrate` once needs no further manual steps.

## Run it

```bash
# Terminal 1: the backend/orchestrator API (default: http://localhost:4000)
npm run dev -w apps/api

# Terminal 2: the dashboard (default: http://localhost:5173)
npm run dev -w apps/web
```

Open http://localhost:5173, go to **Home**, and chat with JARVIS. It calls
the real orchestrator (`core/orchestrator`), which calls the real Anthropic
provider (if `ANTHROPIC_API_KEY` is set) and logs the exchange to memory.

The desktop shell (`apps/desktop`) is an Electron stub that loads the web
dashboard in a native window. It's not part of the required verification
flow, but you can try it with `npm run start -w apps/desktop` (requires a
display) once `apps/web`'s dev server is running.

## Test

```bash
npm test
```

This runs the full `vitest` suite: memory CRUD + append-only history,
decision-engine classification, the tool registry (including a
`NOT_IMPLEMENTED` tool), the scheduler, and an API smoke test (`/health`,
`/chat` failing cleanly without an API key, `/tools`).

## Project layout

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full breakdown.
Short version:

- `apps/api` — Express + TypeScript backend (the orchestrator's HTTP surface)
- `apps/web` — React + Vite dashboard shell
- `apps/desktop` — Electron shell stub
- `core/` — orchestrator, planner, decision engine, memory, context, AI provider
- `agents/` — `AgentInterface` + two real stub agents (`research`, `crm`)
- `tools/` — the tool registry + built-in tools (some real, some stubbed)
- `scheduler/` — cron-based recurring jobs, config-driven
- `security/` — env loading, audit log, redaction, structured logging
- `config/` — typed env loader
- `database/` — Prisma schema, client, migrations
- `docs/` — architecture notes and phase status

## Honesty markers

Anything that needs a third-party integration not yet configured returns a
typed `CONFIGURATION_REQUIRED` result. Anything planned for a later phase
(voice, cold-calling, browser/computer control, real web research, sending
email) returns a typed `NOT_IMPLEMENTED` result. Nothing in this codebase
fakes a "connected" or "done" status for functionality that isn't real.
