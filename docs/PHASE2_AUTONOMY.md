# Phase 2 / Step 3 — Autonomy Core

This document covers what was added on top of Phase 1's foundation: a
central Autonomy Policy Engine, a global system state machine, rate/resource
controls, a wired audit trail, a persistent/recoverable task engine, and a
minimal event bus. Voice, browser/computer automation, WhatsApp, live
trading, and mass outreach are explicitly out of scope here (unchanged
Phase 1/4 stubs).

## 1. The enforcement gate (the single choke point)

Every tool execution and every agent run passes through
`core/enforcement`'s `guardToolExecution`/`guardAgentExecution`. These are
not just wrappers called by the API routes — `ToolRegistry.register()`
(`tools/registry.ts`) and `registerAgent()` (`agents/registry.ts`) **mutate
the tool/agent object's own `execute`/`run` method in place** at
registration time. That means there is no unguarded `execute`/`run` left to
call, even for code that imports a tool or agent module directly instead of
going through the registry (`core/enforcement/enforcement.test.ts` proves
this for `tools/files.ts`'s `filesTool`).

Order of checks, per call:

1. **State gate** (`core/state`): is the system globally `PAUSED` or
   `EMERGENCY_STOP`? Is this specific agent paused, or this specific tool
   disabled?
2. **Rate & concurrency limits** (`core/limits`): per-tool/per-agent rate
   limit, global concurrent-agent limit.
3. **Policy gate** (`core/policy`): `evaluatePolicy()` — `BLOCKED` short-
   circuits with no execution; `NOTIFY` executes but creates a
   `Notification` row; `AUTONOMOUS` executes silently.

Every outcome — allowed or blocked — is written to `AuditLog` via
`security/audit.ts`'s `writeAuditLog()`, which redacts first
(`security/redact.ts`). Nothing bypasses this: agents cannot self-declare
permission because permission is decided by the gate wrapping their `run()`,
not by anything the agent itself returns or claims.

## 2. Autonomy Policy Engine (`core/policy`)

`evaluatePolicy(actionName, context)` does **not** duplicate
`core/decision_engine`'s `classify()` — it calls it, then maps the resulting
`DecisionCategory` onto one of three `PolicyLevel`s:

- **BLOCKED** — a hardcoded (`BLOCKED_KEYWORDS` in `core/policy/index.ts`),
  non-configurable-at-runtime list: financial transactions/broker trading,
  password/security changes, destructive data operations, legal
  commitments, account deletion, security-control bypasses. This list is
  checked *before* `classify()`'s result is even consulted, so no
  `autoApprovedActions` setting or agent claim can ever move a blocked
  action into an allowed level (see the policy test
  `"cannot be overridden into AUTONOMOUS by autoApprovedActions"`).
- **AUTONOMOUS** — known-safe names (research, internal data organization
  via `files`, scheduled reports, CRM read/update) or a `ROUTINE`
  classification with no override.
- **NOTIFY** — external communications (`email`, `calendar`, `voice`,
  `browser`, `computer`), `HIGH_IMPACT`/`INFORMATION_MISSING`/
  `CRITICAL_SYSTEM_FAILURE` decisions, and any `CONFIGURED_BUSINESS_ACTION`
  without an explicit safe-list entry (a deliberate "notify by default for
  anything not explicitly known-safe" choice).

## 3. Global JARVIS State (`core/state`)

Persisted through the existing `settings` key-value table (no new tables):
`system.state`, `system.paused_agents`, `system.disabled_tools`. States:
`RUNNING | PAUSED | MAINTENANCE | DEGRADED | EMERGENCY_STOP`.

- `pauseAgent`/`resumeAgent`/`isAgentPaused`, `disableTool`/`enableTool`/
  `isToolDisabled` — per-name toggles.
- `emergencyStop(actor, reason)` sets `EMERGENCY_STOP` **and** pauses every
  currently-registered agent **and** disables every currently-registered
  tool. Design choice (documented in code): no tool in this repo is treated
  as exempt/read-only-safe — `files` can write, and the rest are external-
  facing or NOT_IMPLEMENTED stubs whose real implementation would be riskier
  — so emergency stop disables everything rather than guessing at a safe
  subset.
- `recover(actor, reason)` returns state to `RUNNING` but does **not**
  auto-resume paused agents or auto-enable disabled tools — an operator
  explicitly brings back exactly what they intend to.

API routes: `GET /system/state`, `POST /system/pause`, `POST
/system/resume`, `POST /system/emergency-stop`, `POST
/system/agents/:name/pause`, `POST /system/agents/:name/resume`, `POST
/system/tools/:name/disable`, `POST /system/tools/:name/enable` (plus two
read-only convenience routes for paused/disabled state).

## 4. Rate & Resource Controls (`core/limits`)

In-process rolling-window counters (NOT a distributed rate limiter — see
Limitations below), configurable via the `settings` table (key
`limits.config`) with sane defaults: `toolRateLimitPerMinute` (60),
`agentRateLimitPerMinute` (30), `concurrentAgentLimit` (5), `retryLimit`
(3), `dailyTaskLimit` (500). Every block is logged via
`log("SECURITY", ...)` and written to the audit log by the enforcement gate.

## 5. Persistent Task Engine (`core/planner`, `core/tasks`)

`Task.status` is now `PENDING | QUEUED | IN_PROGRESS | WAITING | BLOCKED |
RETRYING | DONE | FAILED | CANCELLED` (migration
`task_retry_and_autonomy`, which also added `Task.retryCount`).
`core/tasks/recoverUnfinishedTasks()` runs once at API boot
(`apps/api/src/index.ts`): any task still `IN_PROGRESS` from a previous,
now-dead process is moved to `RETRYING` (if under `retryLimit`) or `FAILED`
(if not), with a logged reason — never silently left "running" forever.

## 6. Event Bus (`core/events`)

A minimal in-process bus: `publish({type, payload, source})` persists to the
existing `events` table (redacted) and then calls any `subscribe(type,
handler)` handlers in order; handler errors are logged, never thrown back at
the publisher. **One real path is wired end-to-end** as proof of
`EVENT -> DECISION`: the scheduler publishes `"scheduler.fired"` on every job
run, and `core/planner.planTask()` publishes `"task.created"`;
`registerDefaultSubscribers()` (called at API boot) subscribes to both and
runs `evaluatePolicy()` on them, logging the result. CRM/email/web-monitoring
event sources are intentionally not built (out of scope for this phase).

## Limitations (honest accounting)

- **Rate limiter is per-process, not distributed.** Running multiple API
  processes against the same SQLite file would let each process enforce its
  own counters independently — fine for Phase 2's single-process deployment
  target, not safe as-is for horizontal scaling.
- **Emergency stop is not instant for an in-flight call.** The gate is
  checked *before* a tool/agent's real logic starts; a call already past the
  gate and mid-execution when `emergencyStop()` fires will finish. Nothing
  new is allowed to start.
- **State/limit checks add a DB round-trip per call** (no unsynchronized
  in-memory cache), which is correct across multiple processes sharing one
  SQLite file but adds latency. Acceptable at Phase 2 scale.
- **`NOTIFY` creates a `Notification` row but does not yet push it anywhere**
  (no email/SMS/push delivery) — that's for whichever later phase wires a
  real notification channel.
- **No authentication** — `actor` on system-state API routes is
  self-reported in the request body; this matches Phase 1's accepted,
  documented gap (single trusted operator), not something this phase fixes.
