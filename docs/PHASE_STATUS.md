WHAT WAS CREATED
- A TypeScript monorepo (npm workspaces: apps/api, apps/web, apps/desktop) with
  shared top-level modules: core/, agents/, tools/, scheduler/, security/,
  config/, database/.
- apps/api: an Express + TypeScript backend exposing /health, /chat, /tools,
  /agents, /tasks, and /memory, wired to the orchestrator, tool registry,
  agent registry, and planner.
- apps/web: a React + Vite dashboard shell with a dark, minimal theme and the
  13 tabs from spec sections 25/40 (Home, Business, CRM, Tasks, Agents,
  Calls, Email, Files, Intelligence, Memory, Automations, Settings, System)
  as routed pages. Home has a working chat panel wired to the real /chat API.
- apps/desktop: a minimal Electron shell that loads apps/web in a window,
  clearly commented as PHASE 4 - NOT IMPLEMENTED for computer control, voice,
  and other desktop-native features.
- database/schema.prisma: all 22 tables from spec section 35 (users, memory,
  contacts, companies, leads, clients, communications, calls, emails, quotes,
  orders, products, tasks, agents, agent_runs, events, automations,
  notifications, documents, knowledge, skills, system_logs, audit_logs,
  settings) on SQLite, with a generated initial migration
  (database/migrations/20260928053732_init).
- core/memory: full CRUD + namespaced, append-only conflict handling (update
  archives the old value and inserts a new one, matching spec section 6).
- core/decision_engine: classify() implementing the five-way categorization
  from spec section 29 as a pure, tested function.
- core/orchestrator: accepts a chat message, optionally invokes a tool, calls
  the AI provider abstraction, and logs the exchange to CONVERSATION memory
  and to system_logs.
- core/planner: a Task type (per spec section 5) with naive (non-LLM)
  decomposition, persisted to the `tasks` table.
- core/ai/provider.ts: an AIProvider interface with an AnthropicProvider
  implementation that returns a typed CONFIGURATION_REQUIRED result (never a
  fake response) when ANTHROPIC_API_KEY is missing.
- agents/: an AgentInterface plus two real stub agents - `research` (queries
  the `knowledge` table for real) and `crm` (queries the `leads` table for
  real) - each explicitly returning NOT_IMPLEMENTED for the parts of their
  job that need an unavailable third-party integration.
- tools/: a Tool Registry plus seven built-in tools. `files` genuinely reads/
  writes/lists inside a sandboxed directory. `browser`, `computer`, and
  `voice` return NOT_IMPLEMENTED. `email`, `calendar`, and `web` return
  CONFIGURATION_REQUIRED, naming the missing env vars.
- scheduler/: a node-cron-based scheduler whose jobs are config-driven (
  persisted to the `automations` table, not hardcoded), with two safe,
  log-only example jobs (a daily heartbeat and an hourly stale-lead count).
- security/: env loading via dotenv, a redact() utility that strips
  likely secrets before anything is logged or persisted, an audit-log writer
  (`audit_logs`), and a typed structured logger (pino) covering the ten log
  categories from spec section 36, persisting
  ACTION/AGENT/TOOL/SECURITY/CRITICAL entries to `system_logs`.
- config/: .env.example documenting every env var referenced anywhere in the
  code, and a typed loader (requireEnv/optionalEnv) that throws a clear
  "CONFIGURATION REQUIRED: X" error at the point of use rather than crashing
  at boot.
- Tests (vitest, 30 passing): memory CRUD + append-only history, decision
  engine classification (8 scenarios), tool registry (register/execute/
  NOT_IMPLEMENTED/throwing tool), the sandboxed files tool, scheduler job
  registration (cron + event-trigger + invalid-schedule rejection), and an
  API smoke test (/health, /chat failing cleanly with CONFIGURATION_REQUIRED
  when no API key is set, /tools listing).
- docs/ARCHITECTURE.md, docs/PHASE_STATUS.md (this file), and a root
  README.md with full setup instructions.

WHAT WORKS
- npm install (installs all workspaces, generates the Prisma client).
- npm run prisma:migrate (creates database/dev.db and applies the schema).
- npm run dev -w apps/api: starts a real Express server on :4000, applies
  pending migrations automatically, registers all tools/agents, starts the
  scheduler, and serves /health, /chat, /tools, /agents, /tasks, /memory.
- npm run dev -w apps/web (and npm run build -w apps/web): a real Vite dev
  server / production build of the dashboard shell.
