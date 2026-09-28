# Phase 5 — Autonomous Worker

This document covers what was added on top of Phase 4's Brain & Memory work:
a standing, in-process Autonomous Worker loop, deterministic task
eligibility, DB-backed task claiming, a heartbeat + watchdog, autonomous
follow-up task creation with hard limits, an Autonomous Daily Cycle, a Daily
Executive Report, and Owner-interruption handling. It does **not** rebuild
any existing infrastructure - it adds a caller that drives the Brain/
registries the same way any other caller does.

## 1. Worker architecture (`core/worker/index.ts`)

`Worker` is a plain class holding two `setInterval` timers, started once at
API boot (`apps/api/src/index.ts`, right after `recoverUnfinishedTasks()`):
a **heartbeat timer** (default 1s) that refreshes `WorkerHeartbeat.lastHeartbeat`,
and a **tick timer** (default 2s) that runs `Worker.tick()`.

Each tick: reclaim expired claims → check system state → back-off re-check of
stale WAITING/BLOCKED tasks → select candidate tasks (priority order) → for
each, run the eligibility pre-filter → claim (DB-backed) the first eligible
ones up to `maxWorkers` concurrent slots → execute each claimed task
asynchronously (`runSlot`) → on completion, release the claim, update the
task's status/reason, publish a `TASK.worker_outcome` event, and update the
heartbeat's processed/failed counters.

**Honesty about "always on"**: this is an in-process interval, not a
separate OS-level daemon. "Continues after the dashboard is closed" is true
- the dashboard is a browser tab, closing it does not touch the API process
- but if the API process itself stops, the worker stops with it. A real
always-on daemon would need a process supervisor (systemd/pm2/a container
restart policy), which is not part of this stack.

**Worker scope**: the worker's candidate pool is top-level tasks only
(`parentId: null, stepId: null`). A task tagged `stepId` is a Brain-plan
subtask already executed synchronously inside `core/brain/runPlan.ts` when
its parent plan ran - re-selecting it independently would double-execute it.
For a top-level task:
- tagged `toolName` → called directly via `toolRegistry.execute()`.
- tagged `agentName` → called directly via `agent.run()`.
- neither tagged → delegated to `brain.handle({message: title+description})`.
  The Brain creates and executes its **own** task tree for the request (that
  is how the Brain already works - it does not operate "on" an existing Task
  id). The original trigger task is then marked DONE/WAITING/BLOCKED/FAILED
  to reflect the Brain's real, honest outcome - never a fabricated success.
  This is a real, documented limitation: the "trigger" task and the "actual
  work" task tree are not the same rows. A tighter integration (the Brain
  operating in-place on a given task id) is future work.

Every path calls `toolRegistry.execute()` / `agent.run()` / `brain.handle()`
- the exact objects `core/enforcement` wraps - never a second, unguarded
code path. The worker's own identity is `WORKER_IDENTITY`
(`core/auth/identity.ts`, kind `SERVICE`, `service:worker`) - a dedicated,
code-only, non-HTTP-mintable identity distinct from `SYSTEM_IDENTITY`, so the
audit trail can tell "the scheduler did this" from "the autonomous worker did
this." It grants no extra capability; `core/authz`/`core/enforcement` apply
to it exactly as to any other caller.

## 2. Task Eligibility (`core/worker/eligibility.ts`)

`isTaskEligible(task)` is a pre-filter, not a second enforcement gate - the
real, authoritative checks still run inside `core/enforcement` at execution
time. In order: status (must be `PENDING`/`QUEUED`/`RETRYING`) → scheduled
time (`dueAt`) → dependency (parent task must be `DONE`) → system state
(`RUNNING`) → retry limit + exponential backoff (`30s * 2^retryCount`, capped
at 5 minutes) → tagged agent not paused → tagged tool registered and not
disabled → autonomy-policy pre-check (`core/policy.evaluatePolicy`) → rate
limit pre-check (new non-mutating `peekToolRate`/`peekAgentRate` in
`core/limits`). The first failing check wins, with a single, persisted,
human-readable reason.

