# Phase 7.1: Email/CRM Hardening

A completion/hardening pass over Phase 7 only (see `docs/PHASE7_EMAIL_CRM.md`
for the phase this builds on). No Phase 8 work, no WhatsApp/voice/phone/
browser/computer-control/live-trading/payment-processing, no redesign of
working architecture - every change here is the smallest additive fix that
closes a real, disclosed gap from Phase 7's own "Remaining limitations"
section or from a fresh, independent re-audit.

## 1. Scheduler timezone (Asia/Karachi)

`morning-briefing` and `daily-report` (`scheduler/index.ts`) were hardcoded
to the literal string `"UTC"`. Pakistan Standard Time is a fixed UTC+5 offset
with **no daylight saving** (Pakistan abolished a brief 2008-2009 DST trial;
verified via `Intl.DateTimeFormat`, not assumed - see
`scheduler/scheduler.test.ts`'s new test computing the offset for both a
January and a July date and getting the same +5h both times). `node-cron`'s
`cron.schedule(expr, fn, {timezone})` genuinely threads the timezone into its
internal `TimeMatcher` via `Intl.DateTimeFormat({timeZone})` (read
`node_modules/node-cron/src/time-matcher.js` directly to confirm before
changing anything - the plumbing was already correct), so this was a 2-line
change per job:

- `morning-briefing`: `schedule: "0 5 * * *"`, `timezone: "Asia/Karachi"` (was
  `"UTC"` - 05:00 UTC is 10:00 Pakistan time, not the intended local morning).
- `daily-report`: `schedule: "0 21 * * *"`, `timezone: "Asia/Karachi"` (same
  fix). The report's own DATA is unaffected - only its firing time.

No other scheduled job's timezone was touched. New regression tests assert
(a) the literal stored `Automation.timezone` is `"Asia/Karachi"` for both
jobs, (b) the UTC-offset math above, (c) re-registering both jobs twice
(simulating a restart) creates no duplicate `Automation` row and no duplicate
cron task, reusing the exact pre-existing test pattern in
`scheduler/scheduler.test.ts`.

## 2-5. Real, persisted, worker-executed follow-ups

Phase 7 built `core/business/followUp.ts`'s cancellation guard
(`isFollowUpAllowed()`) but never wired a real follow-up into the scheduler
or worker - this phase closes exactly that gap, reusing everything Phase 7
already proved safe.

**New `FollowUp` table** (migration `20260928150017_phase7_1_followup_hardening`,
additive only): `leadId`/`contactId`, `sequenceStep`, `subject`/`body`
(captured at SCHEDULING time via the same deterministic template generator
every other draft uses - never invented at send time), `scheduledFor`,
`status` (`SCHEDULED | CANCELLED | EXECUTED | SKIPPED`), `cancelReason`,
`taskId` (unique - the Task that will/did execute it). `@@unique([leadId,
sequenceStep])` is the idempotency key for "this specific follow-up in this
specific sequence" (item 4) - `scheduleFollowUp()` reuses the existing row on
a repeat call for the same lead+step rather than creating a second one, and
survives a genuine insert race (catches the unique-constraint error and
re-reads).

**Dispatch (`scheduleDueFollowUps()`, `core/business/followUp.ts`)**: finds
every `SCHEDULED` follow-up whose `scheduledFor` has arrived and has no
`Task` yet, creates ONE `Task` per follow-up via the existing
`core/planner.planTask()`, tagged `toolName: "email"` - the exact same
pattern `daily-report`'s `toolName: "reports"` tag already established, so
the worker executes it directly through the guarded tool registry, no new
execution path. The claim step (`updateMany({where: {id, taskId: null}})`)
is DB-atomic, so two overlapping dispatch passes for the same due follow-up
(a scheduler duplicate fire) create exactly one Task, not two - the losing
pass deletes the orphan Task it wastefully created. A new hourly
`follow-up-dispatch` job (`scheduler/index.ts`, UTC - an internal dispatch
cadence, not one of the two jobs this hardening pass retimed to
Asia/Karachi) calls this function.

**Worker plumbing (`core/worker/index.ts`, 7-line additive change)**: the
worker's `toolName`-tagged execution path called
`toolRegistry.execute(task.toolName, {}, WORKER_IDENTITY)` with a literal
empty input - there was no way for a `toolName:"email"` task to reach its
own content. Changed to pass `{ taskId: task.id }`; every existing
`toolName`-tagged tool (`tools/reports.ts`) ignores unknown input keys, so
this is additive and does not change any existing job's behavior.

