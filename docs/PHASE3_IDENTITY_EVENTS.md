# Phase 3 — Identity & Events

This document covers what was added on top of Phase 2's Autonomy Core: real
authentication and a channel-agnostic Identity abstraction, a coarse Owner
Command Authority layer separate from the Autonomy Policy Engine, a real
Notification Service, typed/validated events with routing, a declarative
(never-executable) Condition Engine, an upgraded event-publishing scheduler,
and a System Health subsystem.

## 1. The full request chain

```
AUTHENTICATION -> IDENTITY -> AUTHORIZATION -> AUTONOMY POLICY -> RATE/CONCURRENCY -> EXECUTION -> AUDIT
     |                |              |                |                  |               |          |
 core/auth/      core/auth/     core/authz      core/policy         core/limits     tool.execute/  security/audit
 session.ts      identity.ts   (coarse, role-   (BLOCKED/NOTIFY/    (inside         agent.run       writeAuditLog
 (bearer token   (Identity =    based: "can      AUTONOMOUS,         core/enforce-   (the real      (actor is now
 -> validate     {kind,id,      this identity    unchanged from      ment's gate)    work)          identityToActor
 Session)        label})        request this     Phase 2)                                          String(identity),
                                 kind of action                                                       never a raw
                                 at all?")                                                             client string)
```

- HTTP middleware (`apps/api/src/middleware/auth.ts`) does AUTHENTICATION +
  IDENTITY: `requireAuth` validates the bearer token via
  `core/auth/session.validateSession()` and attaches `req.identity`.
- `requireAuthz(action)` / `requireRole(...)` run AUTHORIZATION
  (`core/authz`) before the route handler ever calls a tool/agent.
- The route handler calls `toolRegistry.execute(name, input, identity)` or
  `agent.run(input, identity)`. Those are the same `execute`/`run` methods
  `core/enforcement` already wraps in place (Phase 2) - AUTONOMY POLICY,
  RATE/CONCURRENCY, EXECUTION, and AUDIT are unchanged in mechanism, but the
  audit `actor` is now `identityToActorString(identity ?? SYSTEM_IDENTITY)`
  instead of the hardcoded string `"system"`.
- Event routing and the condition engine sit alongside this chain, not
  inside it: `core/events.publish()` persists + notifies subscribers +
  (for typed events) runs `core/conditions` rules, independently of any HTTP
  request. A ConditionRule match calls `core/planner.planTask()` directly.

## 2. Authentication (`core/auth`)

- **Hashing**: real `bcrypt` (native, confirmed working in this sandbox; no
  need for the `bcryptjs` fallback), 12 salt rounds (`core/auth/password.ts`).
- **Sessions**: server-side, DB-backed (`Session` Prisma model: id, userId,
  tokenHash, createdAt, expiresAt, revokedAt, lastUsedAt). The raw token is a
  32-byte `crypto.randomBytes` hex string, returned to the caller **once**
  at login; only its SHA-256 hash is stored (`tokenHash`), so a leaked DB row
  alone can never be replayed. SHA-256 (not bcrypt) is used for the token
  hash deliberately - lookups need a fast, deterministic digest, and the
  token already carries 256 bits of entropy, unlike a human password.
  Default TTL 7 days (`SESSION_TTL_HOURS` env var).
- **Transport**: `Authorization: Bearer <token>` header, not a cookie -
  chosen because it works identically for a browser, a CLI, or a future
  desktop/voice client without cookie-jar concerns.
- **Logout**: `POST /auth/logout` calls `revokeSession()`, which sets
  `revokedAt` - `validateSession()` checks this on every call, so logout
  takes effect immediately (no cache to invalidate; every check hits the DB).
- **Login**: `POST /auth/login` always runs a bcrypt comparison (against a
  fixed dummy hash for an unknown email) so the response time and shape are
  identical for "no such user" and "wrong password" - both return a generic
  401 `{"error":"Invalid credentials."}`. Rate-limited per `email:ip` via a
  new `core/limits.checkLoginRate()` (same in-process rolling-window pattern
  as the existing tool/agent limiters).
- **Owner creation**: `npm run seed:owner` (`scripts/seed-owner.ts`) reads
  `OWNER_EMAIL`/`OWNER_PASSWORD` from env, hashes the password, and creates
  the one `User` row with `role: "OWNER"`. It refuses to run (no changes) if
  an OWNER already exists - **no HTTP endpoint can create or self-elevate to
  OWNER**, only this explicit, operator-run script.

## 3. Identity (`core/auth/identity.ts`)