A failing task transitions to **WAITING** (transient/informational: future
`dueAt`, system not RUNNING, rate-limited) or **BLOCKED** (policy/system:
paused agent, disabled/missing tool, policy BLOCKED, dependency unmet, retry
limit exhausted), never left silently un-run. `Task.waitingReason`/
`blockedReason` (new nullable columns) hold the exact reason;
`updateTaskStatus()` clears the opposite reason and clears both when the
status moves off WAITING/BLOCKED.

**Backoff (never hammer a blocked task)**: WAITING/BLOCKED tasks are excluded
from the main candidate query entirely (their status isn't in the eligible
set), so the tick loop's normal pass never touches them. A **separate**
pass (`selectStaleWaitingOrBlocked`, `Worker.recheckStaleTasks`) re-examines
up to `recheckBatchSize` (default 5) of them per tick, but only those whose
`lastEligibilityCheckAt` is older than `recheckCooldownMs` (default 60s) -
promoting a task back to `PENDING` only if its blocker has genuinely cleared.

**Known limitation**: a generic (untagged) task delegated to the Brain can
only be pre-filtered on system/policy/rate state - eligibility cannot detect
"the AI provider isn't configured" ahead of time (that's discovered inside
the Brain call itself). Such a task can flip WAITING → PENDING → WAITING on
each backoff cycle until the underlying configuration is fixed. This is
documented, not silently hidden - the WAITING reason names the real Brain
error each time.

## 3. Task Priority (`core/worker/queue.ts`, `core/planner`)

