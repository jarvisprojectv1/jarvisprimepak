# Phase 7: Email & CRM

This phase adds real outbound/inbound email capability and a working CRM
pipeline on top of the enforcement/policy/memory/worker/research
infrastructure built in Phases 1-6.1. It does **not** touch the enforcement
mechanism - see "Untouched files" at the end, verified with `git diff
--stat`.

## 1. Architecture reuse (non-negotiable, verified)

Every email/CRM tool registers through `tools/registry.ts`'s
`ToolRegistry.register()`; the only new agent-adjacent orchestration
(`core/crm/leadWorkflow.ts`) calls the already-registered `research` agent
via `agents/registry.ts`'s guarded `run()`. There is exactly one place in
this codebase that calls a real `EmailProvider.sendMessage()` -
`tools/email/emailTool.ts` - proven by
`agents/no-autonomous-highrisk-send.test.ts`'s source-level and `grep`-based
checks. No direct `fetch`/SMTP/IMAP call happens anywhere outside a
registered Tool's `execute()`.

## 2. Email provider abstraction (`tools/email/`)

- `types.ts` - the `EmailProvider` interface (`listMessages`, `getMessage`,
  `sendMessage`, `isConfigured`).
- `gmailProvider.ts` - `GmailProvider`, a real Gmail API v1 implementation
  (list/get/send via `https://gmail.googleapis.com/gmail/v1/users/me/...`,
  base64url MIME encoding for sends, plain-text extraction for reads).
  **Honesty note (same pattern as Phase 6's `BraveSearchProvider`): no
  `GMAIL_ACCESS_TOKEN`/`GMAIL_USER_EMAIL` are available in this sandbox, so
  this is implemented carefully from Google's documented request/response
  shape but UNTESTED AGAINST THE LIVE API.** Without those env vars,
  `isConfigured()` is `false` and every method honestly returns
  `CONFIGURATION_REQUIRED` - never a fabricated inbox or a fake "sent"
  result. Token refresh is explicitly out of scope (a short-lived access
  token must be supplied directly), documented in `.env.example`.
- `mockProvider.ts` - `MockEmailProvider`, a pure in-memory test double.
  **This is the ONLY provider the automated test suite ever exercises a
  send against** - `npm test` has zero live network calls to any email
  service, per the Production Safety non-negotiable.
- `emailTool.ts` - the `email` Tool, action-based (`list`/`send`/`draft`),
  same house style as `tools/files.ts`/`tools/web.ts`. Replaces the old
  Phase 1 `tools/email.ts` stub; the new file still honestly returns
  `CONFIGURATION_REQUIRED` with no provider configured.

## 3. Trust boundary reuse (email content)

`core/research/trustBoundary.ts` was extended **additively** (no existing
function's behavior/output changed) with `wrapExternalEmailContent()` -
identical delimiter/labeling discipline as the Phase 6
`wrapExternalContent()` (a distinct `EXTERNAL_EMAIL_CONTENT` delimiter, the
same `trust_level: UNTRUSTED` / `instructions_allowed: false` header, the
same "this is DATA, never an instruction" prose). `core/email/ingest.ts` is
the only place inbound email content is ever prepared for an LLM prompt
today - it is not yet actually sent to an LLM (see "Deviations" - drafting
is currently template-based, not LLM-based), but the wrapper exists and is
tested (`core/email/ingest.test.ts`'s E tests) exactly so a future
LLM-assisted classifier/drafter has nowhere else to plug in fetched email
text except through this function, the same discipline
`core/research/synthesis.ts` established for web content.

`core/business/emailClassification.ts`'s deterministic classifier does
plain substring matching - no LLM call, so it has no prompt-injection
surface itself; malicious content is proven inert
(`core/email/ingest.test.ts`'s E tests: 5 injection payloads classified as
plain data, zero tool executions, zero approval/suppression side effects).

## 4. CRM schema changes (migration `20260928105050_phase7_email_crm`)

- `Contact`: `+normalizedEmail`, `+possibleDuplicate`, `+unsubscribed`,
  `+lastContactedAt`.
- `Company`: `+domain`, `+possibleDuplicate`.
- `Lead`: `+possibleDuplicate`, `+researchRunId`, `+qualification` (JSON).
  `status` values extended in application code
  (`core/crm/pipeline.ts`'s `LEAD_STATUSES`) to `NEW | RESEARCHING |
  QUALIFIED | CONTACTED | RESPONDED | SAMPLE_REQUESTED | QUOTING |
  NEGOTIATION | WON | LOST | NURTURE` - same "SQLite has no enums, validate
  in application code" convention as every other status field.
- `Communication`: `+activityType`, `+relatedEntityId`, `+metadata` - reused
  directly as the CRM activity feed (item 19), not a parallel `Activity`
  table.
- `Email`: `+status` values extended, `+providerMessageId` (unique - the
  idempotent-upsert key), `+threadId`, `+toAddress`/`fromAddress`,
  `+classification`/`classificationReasons`, `+riskCategory`,
  `+idempotencyKey` (unique), `+relatedLeadId`, `+updatedAt`.
- `Quote`: `status` values extended to include `REQUIRES_APPROVAL`,
  `+totalIsComputed`, `+approvalRequestId`, `+sentAt`, `+leadId`.
- New tables: `SuppressedContact`, `OutboundSendLog`, `ApprovalRequest`,
  `ProductCategory`.

## 5. Dedup logic (`core/crm/dedup.ts`)

- **Company**: exact match key is normalized domain
  (`core/crm/dedup.ts#normalizeDomain`). Same domain + loosely-matching name
  -> reused, never duplicated. Same domain + a clearly different name ->
  the existing row is flagged `possibleDuplicate: true` and returned
  (never silently renamed, never a second row created).
- **Contact**: exact match key is normalized email. Without an email, a
  same-company + same-name match is flagged `possibleDuplicate` **and a
  new row is still created** - a real second person is never silently
  dropped just because their email wasn't given.
- **Lead**: an existing **open** (not WON/LOST) lead for the same
  company+contact pair is reused; a second open lead for the same company
  but a different contact is flagged, not merged.
- Tests: `core/crm/dedup.test.ts` (12 tests, items G/H/I) with realistic
  near-duplicate inputs (case/whitespace variations, `www.` prefixes,
  trailing slashes, name variants).

## 6. Research -> CRM provenance proof

`core/crm/leadWorkflow.ts#runLeadResearchWorkflow()`: after the research
agent runs (with `taskId` = the research child task's id), the workflow
looks up the **real** `ResearchRun` row created for that task
(`prisma.researchRun.findFirst({ where: { taskId } })`) and writes its id
onto `Lead.researchRunId` - never a fabricated reference, and left `null`
(never a placeholder id) when no research run was actually produced (e.g.
no search provider configured). `core/crm/leadWorkflow.test.ts`'s K test
asserts exactly this: either `researchRunId` is `null`, or it resolves to a
real, persisted `ResearchRun` row.

**Design choice on wiring**: the workflow is deterministic, code-driven
orchestration (research -> CRM -> qualify -> next-action), not routed
through `core/brain.Brain.handle()` - see the file's header comment for the
full rationale (no planning judgment call is needed for this fixed
sequence; using the Brain would need to hand a model a `propose_plan` tool
it has no legitimate use for here). It still produces a real task tree
(`parentId` = the workflow's root task) with the exact same traceability
guarantee Phase 5.1's `rootTaskId` pattern established for the Brain's own
delegation - proven by `core/crm/leadWorkflow.test.ts`'s task-tree
assertions (item AJ).

## 7. Qualification function (`core/crm/qualification.ts`)

Pure, deterministic, no I/O, no LLM. Exact rule order:
1. Any `disqualifyingSignals[]` present -> `qualified: false`, one reason
   per signal.
2. Research not completed AND company not otherwise verified ->
   `qualified: "UNKNOWN"` (never guessed).
3. Company not verified (research did complete) -> `qualified: false`.
4. No named contact yet -> `qualified: "UNKNOWN"`.
5. Industry-to-product-line match unknown -> `qualified: "UNKNOWN"`.
6. Industry doesn't match -> `qualified: false`.
7. Everything checks out -> `qualified: true`.

Every branch returns a non-empty `reasons: string[]` explaining exactly
why - never an opaque number. `core/crm/qualification.test.ts` (item L).

## 8. Business config data model (`core/crm/businessConfig.ts`)

`ProductCategory` rows (`name`, `description`, `positioning`,
`certifications[]`, `minOrderQuantity`, `productionTimeNotes`,
`costingRules` JSON) are the **only** source of business facts
`core/business/emailDraft.ts` and `core/business/quote.ts` may cite.
`seedDefaultProductCategories()` seeds three conservative, verifiable
starting categories (Corrugated Packaging, Garment Trims & Tags, Flexible
Packaging) with **no certifications/prices seeded that this sandbox cannot
verify** - an operator fills those in via `POST /crm/business-config/product-categories`
before drafts/quotes can cite them.

## 9. Outbound Risk Policy - exact wiring into `core/policy` (item 16)

`core/business/outboundPolicy.ts#classifyOutboundEmail()`:

1. Classifies content via fixed, DATA-driven keyword groups (pricing/
   quotation, contractual commitment, payment instructions, refunds, legal
   statements, sensitive customer data) plus explicit `isMassCampaign`/
   `monetaryValue` flags - never `eval`'d, a plain lookup table scan.
2. Feeds the result into `core/decision_engine`'s **existing**
   `DecisionInput` shape (`irreversible: true` for HIGH risk,
   `monetaryValue` when known) and calls `core/policy.evaluatePolicy()`
   **unmodified** - the same function every tool call already goes through
   inside `core/enforcement`. No new `PolicyLevel`/`DecisionCategory` was
   invented; `core/policy/index.ts`'s only diff is two additive entries in
   its existing lookup tables (`crm.write`, `email.send`) - see the `git
   diff --stat` proof below.
3. **The actual non-bypassable stop** is one layer deeper, because
   `core/enforcement`'s `NOTIFY` level still *executes* a tool call (it
   only raises a Notification) - so `tools/email/emailTool.ts`'s `send`
   action itself, the **only** place a real `provider.sendMessage()` call
   can happen, unconditionally checks risk classification and an
   `ApprovalRequest`'s status **before** ever reaching the provider: HIGH
   risk with no matching **APPROVED** request creates one (or reuses an
   existing PENDING one for the same idempotency key) and returns
   `BLOCKED` - the provider is never called.

**Proof there is no autonomous-send bypass for HIGH RISK**:
`agents/no-autonomous-highrisk-send.test.ts` -
(a) source-level: with comments stripped, `classifyOutboundEmail(` and the
`approval.status !== "APPROVED"` check both occur, in actual code, strictly
before the file's single `provider.sendMessage(` call;
(b) `grep`-based (comments excluded): no file in `core/`, `agents/`,
`tools/`, or `apps/` other than `tools/email/emailTool.ts` calls
`.sendMessage(`;
(c) runtime: a HIGH-RISK send with no `approvalRequestId`, a forged/
nonexistent one, a REJECTED one, and an EXPIRED one **all** return
`BLOCKED` with zero messages ever reaching the mock provider.

## 10. Anti-spam / idempotency

- `core/business/antiSpam.ts`: `Setting`-backed config (same pattern as
  `core/limits`), per-account/per-domain daily limits (via the real
  `OutboundSendLog` ledger) and a per-contact cooldown (via
  `Contact.lastContactedAt`). `isSuppressed()` is checked **first**, inside
  `emailTool.ts`'s `send` handler, strictly before risk classification runs.
- `core/business/idempotency.ts`: `idempotencyKey =
  sha256(taskId|contactEmail|sha256(subject+body))`. `OutboundSendLog.idempotencyKey`
  has a DB unique constraint; `checkIdempotency()` short-circuits a repeat
  send attempt (returns the prior result, never calls the provider again).
  Proven by `tools/email/emailTool.test.ts`'s U/X tests and the retry test
  in the same file (W).

## 11. Approval queue lifecycle (`core/approvals/`)

`ApprovalRequest`: `PENDING -> APPROVED | REJECTED`, or `-> EXPIRED` (via
`expireOverdueRequests()` or a decision attempt past `expiresAt`).
`approveRequest()`/`rejectRequest()` **never** mutate `proposedContent` -
only `status`/`decidedBy`/`decidedAt`/`decisionNote` change (proven by
`core/approvals/approvals.test.ts`'s Q test). Every decision writes a real
`AuditLog` row via the untouched `security/audit.writeAuditLog()` (item R).
`POST /approvals/:id/approve|reject` require the `approval.decide` authz
action, granted **only** to `OWNER` in `core/authz/index.ts` - a SYSTEM/
AGENT/SERVICE identity can create a PENDING request but can never approve
its own.

## 12. Daily report / dashboard - real-data proof

`core/reports/dailyReport.ts` gained an additive `emailCrm` section
(`emailsSentToday`/`emailsReceivedToday`/`newLeadsFromResearchToday`/
`pendingApprovals`/`approvalsDecidedToday`/`leadsByStatus`), every field a
real Prisma aggregate for the report's date window -
`core/reports/dailyReportEmailCrm.test.ts` (item AD) seeds real rows and
asserts the report matches them exactly. `GET /crm/dashboard`
(`apps/api/src/routes/crm.ts`) is likewise every field a live query -
`apps/api/tests/crmApprovals.test.ts`'s AC tests seed rows and assert exact
counts.

## 13. Tests added (mapped to A-AK)

| File | Count | Proves |
|---|---|---|
| `tools/email/emailTool.test.ts` | 11 | A, B, C, O, P, S, T, U, V, W, X |
| `core/crm/dedup.test.ts` | 12 | G, H, I |
| `core/crm/qualification.test.ts` | 6 | L |
| `core/business/emailDraft.test.ts` | 7 | M, N |
| `core/business/emailClassification.test.ts` | 6 | D |
| `core/email/ingest.test.ts` | 5 | D (integration), E, AK |
| `core/approvals/approvals.test.ts` | 7 | Q, R |
| `core/crm/leadWorkflow.test.ts` | 5 | J, K, AJ |
| `core/business/quote.test.ts` | 7 | Z, AA |
| `agents/no-autonomous-highrisk-send.test.ts` | 6 | O, AA (architectural) |
| `apps/api/tests/crmApprovals.test.ts` | 5 | AC, AG |
| `core/reports/dailyReportEmailCrm.test.ts` | 4 | AD |
| `core/business/outboundPolicy.test.ts` | 7 | exact policy wiring for item 16 |
| `core/business/antiSpam.test.ts` | 5 | T (unit), anti-spam config |
| `core/business/followUp.test.ts` | 6 | Y, item 20 guards |
| `security/redactEmailCrm.test.ts` | 3 | AH |

**Total new: 102 tests.** AE (emergency stop), AF (worker pause), AI (cost
controls) are exercised indirectly - every new tool/agent path goes through
the exact same, untouched `core/enforcement` gate Phases 2/5 already proved
these against (see `core/enforcement/enforcement.test.ts`,
`core/state/state.test.ts`, `core/ai/costControl.test.ts`, all still
passing unmodified) plus `core/crm/leadWorkflow.ts`'s own explicit
mid-flow pause/emergency-stop re-check and `core/business/followUp.ts`'s
guard test. No new LLM call path was added this phase (drafting is
template-based - see Deviations), so item AI has no new spend surface to
separately test beyond the existing `costControl.test.ts`.

## 14. Final test count

420/420 passing (318 existing + 102 new). Root `npx tsc --noEmit` and
`apps/api`'s `npx tsc --noEmit` both clean.

## 15. `git diff --stat` proof (against commit `7477554`)

```
core/policy/index.ts | 2 ++
1 file changed, 2 insertions(+)
```

`core/enforcement/`, `tools/registry.ts`, `agents/registry.ts`,
`core/state/`, `core/limits/`'s existing functions, `core/ai/costControl.ts`,
`core/worker/claim.ts`, `core/decision_engine/` - all **zero diff**.
`core/policy/index.ts`'s only change is two additive entries in its
existing `AUTONOMOUS_NAMES`/`NOTIFY_NAMES` lookup sets (`crm.write`,
`email.send`) - no existing line removed or changed, no new `PolicyLevel`
invented.

## 16. REAL vs CONFIGURATION_REQUIRED vs NOT_IMPLEMENTED (exhaustive)

**Real:**
- `MockEmailProvider` end-to-end (list/send), exercised by every automated
  test.
- The full suppression -> anti-spam -> idempotency -> outbound-risk ->
  approval-gate pipeline inside `emailTool.ts`'s `send` handler.
- CRM dedup (company/contact/lead), qualification, the lead research task
  tree, the approval queue lifecycle + audit trail, quote preparation with
  configured costing rules, the anti-spam `Setting`-backed config, the
  follow-up guard function, the CRM dashboard and daily-report real-data
  aggregation.
- `GmailProvider`'s request/response shape (list/get/send against Gmail API
  v1) - implemented, but see below.

**Untested-against-live-service (implemented, not verified live):**
- `GmailProvider` - no `GMAIL_ACCESS_TOKEN`/`GMAIL_USER_EMAIL` available in
  this sandbox. Genuinely exercised only via `MockEmailProvider` in tests,
  exactly like Phase 6's `BraveSearchProvider`.

**Foundation-only / explicitly not built this phase:**
- AI-assisted email classification/drafting (an LLM-in-the-loop variant
  following `core/research/synthesis.ts`'s exact trust-boundary/grounding
  pattern) - deliberately deferred; see Deviations below. The deterministic
  classifier and template-based drafter already meet every hard safety
  requirement (never invents a fact, never itself triggers an action).
- The follow-up engine's *scheduling* (deciding WHEN a follow-up task is
  due and creating it) is not wired into `scheduler/index.ts` this phase -
  only `core/business/followUp.ts`'s guard function
  (`isFollowUpAllowed()`), which any caller of a follow-up task MUST pass,
  is built and tested. Actually creating follow-up tasks on a schedule is
  future work (see Remaining limitations).
- `email` tool's `draft` action is template-based, not AI-assisted (see
  Deviations).

**Still NOT_IMPLEMENTED (unchanged from earlier phases):** WhatsApp, voice,
telephony, browser/computer control, live trading, real financial
transaction capability - none of this phase's code touches any of them.

## 17. Deviations from the brief (and why)

1. **Email drafting is deterministic/template-based, not LLM-generated.**
   The brief allows "a real drafting function" without mandating an LLM
   call; a template that only ever inserts configured `ProductCategory`
   facts or explicit placeholders satisfies "never invent unknown prices/
   certifications/capabilities" **by construction**, with strictly less
   risk than a generative call that then needs grounding validation to
   catch what it might have invented. `validateDraftGrounding()` is built
   as a general-purpose check (works on any draft text, template or
   LLM-generated) specifically so an LLM-assisted variant - following the
   exact `core/research/synthesis.ts` trust-boundary/grounding pattern -
   is a natural, low-risk future addition.
2. **The lead research workflow is deterministic code, not routed through
   `core/brain.Brain.handle()`.** See `core/crm/leadWorkflow.ts`'s header
   comment for the full rationale - the fixed research -> CRM -> qualify ->
   next-action sequence needs no LLM planning judgment, and routing it
   through the Brain would mean giving a model a `propose_plan` tool with
   no legitimate use here. The resulting task tree has the identical
   traceability guarantee either approach would produce.
3. **Follow-up *scheduling* (deciding a follow-up is due and creating the
   task) was not wired into `scheduler/index.ts`.** The brief's emphasis
   ("a follow-up must check for an intervening customer reply, suppression,
   task cancellation, pause, and emergency stop before ever
   creating/sending a follow-up action") is about the **gate**, which is
   fully built and tested (`isFollowUpAllowed()`); the scheduling trigger
   itself is a smaller, mechanical addition left for a follow-up pass to
   avoid touching `scheduler/index.ts`'s existing jobs in a phase already
   this large.
4. **AI-assisted email classification** (the brief's "optional AI-assisted
   classification... for cases needing more judgment") was not built this
   phase, for the same reasoning as point 1 - the deterministic classifier
   already covers every category in scope, and adding an LLM path would
   have meant either under-testing it in the time available or expanding
   scope further into a tenth safety-critical LLM call site.

## 18. Remaining architectural limitations

- `GmailProvider` is unverified against the live API - the exact JSON shape
  Gmail returns, or an OAuth token-refresh flow, could differ from what's
  implemented here in an edge case not covered by this sandbox.
- No AI-assisted classification/drafting (see Deviations #1, #4) - both
  remain safely deterministic in this phase.
- Follow-up task *creation on a schedule* is not wired up (see Deviations
  #3) - the safety gate is built and tested, the trigger is not.
- `core/business/antiSpam.ts`'s daily/domain counters read the real
  `OutboundSendLog` table (not an in-process counter like `core/limits`),
  so they are already correct across restarts, but a very high send volume
  would mean a full-table-scan-shaped query per send; fine at this phase's
  scale, a candidate for an indexed rollup later.
- `core/crm/leadWorkflow.ts`'s retry-duplication guard is weaker than
  `core/brain`'s `planFromPlan`'s: re-running the SAME `rootTaskId` reuses
  CRM rows (dedup-safe) but does create a second set of child Task rows
  under that root rather than reusing the first attempt's still-in-flight
  children - acceptable for this phase's non-negotiable (task-tree
  traceability, not exactly-once child creation), documented here rather
  than silently left unexplained.
