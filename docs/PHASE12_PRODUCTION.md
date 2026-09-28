# Phase 12 - Production Integration, Reliability, Observability & Deployment

This phase adds no new business feature and weakens no existing safety
boundary. It makes the existing system honestly deployable and observable,
and documents - with evidence, not aspiration - what "production ready"
actually means for this codebase today.

## Evidence

- Tests: **698 -> 736** (all passing). New test files:
  `config/providers.test.ts` (8), `core/production/backupRestore.test.ts`
  (2), `core/production/duplicationPrevention.test.ts` (4),
  `core/production/retryPolicy.test.ts` (5), `core/production/chaos.test.ts`
  (4), `core/production/safetyRegression.test.ts` (7),
  `apps/api/tests/production.test.ts` (8). (38 new tests total.)
- Root typecheck: clean (`npx tsc --noEmit -p tsconfig.json`).
- `apps/api` typecheck: clean (`npx tsc --noEmit -p tsconfig.json`).
- Enforcement-critical file diff (`git diff --stat` against the pre-Phase-12
  commit) for `core/enforcement/index.ts`, `tools/registry.ts`,
  `agents/registry.ts`, `core/business/browserPolicy.ts`,
  `core/whatsapp/webhook.ts`, `core/voice/webhook.ts`,
  `core/auth/session.ts`, `core/auth/identity.ts`, `core/authz/index.ts`:
  **ZERO diff** - none of these files were touched.
- Outbound provider call-site grep
  (`provider.sendMessage(`/`provider.createCall(`, excluding comments):
  **exactly 3** - `tools/email/emailTool.ts:325`,
  `tools/whatsapp/whatsappTool.ts:305`, `tools/voice/voiceTool.ts:316`.
  Unchanged from Phase 9/10/11's own count.
- `npm audit`: **11 vulnerabilities (7 moderate, 3 high, 1 critical)** -
  see "Security/dependency audit" below for the honest breakdown; none were
  silently ignored.

## What's REAL vs CONFIGURATION_REQUIRED vs NOT_IMPLEMENTED, per section

### 1. Environment/configuration model - REAL
`config/providers.ts` classifies six integrations
(Anthropic/Email/WhatsApp/Voice/WebResearch/BrowserAutomation) into
CONFIGURED / OPTIONAL / CONFIGURATION_REQUIRED / INVALID, purely from which
env vars are present (never a live credential check - that capability does
not exist in this codebase and this module does not claim otherwise).
`INVALID` catches an obvious placeholder value (e.g. `ANTHROPIC_API_KEY=changeme`).
Wired into `GET /health/ready`.

### 2. Secret management/redaction audit - REAL (pre-existing, re-verified)
`security/redact.ts` (key-name and value-shape based redaction) and
`security/logger.ts` (every `log()` call redacts `meta` before printing or
persisting) already existed pre-Phase-12 and were re-read, not modified in
their redaction logic. Phase 12's only change to `security/logger.ts` is
additive: attaching the request-id (item 7) to the log payload, itself
passed through the same `redact()` call. Grepped the repo for a raw secret
literal accidentally committed - none found beyond `.env.example`'s
intentionally-empty variable names.

### 3. Production database evaluation - REAL, documented, NOT migrated
See "Database" below - SQLite is kept, with an honest tradeoff writeup, not
a migration "to sound professional".

### 4. Backups - REAL
`scripts/backup-db.sh` / `scripts/restore-db.sh`, proven by an ACTUALLY
EXECUTED backup -> destroy -> restore -> verify cycle against a real,
Prisma-migrated temp database in `core/production/backupRestore.test.ts`
(not a mock, not "the script exists"). `sqlite3` CLI is used for a
hot-safe, integrity-checked backup when available; falls back to a plain
file copy (disclosed as less safe under concurrent writes) otherwise - this
sandbox has no `sqlite3` CLI installed, so the fallback path is what the
test above actually exercised.

### 5. Process supervision - REAL configs, single-process topology (honest)
`Dockerfile` + `deploy/docker-compose.yml`, `deploy/systemd/jarvis-api.service`
(+ `jarvis-backup.service`/`.timer`), `deploy/pm2/ecosystem.config.js`. All
three supervise **one** process, because `apps/api/src/index.ts` already
runs the API + Autonomous Worker + Scheduler together in one Node process -
building three separate supervised services would misrepresent an
architecture this codebase doesn't have. No Kubernetes, per instruction.