**Priority reconciliation**: the pre-Phase-5 `LOW|NORMAL|HIGH|URGENT` set is
retired in favor of the spec's canonical `CRITICAL|HIGH|NORMAL|LOW`
(`core/planner.TaskPriority`, `PRIORITY_ORDER`). Migration
`phase5_autonomous_worker` rewrites any existing `"URGENT"` rows to
`"CRITICAL"` (a no-op on this project's fresh databases, but correct if ever
run against data). Every call site that referenced `"URGENT"`
(`core/conditions/rules.ts`'s `CreateTaskActionParams`) was updated.

Selection (`selectCandidateTasks`): priority first (`PRIORITY_ORDER`), then
creation time (FIFO). A future `dueAt` is excluded by eligibility, not by
the query, so it still occupies a candidate slot in order but is skipped
without a status change other than WAITING. `RETRYING` tasks are interleaved
normally - their own backoff window is enforced by eligibility, not by
exclusion here, so **one repeatedly-failing task cannot starve the queue**:
each tick advances past it (still WAITING on backoff) to the next eligible
candidate.

## 4. Heartbeat (`core/worker/heartbeat.ts`, `WorkerHeartbeat` table)

One row per `workerId`: `startedAt`, `lastHeartbeat`, `currentTaskId`,
`status` (`RUNNING|IDLE|DEGRADED|STOPPED|CRASHED`), `processedTasks`,
`failedTasks`, `restartCount`. Refreshed every 1s (heartbeat timer) -
shorter than the 2s task tick, so a hung tick loop is detected faster than
one missed task cycle. Exposed as an 11th `GET /system/health` component
(`core/health/index.ts`'s `checkWorker()`) alongside the existing ten -
`UNKNOWN` if the worker never started in this process (e.g. a test that
never boots `apps/api/src/index.ts`), `FAILED` if the heartbeat is stale or
the worker is `CRASHED`, never a fabricated `HEALTHY`.

## 5. Watchdog (`core/worker/watchdog.ts`)

`runWatchdogChecks()` detects: **heartbeat timeout** (no update within
`heartbeatTimeoutMs`, default 30s), **repeated failures** (>50% of the last
≥5 processed tasks failed), **task starvation** (`starvationFinding()` -
eligible-looking tasks exist but the tick counter shows zero progress for
`starvationTicks` ticks), **queue growth** (>200 pending/queued/retrying
top-level tasks), and **excessive retries** (any task `RETRYING` with
`retryCount >= 2`, i.e. near a typical retry limit of 3).

**Restart with backoff + hard cap**: `decideRestart()` tracks restart
attempts per `workerId` in a bounded, filtered-by-window in-memory history.
Exponential backoff (`restartBackoffBaseMs * 2^attempts`) between attempts;
a hard cap (`maxRestartAttempts`, default 5) within `restartWindowMs`
(default 10 minutes) - once hit, `giveUp: true` is returned exactly once and
`giveUpPermanently()` marks the heartbeat `CRASHED`, writes a `CRITICAL`
notification, and an audit log entry (`worker.watchdog_gave_up`) - **never**
an infinite restart loop. `Worker.watchdogPass()` is driven by a **separate**
15s interval in `apps/api/src/index.ts` (a dead tick timer cannot watch
itself). Tested explicitly in `core/worker/watchdog.test.ts`.

## 6. Crash Recovery (`core/tasks/index.ts`, `core/worker/claim.ts`)

`recoverUnfinishedTasks()` (boot-time, Phase 2) now also clears any stale
worker claim (`claimedBy`/`claimedAt`/`claimExpiresAt`) on a recovered task -
a task `IN_PROGRESS` at boot may have been claimed by a now-dead worker slot,
not just left running by the old orchestrator path this function originally
covered.

`reclaimExpiredTasks()` (`core/worker/claim.ts`) runs the equivalent check
**every tick** while the process is alive (a claim can expire without the
whole process dying - one slot hanging is enough): any task `IN_PROGRESS`
with `claimedBy` set and `claimExpiresAt` in the past is moved to `RETRYING`
(if retries remain) or `FAILED`, via the same `retryOrFailTask()` used
everywhere else, with an honest `failureReason` naming the dead claim. The
exact scenario the spec describes - **task started → simulated process
termination (stale IN_PROGRESS + expired claim) → simulated restart (a fresh
call to the recovery function) → task moved to RETRYING → the claim cleared
so it becomes reclaimable → a second claim attempt on the SAME task fails
while its first claim is still valid, succeeds once expired** - is the exact
test in `core/worker/claim.test.ts`'s `"#6 crash recovery"` case.

## 7. Concurrency & Task Claiming (`core/worker/claim.ts`)

**Honesty about `MAX_WORKERS`**: this configures concurrent task-processing
*slots* inside the ONE Node process running the worker - not multiple OS
processes. There is no process-orchestration layer in this stack. In
principle, if two API processes shared the same SQLite file, the claiming
mechanism below would still prevent double execution between them (it is a
database-level guarantee, not an in-memory one) - but that configuration is
not part of, or tested as, this deployment.

**DB-backed claiming**: `claimTask(taskId, workerId, claimTimeoutMs)` is one
`prisma.task.updateMany({ where: { id, status: {in:[...]}, OR: [claimedBy
null, claimExpiresAt < now] }, data: { status: IN_PROGRESS, claimedBy,
claimedAt, claimExpiresAt } })`. Success/failure is read from `updateMany`'s
returned `count` - the database write succeeding or failing IS the lock, not
an in-memory mutex. `core/worker/claim.test.ts` fires two concurrent
`claimTask()` calls at the same row and asserts exactly one succeeds.
`releaseClaim()` is guarded by `claimedBy = workerId` so a worker can never
clear another worker's claim. The claim expires (`claimExpiresAt`) so a
crashed worker's abandoned claim becomes reclaimable via
`reclaimExpiredTasks()` (§6).

## 8. Autonomous Daily Cycle (`scheduler/index.ts`, `core/conditions/rules.ts`)

Two scheduled jobs, config-driven via the existing `Automation` table (never
hardcoded), following the exact Phase 3 pattern (cron callback publishes
`SCHEDULE.fired`; a seeded `ConditionRule` reacts and creates a task):

- `morning-briefing` (07:00 UTC) - **unchanged from Phase 3**, not moved to
  05:00. The spec suggested 05:00; this phase deliberately left the existing,
  already-tested job alone rather than risk destabilizing it, and instead
  added the new evening job below. Documented here as an explicit choice.
- `daily-report` (21:00 UTC, new) - the seeded `daily-report` `ConditionRule`
  creates a task titled "Generate daily executive report" **tagged
  `toolName: "reports"`**, so the worker executes it directly through the
  guarded tool registry (no Brain/LLM round trip needed for a deterministic,
  always-the-same aggregation).

During the day, the worker loop itself IS the "monitor eligible tasks /
execute queued business tasks / process notifications / retry recoverable
failures" behavior - no third distinct job was needed for that.

## 9. Owner Interruptions (`apps/api/src/routes/tasks.ts`)

A WAITING/BLOCKED task never blocks other eligible tasks - the worker
selects the next eligible candidate each tick, and WAITING/BLOCKED tasks are
excluded from the main candidate query entirely (§2/§3). Proven end-to-end in
`core/worker/worker.test.ts`'s `"#9 owner interruption"` test.

**Resume mechanism**: `POST /tasks/:id/resume` (OWNER-authenticated) - takes
optional `{info}`, publishes a real `USER.task_resumed` event (a genuine,
already-implemented event category per `core/events/schemas.ts`, so this is
a real event source, not a stub), and moves the task from
WAITING/BLOCKED back to `PENDING` (clearing its reason). The worker picks it
up on the next tick like any other eligible task. Tested in
`apps/api/tests/worker.test.ts`.

## 10. Autonomous Task Creation (`core/worker/spawn.ts`, `agents/task-agent.ts`)

`spawnChildTask({parentId, title, description?, priority?})` reuses
`core/planner.planTask()` (never a second task-creation path), setting the
new task's `parentId` to the originating task. Hard-enforced limits (never
just documented):

- **max child tasks per parent** (default 5, configurable via `worker.config`)
- **max recursion depth** (default 3) - computed by walking `parentId` links
- **max total tasks per tree** (default 20) - a bounded BFS from the tree root
- **duplicate detection** - case/whitespace-insensitive exact title match
  against every task already in the same tree (no embeddings needed for this
  scope, as the spec allows)

Any violation **rejects** the creation (returns `{created: false, reason}`)
- it never silently truncates or crashes - and both logs a `WARNING`, raises
a real `WARNING` `Notification`, and writes an `AuditLog` entry
(`worker.spawn_rejected`). Each limit has its own explicit test in
`core/worker/spawn.test.ts`.

**Brain wiring**: rather than modifying `core/brain`'s execution loop
directly (higher risk, out of scope for "don't rebuild"), `agents/task-agent.ts`
gained a `create_child` action that calls `spawnChildTask()`. The Brain
triggers it exactly like any other agent delegation - a plan step naming
`agent: "task"`, `arguments: {action: "create_child", parentId, title}` -
through the same enforcement-gated `agent.run()` path as every other agent
call. `agents/task-agent.test.ts` covers both the success and rejected paths.

## 11. Daily Executive Report (`core/reports/dailyReport.ts`)

`generateDailyReport(date)` queries, for that UTC day, ONLY real data:
`Task` rows by status (`DONE`/`FAILED`/`WAITING`/`BLOCKED`, each with its
real persisted reason: `failureReason`/`waitingReason`/`blockedReason`),
`WorkerHeartbeat` rows (uptime, processed/failed counts, restart count),
`SystemLog` error/critical counts, `AiUsage` cost/token totals
(`core/ai/usage.summarizeUsageSince`), and `Lead` counts for a minimal
business section. **A business metric with no real data source is reported
as `"no data"` (a literal string, typed as such), never a fabricated
number** - see the `newLeadsToday`/`totalOpenLeads` fields' `.catch()`
fallback. `generateAndSaveDailyReport()` persists to the new `DailyReport`
table (`reportDate` unique, upserted - idempotent, one row per day).

**Wiring to the daily cycle**: the 21:00 `daily-report` job's
`ConditionRule`-created task is tagged `toolName: "reports"`
(`tools/reports.ts`), which calls `generateAndSaveDailyReport()` directly -
so the report is a genuine result of that task executing through the normal
worker → tool-registry → enforcement path, not a bypass.
`GET /worker/report/latest` (§12) reads it back.

## 12. Observability (`apps/api/src/routes/worker.ts`)

Three new authenticated routes (new `AuthzAction`s `worker.read`,
`worker.write`, `report.read` in `core/authz`, granted to OWNER/SYSTEM,
matching the existing `brain.read` pattern):

- `GET /worker/status` - current heartbeat + live queue size.
- `GET /worker/report/latest` - the latest Daily Executive Report (or `null`).
- `GET /worker/actions` - the worker's own recent `AuditLog` entries
  (filtered by its `WORKER_IDENTITY` actor label), redacted at write time -
  never raw secrets.

## 13. Event Sources (`core/events/sources.ts`) - foundation only

Real TypeScript interfaces (`CRMEventSource`, `EmailEventSource`,
`WebEventSource`, `MarketEventSource`, `VoiceEventSource`,
`CalendarEventSource`, each a `start()`/`stop()`/`isRunning()` shape) plus an
explicit `NotImplemented*EventSource` stub class for each - `start()` never
actually starts anything, `isRunning()` always reports `false`, matching the
honesty pattern of `tools/browser.ts`/`tools/voice.ts`. **Real** publish
paths in this phase: `SYSTEM`/`SCHEDULE` (unchanged, Phase 2/3),
`TASK.worker_outcome` (now published by the worker every task completion),
and `USER.task_resumed` (the owner-resume route, §9). CRM/EMAIL/WEB/MARKET/
VOICE/CALENDAR remain entirely unimplemented - no webhook receiver, poller,
or crawler was built for any of them.

## 14. Autonomous Loop Safety

The worker calls `toolRegistry.execute()` / `agent.run()` / `brain.handle()`
- there is no "autonomous" flag or parallel path that skips
`core/enforcement`/`core/authz`. `core/worker/worker.test.ts`'s two
`"NO-BYPASS"` tests mirror Phase 2's enforcement proof exactly: a disabled
tool and a policy-BLOCKED action title are both refused, ending in `BLOCKED`
with a persisted reason, never executed.

## 15. Loop Protection

- **Infinite/repeated task loops**: `spawnChildTask()`'s duplicate detection
  (§10) applies to any follow-up creation, not just the Brain path.
- **Recursive task creation**: depth/count/tree-size limits (§10), enforced
  in code, tested individually.
- **Retry storms**: the worker never adds a second retry mechanism - every
  failure path (`processClaimedTask`, `reclaimExpiredTasks`) calls the SAME
  `core/planner.retryOrFailTask()` that already respects `core/limits`'
  `retryLimit`.
- **Duplicate execution**: solved by DB-backed claiming (§7), not luck.
- **Runaway AI spending**: the worker's only LLM path is `brain.handle()`,
  which already calls `checkCostLimit()` before every model call - the
  worker adds no second LLM call path.
- **Worker restart storms**: the watchdog's backoff + hard cap (§5).
- **Every automatic stop produces both an audit log entry AND a
  notification**: proven for the watchdog's give-up path
  (`core/worker/watchdog.test.ts`) and for spawn rejection
  (`core/worker/spawn.test.ts`).

## 16. Database changes

Migration `20260928090000_phase5_autonomous_worker`: `Task` gained
`waitingReason`, `blockedReason`, `failureReason`, `claimedBy`, `claimedAt`,
`claimExpiresAt`, `lastEligibilityCheckAt` (all nullable); existing
`"URGENT"` priority values are rewritten to `"CRITICAL"`. New tables:
`WorkerHeartbeat`, `DailyReport`.

## 17. Known limitations (honest accounting)

- The worker is a single in-process loop; "MAX_WORKERS" means concurrent
  slots in one process, not OS-level parallelism (§1, §7).
- A generic (untagged) task delegated to the Brain can flip WAITING/PENDING
  on the backoff cycle if the underlying issue (e.g. no AI provider
  configured) isn't itself detectable by the cheap eligibility pre-filter
  (§2).
- The "trigger task" vs. "Brain's own task tree" split (§1) means a
  generic delegated task's original row shows only a terminal status, not
  the Brain's own step-by-step subtasks - those are visible via
  `GET /brain/tasks` separately, not nested under the trigger task.
- The watchdog's "task starvation" and "queue growth" checks use fixed
  thresholds, not adaptive/statistical ones - deliberately simple, matching
  this phase's stated scope.
- Real event sources for CRM/EMAIL/WEB/MARKET/VOICE/CALENDAR remain entirely
  unbuilt (§13) - unchanged scope from Phases 1-4.

## 18. Recommended next phase

Real event sources for the still-reserved categories (a genuine CRM webhook
receiver would be the highest-leverage one, since the `crm-new-hot-lead-research`
condition rule already exists and is only ever exercised by manual/test
publishes today); a tighter Brain-to-existing-task integration (so a
worker-delegated generic task's own row reflects the Brain's real step-by-step
progress instead of a single terminal status); and a real cron-expression
parser for the scheduler's missed-schedule detection (carried over from
Phase 3, still not addressed).