**No second sender (`tools/email/emailTool.ts`)**: `execute()` now, when
called with no `action` and a `taskId` that resolves to a `FollowUp` row,
delegates to a new `handleFollowUpDispatch()` function. That function:
1. Re-checks EVERY cancellation condition against the LATEST CRM state via
   `isFollowUpAllowed()` (extended - see below) - customer reply since
   scheduling, suppression, unsubscribe, task cancellation, system
   pause/emergency-stop, lead WON/LOST/NURTURE, and a PENDING approval still
   outstanding for the same contact.
2. If any condition is true, the `FollowUp` transitions `SCHEDULED ->
   CANCELLED` with a clear `cancelReason` and returns `BLOCKED` -
   `handleSend()` (and therefore the provider) is never even called.
3. Otherwise it calls the exact same, pre-existing `handleSend()` function
   with the content captured at scheduling time - the identical
   suppression -> anti-spam -> idempotency -> risk-classification ->
   approval-gate pipeline every other send goes through, not a parallel
   implementation. On a real send, `FollowUp` transitions to `EXECUTED`.

`isFollowUpAllowed()` was extended (additively - its existing
`{taskId, contactId, sinceTaskCreatedAt}` call shape and behavior for
existing callers is unchanged) with an optional `leadId` (checks
WON/LOST/NURTURE) and a PENDING-approval-for-this-contact check (item 5's
"no follow-up while an earlier outbound has a pending approval").

## 6. Approval queue edge-case hardening

Three real gaps found by re-reading (not just re-testing) `tools/email/
emailTool.ts`'s approval-consumption logic:

1. **No target/action match check.** The code checked only
   `approval.status !== "APPROVED"` - an approval id that resolved to a real,
   APPROVED row for a *different* recipient/content would have silently
   authorized this send. Fixed: the APPROVED row's `action` and `target` are
   now verified against the current send's `"email.send"`/`to` before it is
   trusted; a mismatch is treated as absent (falls through to the normal
   "create/reuse a PENDING approval" path).
2. **No `expiresAt` check at send time.** `expireOverdueRequests()` only
   flips PENDING rows past their `expiresAt`; an APPROVED row's `expiresAt`
   was never re-checked when it was actually consumed, so a stale approval
   used long after being granted would still have worked. Fixed: an APPROVED
   row past its `expiresAt` is transitioned to `EXPIRED` right there and
   treated as absent.