```ts
type IdentityKind = "OWNER" | "SYSTEM" | "AGENT" | "SERVICE";
interface Identity { kind: IdentityKind; id: string; label: string; }
```

Channel-agnostic by construction: nothing assumes HTTP. A `Session` created
by a future voice or desktop client would call the exact same
`createSession`/`validateSession` functions. A voice-biometric-verified
identity is a natural future `kind` extension - **not implemented here**,
just not designed against.

- `SYSTEM_IDENTITY` - a fixed constant for JARVIS's own internal/scheduled
  actions (the scheduler, default event subscribers). Replaces the old
  hardcoded `actor: "system"` string.
- `agentIdentity(name)` / `serviceIdentity(name)` - fixed, code-defined
  identities for future agent-to-agent / service-to-service calls. **Not**
  mintable via any HTTP endpoint - only constructible in code.
- `ownerIdentity(userId, email)` - built only from a real, validated `User`
  row inside `validateSession()`; never constructed from client input.

## 4. Authorization (`core/authz`) vs. Autonomy Policy (`core/policy`)

Deliberately separate modules answering different questions:

| | `core/authz` | `core/policy` |
|---|---|---|
| Question | "Is this **identity** allowed to **request** this kind of action at all?" | "Given the action's **content**, should it run autonomously, notify, or be blocked?" |
| Granularity | Coarse, role-based (`OWNER`/`SYSTEM`/`AGENT`/`SERVICE` -> a fixed action set) | Fine, per-action (`BLOCKED_KEYWORDS`, decision-engine classification) |
| Runs | In HTTP middleware, before the enforcement gate | Inside `core/enforcement`'s gate (unchanged from Phase 2) |
| Can it unblock a hardcoded BLOCKED action? | No - it never sees policy at all | No - `BLOCKED_KEYWORDS` is non-configurable |

`OWNER` is authorized for every `AuthzAction` (including
`system.emergency_stop`), but that authorization **never** bypasses a
`BLOCKED` policy outcome - the `security.test.ts` suite proves this by
registering a tool named `financial.transaction` (a `BLOCKED_KEYWORDS`
match) and confirming an authenticated, fully-authorized OWNER still gets
`status: "BLOCKED"`.

`SYSTEM`/`AGENT`/`SERVICE` have narrower, fixed action sets in
`core/authz`'s `ROLE_ACTIONS` table and currently have **no HTTP login
flow** - they're only ever used as internal, code-constructed identities
(e.g. passed to `guardToolExecution`'s wrapped function from a future
internal caller). Every route in `apps/api` currently authenticates only
`OWNER` sessions (since `Session` rows only ever resolve to an
`ownerIdentity`), so the SYSTEM/AGENT/SERVICE branches of `core/authz` are
exercised today only by its own unit tests and by `core/enforcement`'s
default `SYSTEM_IDENTITY` fallback - genuine, forward-looking plumbing, not
yet reachable from an HTTP request.

## 5. Route authentication summary

| Route | Auth |
|---|---|
| `GET /health` | none |
| `POST /auth/login` | none (rate-limited) |
| `POST /auth/logout`, `GET /auth/me` | any valid session |
| `POST /chat` | OWNER only (`chat.use` is OWNER-only in `core/authz`) |
| `GET /tools`, `GET /agents` | any valid session |
| `POST /tools/:name/execute`, `POST /agents/:name/run` | valid session + `tool.execute`/`agent.run` authz |
| `GET/POST /tasks`, `GET/POST /memory` | valid session + `task.*`/`memory.*` authz |
| `GET /system/state`, `GET /system/health`, `GET /system/agents/:name/paused`, `GET /system/tools/:name/disabled` | any valid session |
| All `/system/*` mutation routes (pause/resume/emergency-stop, agent pause/resume, tool disable/enable, scheduler enable/disable) | OWNER only |
| `GET /notifications`, `PATCH /notifications/:id/read` | valid session + `notification.*` authz |

## 6. Notification system (`core/notifications`)

Repository -> Service -> Dispatcher split:

- `NotificationRepository` - Prisma CRUD on `Notification` (now with a
  `type: INFO | WARNING | ACTION_REQUIRED | ERROR | CRITICAL` column).
- `NotificationService` - `create`/`markRead`/`list` business logic; calls
  the dispatcher after every create.
- `NotificationDispatcher` - pluggable `NotificationChannel[]`. **Exactly
  one real channel**: `DashboardChannel` (persists via the repository so the
  web dashboard can poll `GET /notifications`). `DesktopChannel`,
  `EmailChannel`, `WhatsAppChannel`, `SmsChannel`, `PhoneChannel`,
  `PushChannel` are honest `NOT_IMPLEMENTED` stubs - they log a warning and
  return `{status: "NOT_IMPLEMENTED"}`, never fake delivery.