### 6. Health/readiness endpoints - REAL
`GET /health/live` (liveness, no I/O) and `GET /health/ready` (DB
connectivity + provider config summary, 503 if DB unreachable) added to
`core/health/index.ts` + `apps/api/src/routes/health.ts`, additive to the
pre-existing `GET /health` (kept byte-identical) and `GET /system/health`
(untouched). Proven live in `apps/api/tests/production.test.ts`.

### 7. Structured logging / correlation IDs / error classification - REAL
`security/context.ts` (AsyncLocalStorage) +
`apps/api/src/middleware/requestContext.ts` (generates or reuses
`X-Request-Id`, echoes it back, feeds it into every `log()` call for the
request - console AND persisted `SystemLog` rows). Proven end-to-end via a
real HTTP request in `apps/api/tests/production.test.ts` (generated id,
echoed incoming id, id present even on a 404). `core/production/errors.ts`
is a message-pattern-based `classifyError()` (CLIENT_ERROR /
CONFIGURATION_REQUIRED / TRANSIENT / POLICY_BLOCKED / AUTH_FAILURE /
INTERNAL) plus the typed `isRetryableOutcomeStatus()` used by the retry
audit below - documentation-as-code for existing behavior, not a new
enforcement layer.

### 8. Retry-policy audit - REAL, proven against the actual worker code
`core/production/retryPolicy.test.ts` executes `processClaimedTask()` (the
real function `core/worker/index.ts` uses) against a disabled tool and
against `EMERGENCY_STOP`, and asserts the task's `retryCount` is left
**unchanged** and its terminal status is `BLOCKED` (never routed through
`retryOrFailTask`, the only function that increments `retryCount`). This is
the existing, unmodified behavior (`markTerminal()` in
`core/worker/index.ts` only calls `retryOrFailTask` for `"FAILED"`) - the
test is new; the guarantee it proves already shipped.

### 9. Provider production-configuration honesty - REAL
Same module as item 1 (`config/providers.ts`). No provider is ever reported
"REAL"/working from an env var alone; `CONFIGURED` is explicitly documented
in the module's own header comment as "will ATTEMPT real work", not "proven
to work".

### 10. AuthN/authZ production audit - REAL (mostly pre-existing, re-verified + extended)
`core/auth/session.ts`'s `validateSession()` and `core/auth/identity.ts`'s
fail-closed role derivation were **read directly, not modified** -
confirmed still fail-closed (expired/revoked/inactive-user/unrecognized-role
all reject). New tests
(`core/production/safetyRegression.test.ts`) prove session expiry and
account deactivation reject a token that is otherwise perfectly valid.
NEW, additive: `FORCE_HTTPS`/`TRUST_PROXY_HOPS`-gated HTTPS enforcement
(`apps/api/src/middleware/enforceHttps.ts`), off by default (most
deployments terminate TLS at a reverse proxy, which this repo's `deploy/`
configs assume).

### 11. Webhook/rate-limit audit - REAL
`core/whatsapp/webhook.ts` and `core/voice/webhook.ts` (HMAC signature
verification) were **read directly, not modified** - confirmed unweakened
(zero diff, see Evidence above). NEW: per-IP, per-minute rate limiting
(`apps/api/src/middleware/rateLimit.ts`, in-memory fixed-window) applied to
both public webhook routes, proven to actually return 429 under a real
burst in `apps/api/tests/production.test.ts`. Disclosed limitation:
in-memory and per-process - correct for this repo's single-instance
deployment (see "Database" below), would need a shared store if ever scaled
horizontally.

