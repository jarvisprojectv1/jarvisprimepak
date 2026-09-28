# JARVIS Operator Runbook (Phase 12)

This runbook is for a human operator running JARVIS for Prime Pak Packages.
It documents current, REAL behavior only - nothing here is aspirational.
**Never put a real secret value in this file** - only variable names.

## Daily operation

- The single supervised process (API + Autonomous Worker + Scheduler, all
  in one Node process - see `docs/PHASE5_AUTONOMOUS_WORKER.md`) is started
  by whichever supervisor you deployed (`deploy/systemd/jarvis-api.service`,
  `deploy/pm2/ecosystem.config.js`, or `deploy/docker-compose.yml`).
- Check health: `GET /health/live` (process alive), `GET /health/ready`
  (DB reachable + provider configuration summary, unauthenticated), and
  `GET /system/health` (the full 12-component report, requires login) for
  day-to-day monitoring.
- `scripts/smoke-test.sh [base-url]` is a 30-second confidence check after
  any restart/deploy.

## Emergency stop / pause

- **Emergency stop** (`POST /system/emergency-stop`, OWNER only): blocks
  every tool/agent execution immediately (`core/enforcement`). Use this if
  JARVIS is doing something wrong RIGHT NOW.
- **Pause** (`POST /system/pause`): same effect, framed as a deliberate,
  reversible halt rather than an incident.
- **Resume** (`POST /system/resume`): returns to RUNNING.
- Both are audited (`security/audit.ts`) and proven, under this phase's own
  regression tests (`core/production/safetyRegression.test.ts`), to block
  ALL concurrent tool calls with zero race-condition slip-through.
- You can also pause a single agent (`POST /system/agents/:name/pause`) or
  disable a single tool (`POST /system/tools/:name/disable`) without a
  system-wide stop.

## Backups

- `scripts/backup-db.sh [output-dir]` - run manually, or on the
  `jarvis-backup.timer`/`.service` systemd pair (daily by default), or via
  your own cron. Produces a timestamped, integrity-checked snapshot.
- `scripts/restore-db.sh <backup-file> [--force]` - restores a snapshot.
  ALWAYS takes a pre-restore safety copy of whatever DB is currently there
  before overwriting it.
- Both scripts are proven end-to-end (real backup, real destroy, real
  restore, real data verified intact) by
  `core/production/backupRestore.test.ts` - not just "the script exists".
- **Test your restore procedure periodically on a non-production copy.** A
  backup that has never been restored is unverified.

## Deploy / rollback

- `scripts/deploy.sh [--skip-tests]` - backup, install, typecheck+test,
  `prisma migrate deploy`, build, restart the supervisor, smoke test.
- `scripts/rollback.sh <git-ref> [backup-file]` - code rollback via git,
  optional DB restore (only needed if the deploy you're rolling back was a
  non-additive migration - see `docs/PHASE12_PRODUCTION.md`).
- Migrations in this codebase have been additive-only through Phase 12 (see
  every `docs/PHASE*.md`'s own confirmation of this) - there is no
  down-migration tooling, by design (Prisma's `migrate deploy` is
  forward-only).

## What to watch

- `GET /system/health` - `worker`, `scheduler`, `taskQueue`, `disk` and
  `resources` components in particular.
- Notifications (`GET /notifications`) - the watchdog and enforcement gate
  both raise `WARNING`/`CRITICAL` notifications on real findings (repeated
  failures, queue growth, a worker giving up permanently, a NOTIFY-level
  policy decision).
- `AuditLog` - every state change, every blocked action, every tool/agent
  execution is there, with the real authenticated actor (never a
  client-supplied string).

## Provider configuration

See `docs/RUNBOOK_PROVIDERS.md` for the per-provider setup runbook.
`GET /health/ready`'s `providers` field and `config/providers.ts` are the
single source of truth for "what still needs configuring" - never assume a
provider works just because a var LOOKS set; `INVALID` covers an obvious
placeholder value, but only a real send attempt proves a credential is
actually valid.

## Known operational limits (disclosed, not hidden)

- **Single process, single SQLite writer.** Do not run more than one
  instance of the API/worker/scheduler process against the same database
  file (see `docs/PHASE12_PRODUCTION.md` "Database"). `deploy/docker-compose.yml`
  and `deploy/pm2/ecosystem.config.js` are both deliberately pinned to one
  instance.
- **Webhook rate limiting is per-process, in-memory** (see
  `apps/api/src/middleware/rateLimit.ts`) - correct for the single-instance
  deployment this repo currently supports; would need a shared store (e.g.
  Redis) if this were ever horizontally scaled.
- **No live credential validation for any provider** - `CONFIGURED` means
  "the required env vars are present", not "the credential has been proven
  to work with a real API call". The first real send/call is still the
  first real proof.
