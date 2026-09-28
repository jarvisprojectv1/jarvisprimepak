# JARVIS Architecture — Phase 1 (Foundation)

> This file documents Phase 1's original layout only. For everything added
> since, see `docs/PHASE_STATUS.md` (a running log across all phases) and the
> per-phase docs: `docs/PHASE2_AUTONOMY.md`, `docs/PHASE3_IDENTITY_EVENTS.md`,
> `docs/PHASE4_BRAIN_MEMORY.md`, `docs/PHASE5_AUTONOMOUS_WORKER.md`. Notably,
> Phase 5 added `core/worker/` (the standing Autonomous Worker loop) and
> `core/reports/` (the Daily Executive Report), neither of which appears in
> the directory layout below.

## Goals of this phase

Per the master spec (sections 41/45/46), Phase 1's only success condition is:

> **A user can communicate with JARVIS, and JARVIS can execute registered tools.**

Everything else in this repository is groundwork — real interfaces and
minimal real implementations for memory, planning, decision-making, agents,
tools, scheduling, security, and two thin frontend shells — laid down so
later phases can build on solid, honest foundations instead of scaffolding
that has to be ripped out.

## High-level flow

```
apps/web (React dashboard)  ─┐
                              ├─► apps/api (Express) ─► core/orchestrator
apps/desktop (Electron)     ─┘                              │
                                                              ├─► core/ai/provider (Anthropic, or CONFIGURATION_REQUIRED)
                                                              ├─► tools/registry (execute a named tool)
                                                              ├─► core/memory (append-only, namespaced)
                                                              └─► security/logger (system_logs) + security/audit (audit_logs)

agents/ (research, crm)  ─────► database (via Prisma) + tools/registry
scheduler/               ─────► node-cron, config from `automations` table
```

## Directory layout

```
apps/
  api/         Express + TypeScript HTTP API (the orchestrator's surface)
  web/         React + Vite dashboard shell (13 routed tabs, dark theme)
  desktop/     Electron shell stub (loads apps/web; Phase 4 features stubbed)
core/
  ai/          AIProvider interface + AnthropicProvider implementation
  orchestrator/  Accepts a chat message, calls the AI provider and/or a tool,
                 logs to memory + system_logs
  planner/     Task type + naive (non-LLM) decomposition, persisted to `tasks`
  decision_engine/  classify() — the 5-way ROUTINE/CONFIGURED_BUSINESS_ACTION/
                 INFORMATION_MISSING/HIGH_IMPACT/CRITICAL_SYSTEM_FAILURE logic
  memory/      Namespaced, append-only memory store backed by Prisma
  context/     Builds a conversational context window from recent memory
agents/
  types.ts       AgentInterface (objective, run(), status)
  research-agent.ts  Queries the `knowledge` table for real; NOT_IMPLEMENTED
                      for open-web research
  crm-agent.ts       Queries the `leads` table for real; NOT_IMPLEMENTED for
                      lead enrichment
  registry.ts    In-memory agent registry
tools/
  registry.ts    The Tool Registry: Tool interface, register(), execute()
  files.ts       REAL: sandboxed read/write/list under data/sandbox
  browser.ts     NOT_IMPLEMENTED (Phase 4: browser automation)
  computer.ts    NOT_IMPLEMENTED (Phase 4: desktop/computer control)
  voice.ts       NOT_IMPLEMENTED (voice + telephony/cold-calling)
  email.ts       CONFIGURATION_REQUIRED (needs SMTP_*)
  calendar.ts    CONFIGURATION_REQUIRED (needs GOOGLE_CALENDAR_*)
  web.ts         CONFIGURATION_REQUIRED (no search provider configured)
scheduler/
  index.ts       node-cron wrapper; jobs are data (persisted to `automations`),
                 not hardcoded; two log-only example jobs
security/
  logger.ts      Typed log(category, message, meta) using pino; persists
                 ACTION/AGENT/TOOL/SECURITY/CRITICAL entries to `system_logs`
  audit.ts       writeAuditLog() → `audit_logs`, redacted
  redact.ts      Strips likely secrets from any value before it's logged
config/
  env.ts         requireEnv()/optionalEnv() — throws a typed
                 ConfigurationRequiredError at the point of use, never at boot
database/
  schema.prisma  All 22 tables from spec section 35 (SQLite)
  client.ts      Shared PrismaClient singleton
  migrate.ts     Applies pending migrations at API startup
docs/
  ARCHITECTURE.md  (this file)
  PHASE_STATUS.md  What was built / what works / what's next
```

## Why these design choices

- **SQLite via Prisma, not Postgres**: Phase 1 must run with zero external
  infrastructure. A `DATABASE_URL` pointing at a local file is enough.
  `config/env.ts` defaults it to an absolute path under `database/dev.db` so
  the app works even before a `.env` file exists.
- **`core/`, `agents/`, `tools/`, `scheduler/`, `security/`, `config/` are
  plain top-level TypeScript directories, not separate npm packages.** They
  are consumed via relative imports from `apps/api` (and directly by tests).
  This keeps the module boundaries the spec asks for without the overhead of
  a full internal-package build pipeline, which isn't needed at this scale
  yet. `apps/api`, `apps/web`, and `apps/desktop` are the only npm
  workspaces.
- **No pre-compilation step for the API in dev**: `apps/api` runs directly
  via `tsx` (both `dev` and `start`), so there's no `rootDir`/`outDir`
  friction from importing sibling top-level directories. `npm run build -w
  apps/api` still exists (via `tsc`) for anyone who wants a compiled output.
- **Two decision types for "missing integration"**: `CONFIGURATION_REQUIRED`
  (the code path exists, but a third-party credential/service isn't
  configured — e.g. email, calendar, web search) vs. `NOT_IMPLEMENTED` (the
  functionality itself doesn't exist yet — e.g. browser/computer control,
  voice, cold-calling). Both are real, typed statuses returned by tools and
  agents; neither is ever silently swallowed or faked as success.
- **Memory is append-only**: writing to an existing `(namespace, key)` pair
  archives the previous `ACTIVE` row and inserts a new one recording what it
  superseded (`Memory.history()` returns the full chain). This matches spec
  section 6's example directly and is covered by tests.
- **The decision engine is a pure function** (`core/decision_engine/classify`)
  so it's trivially unit-testable and can be called from the orchestrator,
  agents, or the scheduler without any I/O dependency.
- **Logging categories are typed** (`LogCategory` in `security/logger.ts`)
  per spec section 36, and everything passed to `log()` is redacted first
  (`security/redact.ts`) so secrets never land in `system_logs` or stdout.

## What Phase 2+ should build on top of this

See `docs/PHASE_STATUS.md`'s "WHAT SHOULD BE BUILT NEXT" section.