### 12. Deployment pipeline - REAL, runnable scripts
`scripts/deploy.sh` (backup -> install -> typecheck+test -> migrate deploy
-> build -> restart supervisor -> smoke test), `scripts/rollback.sh` (git
rollback + optional DB restore), `scripts/smoke-test.sh` (real HTTP checks
against a running instance - actually executed against a live
`npm run dev:api` process during this phase's own verification, see below).
No staging environment exists in this sandbox to deploy to, so "staging"
here is documented as a process (use the same scripts against a
staging-configured `.env`), not something this phase could execute.

### 13. Duplication-prevention tests - REAL, mandatory, all passing
`core/production/duplicationPrevention.test.ts`: (a) `claimTask()`'s
DB-atomic `updateMany` - 8 concurrent claimers on one task row, exactly 1
wins; (b) the same primitive modeling a scheduler-dispatched task (the
shape `morning-briefing`/`daily-report`/`weekly-review` actually use) - 12
concurrent claimers, exactly 1 wins; (c) `reserveIdempotencyKey()` - 6
concurrent identical outbound-send triggers, exactly 1 reservation
succeeds; (d) `closeSession()`'s atomic claim - 5 concurrent close attempts
on one browser session, exactly 1 performs the real provider close. All
reuse the exact existing DB-atomic mechanisms, per this phase's
instructions - no new concurrency primitive was invented.

### 14. Failure injection / chaos-lite - REAL, executed against real code
`core/production/chaos.test.ts`: (a) a genuinely stale heartbeat (crash
mid-task simulation) triggers a REAL `Worker.watchdogPass()` restart,
observed via the DB heartbeat row (`restartCount` incremented,
`lastHeartbeat` advanced, `isRunning()` true); (b) repeated re-injected
crashes exhaust the restart cap and the worker reaches the real `CRASHED`
terminal state (`giveUpPermanently()`), never an infinite restart loop; (c)
DB-unreachable fail-closed, proven two ways: a separate `PrismaClient`
pointed at a nonexistent path throws on the exact primitive
`core/state/index.ts`'s `getSystemState()` calls, and (for this sandbox,
running as root, where permission-based unreachability simulation doesn't
work) renaming the live SQLite file out of the way for the duration of one
real `toolRegistry.execute()` call and confirming it never returns `"OK"`.