- A user can type a message in the Home tab's chat panel (or POST /chat
  directly) and get a real reply from the orchestrator. With
  ANTHROPIC_API_KEY set, it's a real Claude completion; without it, JARVIS
  returns an honest CONFIGURATION_REQUIRED message instead of failing
  silently.
- JARVIS can execute registered tools: POST /tools/files/execute with
  {"action":"write","path":"note.txt","content":"hi"} genuinely writes a file
  under data/sandbox/, and POST /chat with a toolCall invokes it inline as
  part of a conversation.
- Agents can be run via POST /agents/:name/run and genuinely query the
  database (leads / knowledge tables).
- Memory read/write/search/history all work end-to-end against SQLite,
  including the append-only conflict-handling behavior.
- The scheduler genuinely registers and fires cron jobs (verified: the
  daily-heartbeat and hourly-stale-lead-check jobs start on API boot).
- npm test: 30/30 tests passing across 6 test files.

WHAT IS NOT IMPLEMENTED
- Voice input/output and telephony, including cold-calling (tools/voice.ts;
  calls/emails tables default to status "NOT_IMPLEMENTED").
- Browser automation (tools/browser.ts) and computer/desktop control
  (tools/computer.ts, apps/desktop) - explicitly Phase 4 per the spec.
- Sending real email (tools/email.ts - CONFIGURATION_REQUIRED, no SMTP
  client wired in) and real calendar integration (tools/calendar.ts -
  CONFIGURATION_REQUIRED, no OAuth flow wired in).