3. **No revoke path.** `ApprovalStatus` gained `REVOKED` (additive) and
   `core/approvals.revokeRequest()` (OWNER-only, audited, never mutates
   `proposedContent` - same discipline as approve/reject) transitions
   `APPROVED -> REVOKED`. `tools/email/emailTool.ts`'s existing `status !==
   "APPROVED"` check already treats `REVOKED` as not-approved with zero
   further change. New route: `POST /approvals/:id/revoke` (same
   `approval.decide` OWNER-only authz as approve/reject).

Every edge case from the request is a real, passing test in
`tools/email/emailTool.test.ts`/`core/approvals/approvals.test.ts`: forged
approval id, REJECTED, EXPIRED (both pre-existing from Phase 7), plus this
phase's target-mismatch, expired-at-send, REVOKED, forged caller-supplied
`approved`/`skipApproval`/`forceSend`/`adminOverride` flags (all silently
ignored - the DB row's status is the only source of truth), and suppression
added after approval (still hard-blocks).

## 7. True-concurrency idempotency (atomic reservation)

Re-reading `core/business/idempotency.ts` found a real gap beyond what Phase
7 tested: `checkIdempotency()` is a plain read, and `recordSendAttempt()` is
check-then-act (find, then create-or-update) - safe against a *sequential*
retry, but not against two calls with the identical `idempotencyKey`
genuinely racing each other (e.g. two worker slots claiming/executing
duplicate follow-up tasks, or two `Promise.all`'d tool calls). Both could
pass the read, both call `provider.sendMessage()`, and only the second
`recordSendAttempt()` write would fail/overwrite - a real double-send.

Fixed with `reserveIdempotencyKey()` (`core/business/idempotency.ts`): an
atomic INSERT (`OutboundSendLog.idempotencyKey`'s existing DB unique
constraint, not an in-memory lock) right before `provider.sendMessage()` is
ever called. The first caller's `create()` succeeds (status `SENDING`,
additive - `OutboundSendLog.status` gained this one new value); a genuinely
concurrent second caller's `create()` fails on the unique constraint, and a
conditional `updateMany({status: {in: ["FAILED","BLOCKED"]}})` is tried next
so a *sequential* retry after a real failure can still legitimately re-claim
the key (this is what keeps Phase 7's existing "transient failure then
retry" test passing) - but a row that is `SENDING` or already `SENT` is never
re-claimed. The losing concurrent caller returns the winner's outcome and
never calls the provider. Tested directly with `Promise.all` of two
identical `tool.execute()` calls, asserting exactly one `provider.sendMessage()`
call and exactly one `OutboundSendLog` row.

## 8. Suppression case sweep

Re-verified with fresh tests: exact email, casing/whitespace variants
(`normalizeEmail()` already lowercases+trims - confirmed, not assumed),
duplicate `suppressContact()` calls for the same email (upsert - one row,
not two), suppression added mid-retry (still hard-blocks on the retried
attempt), suppression added after approval but before (re)send (still
hard-blocks - see item 6). **Domain-level suppression does not exist** -
`SuppressedContact` is exact-`normalizedEmail`-keyed only; this is a real,
disclosed gap (see Limitations below), not something this pass fabricated
support for.

## 9-10. CRM dedup / provenance re-verification (no code change needed)

Re-read `core/crm/dedup.ts`: email normalization (lowercase+trim) and domain
normalization (strips protocol/`www.`/path) both already work correctly as
claimed - re-verified with fresh test-style manual checks, no regression
found. **Phone normalization does not exist** (`core/crm/dedup.ts` has no
phone-matching logic at all today) - a real, disclosed gap, not implemented
this pass to avoid scope creep into a part of the system nothing currently
calls. Company-name fallback matching (no domain given) already exists
(`namesLooselyMatch()`). No code path anywhere auto-merges - every ambiguous
match sets `possibleDuplicate: true` and returns the existing/new row as-is,
confirmed by re-reading every branch of `findOrCreateCompany`/
`findOrCreateContact`/`findOrCreateLead`. Provenance
(`Lead.researchRunId` -> `core/research/provenance.ts`'s existing trace
function) is unchanged and still real - not re-implemented.

## 11. GmailProvider - still honestly CONFIGURATION_REQUIRED

No `GMAIL_ACCESS_TOKEN`/`GMAIL_USER_EMAIL` in this environment (verified:
`env | grep -i gmail` returns nothing but the unrelated
`CLAUDE_CODE_USER_EMAIL`). `GmailProvider` is untouched this phase and still
honestly returns `CONFIGURATION_REQUIRED` for every method with no live call
ever attempted.

## 12-13. Inbound threading / trust boundary - re-verified, unchanged

`core/email/ingest.ts`'s `providerMessageId`-unique upsert (re-verified: the
`Email.providerMessageId` unique constraint is real, and `ingest.ts` reads-
before-upsert on it) prevents double-processing. No fuzzy/name-based contact
matching exists in the inbound path - a non-matching sender either matches by
exact normalized email or falls through without silently misattributing to
an existing contact. `wrapExternalEmailContent()` still has **no live LLM
consumer** (email classification/drafting remain deterministic, per Phase
7's own honest disclosure, unchanged and not reactivated this phase) - this
pass does not claim an active defense for a path that does not exist.
Structurally re-confirmed: no secret/credential value is ever interpolated
into any prompt-construction code in this codebase (a static, checkable
property regardless of whether the LLM email path is wired).

## 14. AI-assisted email generation - still NOT_IMPLEMENTED, on purpose

`core/business/emailDraft.ts` is untouched - still deterministic/template-
based, `validateDraftGrounding()` unchanged and not weakened.

## 15. Outbound-risk-policy bypass re-verification

Re-confirmed via the concurrency/forged-flag tests in item 6/7 above and the
pre-existing `agents/no-autonomous-highrisk-send.test.ts` (still 6/6
passing, its source-level comment-stripped check re-verified against the
now-larger `emailTool.ts` file) that no caller-supplied field - forged
`approved`/`skipApproval`/`forceSend`/`adminOverride` - can bypass the risk
classifier or the approval gate.

## 16. Worker integration

Follow-up `Task` rows genuinely go through `core/worker/claim.ts`'s
DB-atomic claiming (unchanged, untouched) - new tests in
`core/business/followUp.test.ts` claim a real dispatched follow-up `Task`
with two concurrent `claimTask()` calls (only one wins, reusing the exact
`core/worker/claim.test.ts` pattern) and simulate a crashed claim being
picked up by the unmodified `reclaimExpiredTasks()`. Emergency-stop halts a
follow-up before the provider is ever reached via TWO independent layers:
`core/enforcement`'s existing, untouched state gate (which every
`toolRegistry.execute()` call already passes through) and
`isFollowUpAllowed()`'s own state check. Follow-up sends are not LLM calls,
so `core/ai/costControl` has no spend surface here to connect to - stated
plainly rather than forcing a connection that does not exist.

## 17-18. Daily report / memory - light re-verification only

The daily report's `emailCrm` section is unaffected by the timezone change
(only the job's firing time moved; the report's data queries are untouched).
No new code needed for item 18 - business `Memory` writes already carried
real `source`/`confidence`/`relatedEntity` per Phase 7 and this pass added no
new Memory-writing code path.

## 19. Security audit - what was actually read, not just grepped

Read (not just pattern-matched) `tools/email/emailTool.ts` end-to-end after
every edit, `core/business/idempotency.ts`, `core/approvals/index.ts`,
`core/business/followUp.ts`, `core/worker/index.ts`'s `processClaimedTask()`,
and `scheduler/index.ts`'s `registerExampleJobs()`. Grep sweep (fresh, run
after all changes, not before):
- `skipApproval|forceSend|unsafeSend|adminOverride`: zero occurrences in any
  production file - the only matches are this phase's own new test that
  proves these forged flags are ignored.
- `eval(`/`new Function(`: zero occurrences outside
  `core/skills/staticAnalysis.test.ts` (which tests that they're rejected).
- `prisma.email.create(`: exactly one call site, `tools/email/emailTool.ts`
  (the send path). `core/email/ingest.ts` uses `upsert` (the read/ingest
  path) - both consistent with the documented invariant.
- `.sendMessage(`: exactly one real call site in the whole codebase,
  `tools/email/emailTool.ts`'s `handleSend()` - unchanged from Phase 7,
  re-verified after every edit this phase made to that file.
- `security/redact.ts` is key-pattern-based (`/api[_-]?key|token|secret|
  password|authorization|bearer|access[_-]?key/i`), not a field-name
  allowlist - it automatically covers any new field name without needing an
  update, and this phase introduced no new secret-shaped field (`FollowUp`'s
  fields are all plain business data).

## 22. Migration

`database/migrations/20260928150017_phase7_1_followup_hardening/migration.sql`
- one new table (`follow_ups`), purely additive, no existing migration file
touched. `npx prisma generate` run and the client compiles; `npx prisma
validate` passes.

## Explicit REAL / CONFIGURATION_REQUIRED / NOT_IMPLEMENTED breakdown (Phase 7.1 additions only - Phase 7's own breakdown in `docs/PHASE7_EMAIL_CRM.md` section 16 is otherwise unchanged)

**Real, newly working this phase:**
- Follow-up scheduling, dispatch, cancellation re-check, and execution
  through the exact same `emailTool.ts` send path - end-to-end, tested with
  a call-counting mock provider.
- Follow-up idempotency (`FollowUp(leadId, sequenceStep)` unique constraint)
  and true-concurrency send idempotency (`reserveIdempotencyKey()`).
- Approval target/expiry re-validation at send time, and the revoke
  lifecycle.
- Asia/Karachi scheduling for `morning-briefing`/`daily-report`.

**Still CONFIGURATION_REQUIRED:** `GmailProvider` (no live credentials in
this sandbox - unchanged from Phase 7).

**Still NOT_IMPLEMENTED / disclosed gaps (unchanged or newly disclosed this
phase, not fixed - scope discipline, not oversight):**
- AI-assisted email classification/drafting (explicitly out of scope for
  Phase 7.1 per the task brief).
- Domain-level suppression (`SuppressedContact` is exact-email-keyed only).
- Phone-number normalization/matching in `core/crm/dedup.ts` (no phone-based
  contact matching exists at all).
- A contact-only (no `leadId`) follow-up sequence has no DB-unique
  idempotency key (`@@unique([leadId, sequenceStep])` requires a `leadId`) -
  documented in the schema comment; callers should prefer supplying `leadId`.
- WhatsApp, voice, phone, browser/computer control, live trading, payment
  processing - all still untouched and out of scope, as in every prior
  phase.