- `core/enforcement`'s old ad-hoc `createNotification()` helper now calls
  `notificationService.create({..., type: "ACTION_REQUIRED"})` instead of
  writing to Prisma directly.

## 7. Event architecture (`core/events`)

- **Categories** (`core/events/schemas.ts`): `SYSTEM | SCHEDULE | USER |
  TASK | AGENT | CRM | NOTIFICATION` are implemented with a minimal payload
  shape check each. `EMAIL | WEB | MARKET | VOICE | CALENDAR` are reserved
  category names (valid strings, forward-compatible) with **no event
  source built** - publishing one of these is rejected as "reserved."
- **Validation**: a typed event's `type` follows `CATEGORY.rest.of.name`
  (e.g. `SCHEDULE.fired`, `CRM.lead.created`). `publish()` validates any
  event whose type prefix is ALL-CAPS against `core/events/schemas.ts` and
  **throws**, rejecting the publish, on an unknown category or a payload
  that fails its shape check. Legacy, lowercase-prefixed event types
  (`scheduler.fired`, `task.created`, ad hoc test event names) pass through
  unvalidated for backward compatibility with Phase 1/2 code - documented
  explicitly in `core/events/index.ts`.
- **Routing**: after persisting and notifying `subscribe()`-registered
  handlers (Phase 2's mechanism, unchanged), `publish()` additionally runs
  every enabled `ConditionRule` whose `eventType` matches, via
  `core/conditions/rules.runConditionRulesForEvent()` - a registry mapping
  event type to the condition engine, not each subscriber hardcoding what it
  listens for.

## 8. Condition Engine (`core/conditions`)

**Hard security requirement, verified by tests**: conditions are DATA, never
code. `evaluateCondition()` walks a plain JSON tree
(`all`/`any`/`not`/`{field, op, value}`) with literal property lookups -
**no `eval`, no `new Function`, no dynamic code execution anywhere in this
module.** `getField()` explicitly refuses to traverse `__proto__` /
`prototype` / `constructor` segments, blocking prototype-pollution-style
payloads. Operators: `eq, neq, gt, gte, lt, lte, in, contains`. Any
malformed node or unknown operator **fails closed** (returns `false`,
logs a `WARNING`) rather than throwing uncaught or defaulting to `true`.

Rules are stored as data in a new `ConditionRule` table (chosen over
extending `Automation`, since `Automation` is specifically cron/time-driven
and a `ConditionRule` reacts to *events*): `eventType`, `conditionJson`,
`actionType` (only `"create_task"` is implemented), `actionParams`.
`core/conditions/rules.seedExampleConditionRules()` seeds, as data, the two
required examples:

1. `crm-new-hot-lead-research` - `CRM.lead.created` with
   `payload.status == "NEW" && payload.score > 50` -> creates a "Research
   new hot lead" task via `core/planner.planTask()`.
2. `morning-briefing` - `SCHEDULE.fired` with
   `payload.jobName == "morning-briefing"` -> creates a "Prepare morning
   briefing" task (task creation only - no briefing content generation).

## 9. Scheduler upgrade (`scheduler/index.ts`)

- Cron job handlers now publish a typed `SCHEDULE.fired` event (via
  `core/events.publish`) **before** doing anything else; the previous
  direct business logic (heartbeat log, stale-lead count) moved into a
  `SCHEDULE.fired` subscriber keyed on `payload.jobName` -
  `registerExampleJobs()` documents this. The legacy `scheduler.fired`
  event is still published too, for backward compatibility with Phase 2's
  `registerDefaultSubscribers()` proof-of-pipe.
- **Execution history**: a new `AutomationRun` table (chosen over overloading
  `Automation.lastRunAt`) records `status` (RUNNING/SUCCESS/FAILED),
  `startedAt`/`endedAt`, `error`, `attempt` per fire.
- **Duplicate-execution prevention**: an in-process `runningJobs` Set skips
  a re-entrant fire while a previous invocation of the same job name is
  still running (proven in `scheduler.test.ts` by calling the private
  `fireJob` twice concurrently).
- **Retry**: bounded by `core/limits`' `retryLimit`; a failing handler is
  retried up to that many attempts before the run is marked FAILED and
  audited (`writeAuditLog`, actor = `SYSTEM_IDENTITY`).
- **Timezone**: `JobDefinition.timezone` (default `"UTC"`), passed to
  `node-cron`'s `schedule(..., { timezone })` and persisted on `Automation`.
- **Missed-schedule detection**: best-effort only (explicitly not a real
  cron-expression parser) - at registration time, if a job's `lastRunAt` is
  older than a rough expected-cadence hint for its trigger type, a
  `WARNING` is logged. **No catch-up execution is performed.**
- **Enable/disable**: `Scheduler.setEnabled(name, enabled)` re-registers a
  job from its stored `JobDefinition`, live, without a restart; new
  `POST /system/scheduler/:name/enable|disable` routes (OWNER only).
  Restart recovery: `register()` now honors the **persisted** `enabled`
  value when the caller doesn't explicitly pass one, so a job disabled
  before a crash stays disabled after the process restarts and
  `registerExampleJobs()` runs again (proven in `scheduler.test.ts`).

## 10. Health monitoring (`core/health`)

`GET /system/health` (any authenticated identity - see reasoning below)
aggregates ten checks, each returning `HEALTHY | DEGRADED | FAILED |
UNKNOWN` with a short, non-sensitive reason (no stack traces, no env
values): api (trivially self), database (`SELECT 1` with a 2s timeout),
scheduler (are the three expected cron jobs running), event bus
(publish+subscribe round-trip on a synthetic `SYSTEM.health_check` event),
task queue (count of IN_PROGRESS/RETRYING tasks vs. a threshold), agents
(any `AgentRun` RUNNING for over 30 minutes), tool registry (any tools
registered), memory (`Memory.search` round-trip), disk (`fs.statfs` on the
sandbox dir - reports `UNKNOWN`, not a fabricated number, if unsupported in
this sandbox), and resources (`os.loadavg()` / `process.memoryUsage()` -
real numbers). Overall status: FAILED if any FAILED, else DEGRADED if any
DEGRADED, else HEALTHY. **Auth decision**: requires authentication (not
public) because task/agent counts and scheduler state are business-
sensitive for this system, even though a health check is often public
elsewhere.

## 11. Known limitations (honest accounting)

- **SYSTEM/AGENT/SERVICE identities have no HTTP login flow** - they exist
  only as code-constructed constants (`SYSTEM_IDENTITY`, `agentIdentity()`,
  `serviceIdentity()`) for future internal callers (e.g. agent-to-agent tool
  calls). Every current HTTP session resolves to `OWNER`. `core/authz`'s
  handling of the other three kinds is tested at the unit level only.
- **`core/authz`'s `ROLE_ACTIONS` table is coarse** - it does not yet grant
  an AGENT identity access to only *specific* tools (e.g. "agent X may call
  tool Y but not Z"); that per-tool/per-agent grant matrix is future work.
- **The disk-usage health check depends on `fs.statfs` support**, which is
  present on this sandbox's Node/Linux combination (verified with a real
  read), but the code still reports `UNKNOWN` rather than fabricating a
  number on a platform where it's unavailable.
- **The missed-schedule check is a rough heuris tic, not a cron parser** -
  it uses fixed expected-cadence hints per trigger type, not the actual
  cron expression; no catch-up execution is performed either way.
- **Session revocation has no caching layer to worry about** -
  `validateSession()` reads `Session.revokedAt` from the DB on every call,
  so logout/revocation is immediate (no propagation delay), at the cost of
  one DB round-trip per authenticated request (same tradeoff Phase 2 already
  made for system-state/limit checks).
- **The seed script is safe to re-run**: it checks for an existing `OWNER`
  row first and makes zero writes if one exists (verified against a fresh
  DB and a re-run in this phase's own testing).
- **Rate limiting (including the new login limiter) remains in-process, not
  distributed** - unchanged limitation from Phase 2, now also covering
  login attempts.
- **The condition engine's `actionType` support is limited to
  `"create_task"`** - no other action kinds (e.g. "send notification",
  "run agent") are implemented yet, though the schema (`actionType` +
  `actionParams` as JSON) supports adding them without a migration.

## 12. Recommended next phase

1. A real per-tool/per-agent grant matrix in `core/authz` for AGENT/SERVICE
   identities, plus an actual internal-service login/credential mechanism
   (today they're code-only constants).
2. Real event *sources* for the reserved categories (CRM changes, inbound
   email, calendar) - today only the scheduler and manual/test publishes
   produce typed events.
3. A proper cron-expression parser (e.g. `cron-parser`) for accurate missed-
   schedule detection and, if desired, bounded catch-up execution.
4. Expand `core/conditions`' `actionType` set beyond `create_task` (e.g.
   `send_notification`, `run_agent`) now that the rule/action plumbing
   exists.
5. A refresh-token or shorter-lived-access-token pattern if session UX needs
   improving beyond the current single long-lived opaque token.