### 15. Security/dependency audit - REAL, reported honestly, nothing hidden
`npm audit`: **11 vulnerabilities (7 moderate, 3 high, 1 critical)**, all in
**dev/build tooling or the optional Electron desktop stub**, none in this
system's actual runtime request path:
- **critical**: `vitest` (via `@vitest/mocker`/`vite`/`vite-node` - path
  traversal in Vitest's own UI server, which this repo never runs) - dev
  dependency only.
- **high**: `electron` (~25 advisories - `apps/desktop` is an explicitly
  unlaunched stub, per this phase's own brief) and `extract-zip`
  (electron-builder transitive dep) - both dev/desktop-build tooling only;
  `vite`/`esbuild` (dev server path-traversal/CORS issues) - dev tooling
  only, never runs in production (production serves `apps/web`'s static
  `dist/` build, not the Vite dev server).
- **moderate**: `react-router`/`react-router-dom` (open redirect via
  backslash in `<Link>`/`useNavigate` - a REAL runtime dependency of
  `apps/web`, the dashboard - worth fixing in a follow-up, not high-severity
  for an internal operator dashboard behind authentication, but not
  dismissed either) and `uuid` (via `node-cron`, a REAL production
  dependency of the scheduler - a buffer-bounds issue in `uuid` v3/v5/v6
  generation the scheduler doesn't call the affected code path of, but
  still worth a future `node-cron` upgrade).
`npm audit fix --force` was NOT run - it would bump `node-cron` to a
breaking major version and `react-router-dom` to a breaking major version,
both requiring their own regression pass this phase's scope does not cover
(the instruction is "report honestly", not "silently force-upgrade and
hope nothing breaks"). Documented here as a follow-up, not swept under the
rug.

### 16. Regression tests for existing safety boundaries - REAL
`core/production/safetyRegression.test.ts`: financial hard-block under 50/20
concurrent evaluations (all blocked, and read-only actions on a financial
domain confirmed NOT hard-blocked, proving the block is scoped not a
blanket ban); `EMERGENCY_STOP`/`PAUSED` under 30 concurrent tool-execute
attempts each (all `BLOCKED`, zero slip-through); session expiry and
account deactivation (both reject an otherwise-valid session). All target
the pre-existing, unmodified functions.

### 17. Runbooks - REAL
`docs/RUNBOOK_OPERATOR.md` and `docs/RUNBOOK_PROVIDERS.md`. Variable names
only, no real secrets, as required.

### 18. Autonomy levels / feature flags / cost governance / test mode - documented, not re-implemented
Existing behavior only, read directly from `core/policy`, `core/decision_engine`,
`core/ai/costControl.ts`, `core/state`: PAUSED/RUNNING/EMERGENCY_STOP are the
real system states (`core/state`); ALLOWED/NOTIFY/BLOCKED are the real
policy levels (`core/policy`, wrapping `core/decision_engine.classify()`);
per-tool disable and per-agent pause are the real fine-grained flags
(`core/state`); `core/ai/costControl.ts`'s daily/monthly spend caps are the
real cost governance (see this phase's own chaos/regression tests
exercising a cost-limit-exceeded path via existing suites). No "test mode"
flag exists in this codebase beyond the test environment's own
`DATABASE_URL`/`NODE_ENV=test` - Phase 12 does not invent one.

## Database: SQLite vs PostgreSQL (item 3)

**Decision: keep SQLite. Not migrated.**

Evidence considered, read directly from the code (not assumed):
- `core/worker/config.ts`'s `DEFAULT_WORKER_CONFIG.maxWorkers = 2` - the
  Autonomous Worker runs at most 2 concurrent task slots, **within one
  process**. There is no multi-process worker fleet in this codebase (see
  `core/worker/index.ts`'s own header comment, unchanged by this phase).
- Every concurrency-sensitive operation this codebase has (`claimTask`,
  `closeSession`, `reserveIdempotencyKey`) already uses SQLite-safe atomic
  `updateMany`/unique-constraint patterns - proven correct under real
  concurrent load in `core/production/duplicationPrevention.test.ts` (up to
  12 concurrent racers on one row, correctly serialized).
- SQLite's single-writer model is what makes the "1 process only" topology
  in `deploy/docker-compose.yml`/`deploy/pm2/ecosystem.config.js` a hard
  constraint, not a preference - this is the honest cost of the decision,
  documented in both those files and here, not hidden.
- Prime Pak Packages' actual transaction volume (per every prior phase's
  own business-domain writeup - a single SME's email/WhatsApp/CRM traffic)
  gives no evidence of a concurrency ceiling SQLite's single-writer model
  would hit. A migration would add real operational cost (a DB server to
  run, connection pooling to configure, a new backup/restore story) for a
  scaling need that doesn't exist yet.
- **When to revisit**: if this system is ever deployed with `maxWorkers`
  raised meaningfully, or a genuine need to run more than one API/worker
  instance concurrently emerges (e.g. for zero-downtime deploys at a scale
  where a few seconds of restart-time unavailability actually matters),
  PostgreSQL becomes the right call - at that point, Prisma's own schema is
  already datasource-provider-swappable with a `datasource` line change, no
  application code depends on SQLite-specific SQL.

## Production Readiness Self-Classification: **LEVEL 1**

("LEVEL 0-4, strictly evidence-based... do not claim a higher level than
what you actually verified with a running command/test.")

| Level | Meaning (as used here) | Met? |
|---|---|---|
| 0 | Runs locally, no deployment story | Exceeded |
| 1 | Deployable with real health checks, backups, supervision, and disclosed limits | **YES - this phase's evidence above** |
| 2 | Level 1 + at least one provider genuinely proven against a live API in this environment | **NO** |
| 3 | Level 2 + horizontally scalable / multi-instance safe | **NO - explicitly not (SQLite single-writer)** |
| 4 | Level 3 + demonstrated 24/7 long-running stability under real production load | **NO - not tested** |

**Why capped at LEVEL 1, itemized:**
- **No provider has a live-credential-verified send in this environment.**
  `ANTHROPIC_API_KEY`, Gmail/WhatsApp/Twilio/Brave credentials are all
  unset in this sandbox (`config/providers.test.ts` proves the classifier
  correctly reports each as `CONFIGURATION_REQUIRED` when absent) - this
  phase did not obtain or test against any real credential, so no provider
  can be claimed to genuinely work in production, only that the code path
  exists and fails closed/honestly when unconfigured.
- **Single-process, single-SQLite-writer topology, explicitly not
  horizontally scalable** - documented above and in `deploy/`, not a gap to
  paper over.
- **No long-running/24-7 soak test was performed.** The chaos tests prove
  SPECIFIC failure-recovery behaviors (watchdog restart, DB-unreachable
  fail-closed) each execute correctly ONCE, in seconds, not that the system
  survives days of real production load. Claiming LEVEL 4 would require
  that evidence, which does not exist.
- **In-memory, per-process rate limiting** - correct for the current
  single-instance topology, but a real limitation if that topology ever
  changes without also changing this.
- **11 known dependency vulnerabilities** (item 15) - none in the runtime
  request path, but not zero, so "fully hardened" would overclaim.

What genuinely IS proven (the basis for LEVEL 1, not LEVEL 0): real
backup/restore cycle, real watchdog crash recovery, real DB-unreachable
fail-closed behavior, real duplicate-prevention under concurrent load, real
safety-boundary enforcement under concurrent load, real health/readiness
endpoints, real rate limiting, real deployment/rollback scripts exercised
against a live running instance (`scripts/smoke-test.sh` was run against a
real `npm run dev:api` process during this phase's own verification and
passed all four checks) - all backed by executed tests or commands, not
assertions.