- Real web search / open-web research (tools/web.ts, and the research
  agent's external-research path) - no search provider is configured.
- WhatsApp and any other messaging channel beyond the in-app chat.
- LLM-driven task planning (core/planner does naive, deterministic
  decomposition only - no AI-generated subtasks yet).
- Lead enrichment / external CRM data augmentation (agents/crm-agent.ts
  reports this explicitly as NOT_IMPLEMENTED when requested).
- Any authentication/authorization layer on the API (Phase 1 assumes a
  single trusted operator; there is a `users` table and a `role` field, but
  no login flow, sessions, or route guards yet).
- A real, populated dashboard: every non-Home tab is a routed placeholder
  page that says what it will eventually show and points at the real backend
  endpoint(s) that already back it.
- Event-triggered and condition-triggered scheduler jobs are interfaces only
  (scheduler/index.ts accepts these trigger types and persists them, but
  there is no event bus or condition-evaluation engine yet to actually fire
  them).
- Vector/embedding-based memory search (core/memory/search is a simple
  substring match over ACTIVE entries, ordered by importance/recency).

WHAT DEPENDENCIES ARE REQUIRED
- Node.js 20+ and npm 10+ (developed/tested against Node v22, npm 10.9.7).
- No external database server - SQLite is file-based via Prisma.
- ANTHROPIC_API_KEY (optional): required only for /chat to produce a real AI
  reply. Get one from the Anthropic Console. Without it, /chat still works
  and returns a typed CONFIGURATION_REQUIRED response.
- For future phases (not required now, but documented in .env.example):
  SMTP_HOST/PORT/USER/PASSWORD (email), GOOGLE_CALENDAR_CLIENT_ID/SECRET
  (calendar), TWILIO_ACCOUNT_SID/AUTH_TOKEN/PHONE_NUMBER and
  WHATSAPP_BUSINESS_TOKEN (telephony/messaging), BROWSERBASE_API_KEY
  (browser automation).

PHASE 2 / STEP 3 UPDATE (AUTONOMY CORE) — see docs/PHASE2_AUTONOMY.md for
full detail; summary below.

NEWLY IMPLEMENTED
- core/policy: the Autonomy Policy Engine. evaluatePolicy() calls the
  existing core/decision_engine.classify() and maps its DecisionCategory
  onto AUTONOMOUS | NOTIFY | BLOCKED. BLOCKED is a hardcoded, non-runtime-
  configurable list (financial transactions/trading, password/security
  changes, destructive data operations, legal commitments, account
  deletion, security-control bypasses) that no setting or agent claim can
  override.
- core/enforcement: the single gate every tool execution and agent run
  passes through. tools/registry.ts's ToolRegistry.register() and
  agents/registry.ts's registerAgent() now mutate the tool/agent object's
  own execute()/run() in place, so there is no unguarded code path left,
  even for a caller holding a direct reference to the tool/agent object.
  Order: system-state gate -> per-agent/per-tool pause/disable -> rate/
  concurrency limits -> policy engine. BLOCKED short-circuits with zero
  execution; NOTIFY executes and creates a Notification row; every outcome
  (allowed or blocked) is written to the audit log (writeAuditLog, which was
  implemented in Phase 1 but genuinely called from nowhere until now).
- core/state: Global JARVIS System State (RUNNING | PAUSED | MAINTENANCE |
  DEGRADED | EMERGENCY_STOP), persisted via the existing `settings` table.
  Per-agent pause/resume, per-tool disable/enable, emergencyStop() (pauses
  every registered agent and disables every registered tool), and a safe
  recover() that returns to RUNNING without auto-resuming anything. New API
  routes: apps/api/src/routes/system.ts (GET /system/state, POST
  /system/pause|resume|emergency-stop, POST /system/agents/:name/
  pause|resume, POST /system/tools/:name/disable|enable).
- core/limits: in-process, per-tool/per-agent rolling-window rate limits,
  a global concurrent-agent limit, a retry limit, and a daily task limit -
  configurable via `settings` (key limits.config) with sane defaults, not
  distributed (see docs/PHASE2_AUTONOMY.md).
- core/events: a minimal in-process event bus (publish/subscribe), backed
  by the existing `events` table. One real path is wired end-to-end as
  proof of EVENT -> DECISION: the scheduler publishes "scheduler.fired" on
  every job run and the planner publishes "task.created"; a default
  subscriber runs both through evaluatePolicy() and logs the result.
  scheduler/index.ts's event/condition trigger types are still interfaces
  only (no dispatcher) beyond this one proof-of-pipe.
- core/planner + core/tasks: Task.status extended to PENDING | QUEUED |
  IN_PROGRESS | WAITING | BLOCKED | RETRYING | DONE | FAILED | CANCELLED
  (migration `task_retry_and_autonomy`, which also added Task.retryCount).
  core/tasks.recoverUnfinishedTasks() runs once at API boot
  (apps/api/src/index.ts) and moves any task still IN_PROGRESS from a dead
  previous process to RETRYING or FAILED, honestly logged.
- 45 new tests across core/policy, core/state, core/limits, core/events,
  core/enforcement, core/tasks, and two new apps/api smoke tests (system
  routes) - 75/75 tests passing in total (up from 30/30 in Phase 1).

WHAT SHOULD BE BUILT NEXT
- Phase 2 integrations behind the existing tool stubs: a real SMTP client for
  tools/email.ts, a Google Calendar OAuth flow for tools/calendar.ts, and a
  real search/fetch provider for tools/web.ts - each should just need to
  fill in the existing CONFIGURATION_REQUIRED branches.
- A real (LLM-backed) planner: extend core/planner to call the AI provider
  for goal decomposition instead of the current naive flat-subtask approach.
- Populate the dashboard's CRM, Tasks, Agents, Memory, Automations, and
  System tabs with real tables/lists reading from the already-working API
  endpoints (the backend support already exists; only the UI is a
  placeholder).
- An authentication layer (the `users` table and `role` field already exist)
  before this is exposed to more than one trusted operator.
- A minimal event bus foundation now exists (core/events, with one real
  scheduler/planner -> policy path wired as proof); still needed: a
  condition-evaluation engine for condition-triggered automations, and real
  event *sources* (CRM changes, inbound email, web monitoring) publishing
  into the bus instead of just the scheduler/planner proof-of-pipe.
- Authentication + tying the audit log's `actor` field to a real logged-in
  user instead of a self-reported request field, now that writeAuditLog is
  wired into every tool/agent execution path.
- Voice (STT/TTS) and telephony integration behind tools/voice.ts, once a
  concrete provider (e.g. Twilio + a speech API) is chosen - this unlocks
  cold-calling, which the spec treats as a headline Phase 2/3 feature.
- Browser automation (tools/browser.ts) via a provider like Browserbase or
  Playwright, and native computer control (tools/computer.ts,
  apps/desktop) - both explicitly scoped to Phase 4 in the spec.
- Lead enrichment for agents/crm-agent.ts and open-web research for
  agents/research-agent.ts, once a data/search provider is chosen.

PHASE 3 UPDATE (IDENTITY & EVENTS) — see docs/PHASE3_IDENTITY_EVENTS.md for
full detail; summary below.

NEWLY IMPLEMENTED
- core/auth: real authentication. bcrypt password hashing (12 rounds),
  server-side revocable sessions (new `Session` table - raw token returned
  once, only its SHA-256 hash persisted), a channel-agnostic `Identity` type
  (OWNER | SYSTEM | AGENT | SERVICE) used everywhere downstream instead of a
  bare string, and `scripts/seed-owner.ts` (`npm run seed:owner`) as the
  ONLY way to create the OWNER account - no HTTP endpoint can self-elevate.
- apps/api/src/middleware/auth.ts + apps/api/src/routes/auth.ts: bearer-
  token auth middleware (`requireAuth`, `requireRole`, `requireAuthz`),
  POST /auth/login (rate-limited, generic invalid-credentials error that
  never reveals which field was wrong), POST /auth/logout, GET /auth/me.
  Every route except GET /health and POST /auth/login now requires
  authentication; /system mutation routes require OWNER specifically.
- core/authz: Owner Command Authority - a coarse, role-based "is this
  identity allowed to request this kind of action at all" gate, explicitly
  separate from core/policy's action-content-based AUTONOMOUS/NOTIFY/
  BLOCKED classification. Runs before core/enforcement's existing gate.
  Being OWNER-authorized to request an action never overrides a hardcoded
  BLOCKED policy outcome (proven in apps/api/tests/security.test.ts).
- core/enforcement: guardToolExecution/guardAgentExecution now accept an
  optional Identity and derive the audit `actor` from it
  (identityToActorString), defaulting to SYSTEM_IDENTITY - the old
  hardcoded `actor: "system"` string is gone from every code path.
- core/notifications: a real Notification Service (Repository -> Service ->
  Dispatcher). Exactly one real delivery channel (DashboardChannel,
  persists for the web dashboard to poll); Desktop/Email/WhatsApp/SMS/
  Phone/Push channels are honest NOT_IMPLEMENTED stubs. Replaces
  core/enforcement's old ad-hoc direct-Prisma createNotification() helper.
  New GET /notifications, PATCH /notifications/:id/read routes.
- core/events: typed event categories (SYSTEM/SCHEDULE/USER/TASK/AGENT/CRM/
  NOTIFICATION implemented with payload shape validation; EMAIL/WEB/MARKET/
  VOICE/CALENDAR reserved, no source built) with validation (publish()
  rejects an unknown-category or malformed-payload typed event) and routing
  (a typed event is run through core/conditions after being persisted and
  notifying subscribers) - legacy lowercase event types remain unvalidated
  for backward compatibility with Phase 1/2 code.
- core/conditions: a declarative condition engine (all/any/not/{field,op,
  value}, operators eq/neq/gt/gte/lt/lte/in/contains) that NEVER uses eval
  or new Function, fails closed on malformed/unknown-operator input, and
  explicitly blocks __proto__/prototype/constructor field traversal. Rules
  are DATA in a new `ConditionRule` table; two real, seeded examples wired
  end-to-end (CRM new-hot-lead -> research task; SCHEDULE morning-briefing
  -> briefing task), both via core/planner.planTask().
- scheduler/index.ts: cron jobs now publish a typed SCHEDULE.fired event
  instead of running business logic directly in the cron callback; new
  AutomationRun execution-history table; duplicate-execution prevention;
  bounded retry via core/limits; explicit per-job timezone (default UTC);
  best-effort missed-schedule detection at registration; live enable/
  disable (Scheduler.setEnabled, new /system/scheduler/:name/enable|disable
  routes) that survives a simulated process restart by honoring the
  persisted `enabled` flag.
- core/health: ten real component checks (api, database, scheduler, event
  bus, task queue, agents, tool registry, memory, disk, CPU/memory) behind
  GET /system/health (requires authentication - task/agent counts are
  business-sensitive). Disk uses fs.statfs (works in this sandbox) with an
  honest UNKNOWN fallback rather than a fabricated number.
- 51 new tests (core/auth, core/authz, core/notifications, core/conditions,
  core/health, extended core/events, extended scheduler, and a new
  apps/api/tests/security.test.ts covering the full required security
  checklist) - 126/126 tests passing in total (up from 75/75 in Phase 2).

WHAT SHOULD BE BUILT NEXT
- A real per-tool/per-agent grant matrix for AGENT/SERVICE identities in
  core/authz, plus an actual internal-service credential mechanism (they are
  code-only constants today, with no HTTP login flow of their own).
- Real event sources for the still-reserved categories (CRM, EMAIL, WEB,
  MARKET, VOICE, CALENDAR) - only the scheduler and manual/test publishes
  produce typed events right now.
- A real cron-expression parser for accurate missed-schedule detection
  (today's check uses rough per-trigger-type cadence hints).
- More condition-engine actionType kinds beyond create_task (e.g.
  send_notification, run_agent).
- Voice/telephony, browser/computer automation, real email/calendar/web
  search integrations - unchanged from Phase 1/2's scope (explicitly out of
  scope here too, per the non-negotiables in docs/PHASE3_IDENTITY_EVENTS.md).

PHASE 4 UPDATE (BRAIN & MEMORY) — see docs/PHASE4_BRAIN_MEMORY.md for full
detail; summary below.

NEWLY IMPLEMENTED
- core/ai: the AI provider layer is completed - configurable request
  timeout, bounded retry with backoff on transient (429/5xx) failures only,
  real Anthropic native tool-use (tools/toolUses on AICompletionResult),
  real token usage capture (response.usage, never estimated) persisted to a
  new AiUsage table with an approximate, documented per-model cost estimate
  (core/ai/pricing.ts). Streaming is honestly NOT implemented - nothing
  built in this phase consumes a token stream.
- core/ai/costControl.ts: configurable daily/monthly USD spend limits
  (`settings` key ai.cost_control), checked before every Brain-initiated LLM
  call; exceeding either limit skips the call, raises a real Notification,
  and moves the associated task (if any) to WAITING.
- core/brain: the JARVIS Core Brain - OBSERVE -> UNDERSTAND -> RETRIEVE ->
  PLAN -> POLICY CHECK -> EXECUTE -> VERIFY -> REMEMBER -> REPORT for one
  request. Plans are proposed via real Anthropic tool-use (a synthetic
  `propose_plan` tool), validated as pure data before any step executes
  (core/brain/plan.ts, never eval'd), and every step runs ONLY through the
  existing tools/registry.execute()/agents/registry .run() - the same
  objects core/enforcement already wraps - never a bypass path (proven in
  core/brain/brain.test.ts, mirroring Phase 2's enforcement no-bypass
  proof). Checks core/state before starting and between steps, so a
  PAUSED/EMERGENCY_STOP system halts a multi-step plan mid-run rather than
  finishing it. A step needing a NOT_IMPLEMENTED/CONFIGURATION_REQUIRED
  tool honestly returns REQUIRES_TOOL - never fabricated success (the "50
  apparel prospects" case from the spec is a real, tested behavior). /chat
  now routes through the Brain (a strict superset of the old orchestrator);
  the pre-existing CONFIGURATION_REQUIRED chat test still passes unmodified.
- core/context: the Phase 1 stub is replaced with a real, bounded Context
  Builder - capped conversation history, deterministic keyword-matched
  relevant memories (explicitly no embeddings), active tasks, business-
  heuristic recent leads, system state, and available (non-disabled) tools.
- core/memory: extended with content/source/confidence/relatedEntity/
  metadata/expiresAt/updatedAt fields and a 10th namespace (DECISION), plus
  remember/retrieve/supersede/forget operations (aliases over the existing
  append-only create/read/update, so nothing breaks) - forget() sets
  expiresAt without ever deleting a row, matching the append-only history
  design.
- core/planner: planFromPlan() creates a parent Task + one subtask per Plan
  step, tagged with stepId/agentName/toolName (new nullable Task columns);
  planTask/updateTaskStatus/listTasks unchanged for existing callers.
- agents/: AgentRunResult gained evidence/result/errors/nextAction (purely
  additive); two new real, DB-backed agents - TaskAgent (wraps
  core/planner) and SystemAgent (read-only core/health/core/state queries,
  cannot pause/stop/disable anything). agents/contract.ts's
  checkAgentResultContract() is a real runtime check that an agent never
  reports SUCCESS with empty evidence.
- apps/api: new GET /brain/tasks and GET /brain/usage observability routes
  (new brain.read authz action), never exposing raw model reasoning.
- Database: migration `phase4_brain_memory` (Memory's new columns + DECISION
  namespace value, new AiUsage table, Task's stepId/agentName/toolName
  columns).
- 38 new tests (core/memory extended to 10, core/brain/plan.test.ts,
  core/brain/brain.test.ts, core/ai/costControl.test.ts,
  agents/contract.test.ts) - 164/164 tests passing in total (up from
  126/126 in Phase 3).

WHAT SHOULD BE BUILT NEXT (as of end of Phase 4)
- A standing autonomous loop (Phase 5): a scheduler/event-driven loop that
  re-invokes the Brain against active/waiting tasks without a human message
  triggering each run.
- Real event sources for the still-reserved categories (CRM/EMAIL/WEB/
  MARKET/VOICE/CALENDAR) so the Brain can react to real business events.
- A fuller dependency-graph scheduler for Plan steps (today: one concurrent
  batch of independent steps, then sequential) and a deeper, multi-attempt
  re-planning loop (today: one single documented re-plan attempt).
- Real integrations behind the still-stubbed tools (email/calendar/web
  search/browser/computer/voice) - unchanged scope from Phases 1-3.

PHASE 5 UPDATE (AUTONOMOUS WORKER) — see docs/PHASE5_AUTONOMOUS_WORKER.md for
full detail; summary below.

NEWLY IMPLEMENTED
- core/worker: a standing Autonomous Worker loop (`Worker` class, singleton
  `worker`), started once at API boot alongside `recoverUnfinishedTasks()`.
  An in-process `setInterval` tick (default 2s) + a separate, faster
  heartbeat interval (default 1s) - genuinely keeps running for as long as
  the API process is alive, honestly NOT a separate OS-level daemon (no
  process supervisor in this stack). Every tick: reclaims expired claims,
  checks system state, re-checks stale WAITING/BLOCKED tasks on a cooldown,
  selects eligible top-level tasks in priority order, claims them (DB-backed,
  see below), and executes each through the exact same
  `toolRegistry.execute()`/`agent.run()`/`brain.handle()` paths every other
  caller uses - proven by two explicit no-bypass tests mirroring Phase 2's.
- core/worker/eligibility.ts: `isTaskEligible()` - a deterministic pre-filter
  (status, scheduled time, parent-task dependency, system state, retry
  backoff/limit, agent-pause, tool-disable, autonomy-policy pre-check,
  rate-limit pre-check). A failing task transitions to WAITING or BLOCKED
  with a persisted, human-readable reason (new `Task.waitingReason`/
  `blockedReason` columns) and is excluded from the main candidate query
  entirely - a bounded, cooldown-gated re-check pass (never every tick)
  re-evaluates WAITING/BLOCKED tasks separately.
- core/worker/claim.ts: DB-backed task claiming - a single conditional
  `prisma.task.updateMany()` is the lock, not an in-memory mutex; a test
  fires two concurrent claim attempts on the same row and asserts exactly
  one succeeds. Claims expire (`claimExpiresAt`), and `reclaimExpiredTasks()`
  (run every tick, plus extended into boot-time `recoverUnfinishedTasks()`)
  is the crash-recovery mechanism for a task a now-dead worker slot
  abandoned mid-flight - tested end-to-end (crash -> restart -> RETRYING ->
  claim cleared -> reclaimable, duplicate execution prevented by the DB
  write, not luck).
- core/worker/heartbeat.ts + new `WorkerHeartbeat` table: liveness exposed as
  an 11th `GET /system/health` component (`core/health`'s existing ten
  checks are unchanged).
- core/worker/watchdog.ts: detects heartbeat timeout, repeated failures,
  task starvation, queue growth, and excessive retries. Can restart the
  worker loop with exponential backoff and a hard cap on attempts within a
  time window - genuinely never an infinite restart loop (tested); giving up
  permanently marks the heartbeat CRASHED, raises a CRITICAL notification,
  and writes an audit log entry.
- core/planner: priority reconciled to the canonical CRITICAL|HIGH|NORMAL|LOW
  (URGENT retired; migration rewrites any existing URGENT rows). New
  `core/worker/queue.ts` orders candidates by priority then creation time; a
  single repeatedly-failing task cannot starve the queue (its own backoff
  keeps it out of the way without blocking the rest).
- core/worker/spawn.ts + `agents/task-agent.ts`'s new `create_child` action:
  autonomous follow-up task creation (parentId set to the originating task),
  with hard-enforced (not just documented) limits - max children per parent,
  max recursion depth, max tasks per tree, and duplicate detection - each
  individually tested; every rejection raises a WARNING notification and an
  audit log entry.
- scheduler/index.ts + core/conditions/rules.ts: a new `daily-report` cron
  job (21:00 UTC) alongside the existing Phase 3 `morning-briefing` job
  (left at 07:00, not moved to 05:00 - a documented, deliberate choice),
  following the identical publish-then-condition-rule pattern; the created
  task is tagged `toolName:"reports"` so the worker runs it directly.
- core/reports/dailyReport.ts + new `tools/reports.ts` + new `DailyReport`
  table: a Daily Executive Report generated strictly from real data (Task
  rows by status with their real persisted reasons, WorkerHeartbeat uptime,
  SystemLog error counts, AiUsage cost/token totals, Lead counts) - a
  business metric with no real data source is reported as the literal
  string "no data", never fabricated.
- apps/api: `POST /tasks/:id/resume` (owner interruption - publishes a real
  `USER.task_resumed` event, moves a WAITING/BLOCKED task back to PENDING);
  new `GET /worker/status`, `GET /worker/report/latest`, `GET /worker/actions`
  observability routes (new `worker.read`/`worker.write`/`report.read`
  authz actions).
- core/events/sources.ts: real TypeScript interfaces + explicit
  NOT_IMPLEMENTED stub classes for CRMEventSource/EmailEventSource/
  WebEventSource/MarketEventSource/VoiceEventSource/CalendarEventSource -
  foundation only, no real adapter built for any of them. TASK and USER
  events now have real publish paths (the worker's outcome events, the
  owner-resume route).
- Database: migration `phase5_autonomous_worker` (Task gained
  waitingReason/blockedReason/failureReason/claimedBy/claimedAt/
  claimExpiresAt/lastEligibilityCheckAt; URGENT priority rows rewritten to
  CRITICAL; new WorkerHeartbeat and DailyReport tables).
- 49 new tests (core/worker/* - eligibility, claim, heartbeat, watchdog,
  spawn, worker loop incl. two NO-BYPASS proofs; core/reports/dailyReport;
  agents/task-agent's create_child; apps/api/tests/worker; a new
  core/conditions test for the daily-report rule) - 213/213 tests passing in
  total (up from 164/164 in Phase 4).

WHAT SHOULD BE BUILT NEXT (as of Phase 5)
- Real event sources for the still-reserved categories (CRM/EMAIL/WEB/
  MARKET/VOICE/CALENDAR) - a genuine CRM webhook receiver would be the
  highest-leverage one, since the crm-new-hot-lead-research condition rule
  already exists and is only ever exercised by manual/test publishes today.
- A tighter Brain-to-existing-task integration, so a worker-delegated
  generic (untagged) task's own row reflects the Brain's real step-by-step
  progress instead of a single terminal status once the Brain's own,
  separate task tree finishes.
- A real cron-expression parser for the scheduler's missed-schedule
  detection (carried over from Phase 3, still not addressed).
- Real integrations behind the still-stubbed tools (email/calendar/web
  search/browser/computer/voice) - unchanged scope from Phases 1-4.

================================================================================
PHASE 6 UPDATE (WEB RESEARCH & AUTONOMOUS INTELLIGENCE) — see
docs/PHASE6_WEB_RESEARCH.md for the full design note, the prompt-injection
trust boundary, the provenance model, and an exhaustive real-vs-foundation-
only breakdown. Summary:

- New `tools/web/` package: a real `SearchProvider` interface with a real,
  HTTP-backed `BraveSearchProvider` (UNTESTED against the live Brave API - no
  credential available in this sandbox; carefully implemented from its
  documented request/response shape, honestly flagged as such) and a real
  `WebFetchTool`/`WebSearchTool` pair registered into the SAME
  `toolRegistry`/enforcement gate as every other tool. Both honestly return
  `CONFIGURATION_REQUIRED` with no credential, exactly like
  `core/ai/provider.ts`'s pattern - `tools/web.ts` (the old permanent stub)
  is left in place, unmodified.
- `WebFetchTool` enforces: protocol allowlist, timeout, a hard redirect
  limit, a streamed response-size cap, a content-type allowlist, dependency-
  light HTML extraction (title/text, scripts/styles stripped, `<link
  rel=canonical>` resolution), and honest `BLOCKED` on a 401/403/407/429 or
  a bot-challenge-shaped page - it never attempts to bypass CAPTCHAs, login
  walls, or anti-bot protections.
- `core/research/trustBoundary.ts`: the prompt-injection defense. Every
  piece of extracted web text is wrapped in an explicit
  `EXTERNAL_WEB_CONTENT` delimiter block before it could ever reach an AI
  provider prompt; a best-effort, LOG-ONLY (never blocking) pattern scan
  flags obvious injection attempts for human review. The real guarantee is
  architectural: even a "tricked" model can only ever propose a Plan step
  naming a REGISTERED tool/agent, validated by `validatePlan()` and run
  through the exact same enforcement gate - injected web content cannot
  grant a new capability (tested directly in
  `core/research/trustBoundary.test.ts`'s test N).
- New Prisma models `ResearchRun`/`ResearchSource`/`ResearchEvidence`/
  `ResearchTopic`/`SkillCandidate` (migration `phase6_web_research`) giving
  real, queryable source provenance: Memory -> ResearchEvidence ->
  ResearchSource -> ResearchRun is a real join chain
  (`core/research/provenance.ts`), exposed via `GET
  /research/provenance/:memoryId`.
- `agents/research-agent.ts` upgraded: internal knowledge first, then real
  web search/fetch only if configured, evidence classified
  FACT/SOURCE_CLAIM/ANALYSIS/UNCERTAINTY (never auto-FACT from one source),
  cross-source comparison surfaces conflicts rather than silently picking a
  side, and Memory writes carry real source/confidence/provenance and use
  `supersede()`.
- `core/events/webEventSource.ts`: the `WEB` event category is now real (not
  just reserved) - bounded, `ResearchTopic`-driven polling (never more than
  once/hour/topic, enforced) that only ever calls `publish()`, never
  executes a tool itself; a new `web-new-research-result` `ConditionRule`
  turns a genuinely new result into a task, delegated to the (now
  web-capable) research agent - the existing EVENT -> CONDITION -> TASK ->
  AGENT pipeline, unmodified.
- `agents/market-agent.ts`: forex/macro/gold/BTC research and monitoring
  ONLY, built from the identical search/fetch plumbing as the research
  agent. `agents/no-trading.test.ts` is a grep-based + registry-based
  architectural proof that no trading/broker/order-placement/fund-movement
  capability exists anywhere in the codebase.
- `core/skills/` (Skill Discovery/Registry, FOUNDATION ONLY, by design): a
  real lifecycle (`DISCOVERED -> CANDIDATE -> ANALYZING -> TESTING ->
  VERIFIED -> ACTIVATABLE -> ACTIVE|REJECTED`) with real static analysis
  (rejects `eval`/`new Function`/`child_process`/raw fs-or-network-module
  patterns). `ACTIVATABLE` is the ceiling anything automatic can reach;
  `ACTIVE` is OWNER-only, never automatic, and is a tracked status field
  only - it does NOT wire a skill into any tool/agent registry (that would
  need dynamic code loading, explicitly out of scope). Sandboxed code
  execution ("test in sandbox") is honestly `NOT_IMPLEMENTED`.
- `core/reports/dailyReport.ts` extended with a `research` section that
  honestly states whether web research is configured, rather than ever
  fabricating "overnight monitoring."
- New `core/research/limits.ts` (max searches/fetches per task, max
  concurrent research jobs, topic-poll minimum interval, failed-fetch
  backoff) and `core/research/dedup.ts` (content hashing + refresh-interval
  checks), both `Setting`-backed like `core/limits`.
- New observability routes `/research/*` and `/skills/*`, new `AuthzAction`s
  added additively (`research.read/write`, `skills.read/write/activate`).
  12th health check: whether a web search provider credential is configured
  (never a live network call from `/system/health`).
- `core/enforcement/`, `tools/registry.ts`'s/`agents/registry.ts`'s
  guarding, `core/state/`, `core/limits/`'s existing functions, `core/authz/`'s
  role table (extended additively only), `core/policy/`, `core/ai/costControl.ts`,
  and `core/worker/claim.ts` are all UNTOUCHED in their core mechanism -
  verified with `git diff --stat` at the end of this phase.
- 54 new tests (A-Z per the phase spec's test list) - 290/290 tests passing
  in total (up from 236/236 after Phase 5).

WHAT SHOULD BE BUILT NEXT (as of Phase 6)
- Real credentials/live testing for `BraveSearchProvider` (untested against
  the live API in this sandbox).
- A real code-execution sandbox for skill "test in sandbox" and the dynamic-
  loading mechanism an actual `ACTIVE` skill would need to be a live
  capability, not just a tracked status - both deliberately out of scope.
- Real event sources for the still-reserved categories (CRM/EMAIL/VOICE/
  CALENDAR) - WEB is now real, MARKET intelligence exists as an agent but
  MarketEventSource itself is still a stub.
- A semantic (not keyword-overlap) cross-source agreement/conflict detector
  for `core/research/evidence.ts`'s `compareAcrossSources()`.
