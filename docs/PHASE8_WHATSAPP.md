# Phase 8: WhatsApp & Unified Customer Communications

This phase adds WhatsApp as a second live external-send channel, generalizing
Phase 7's email pipeline (`tools/email/emailTool.ts`, `core/business/*`)
rather than duplicating its business rules. Read `docs/PHASE7_EMAIL_CRM.md`
and `docs/PHASE7_1_HARDENING.md` first - the email pipeline described there
is the reference implementation this phase extends.

## 1. Architectural integration points (read this before the code)

- **Channel model**: `Email.channel` (`"EMAIL" | "WHATSAPP"`, default
  `"EMAIL"`) - the `emails` table is now the message log for BOTH channels.
  `Communication.channel` already existed (Phase 7 built it as a free
  string) and needed no schema change at all.
- **Outbound send**: `tools/whatsapp/whatsappTool.ts`'s `handleSend()` - the
  ONLY WhatsApp provider-send call site, structurally identical in ordering
  to `emailTool.ts`'s `handleSend()`, reusing (not re-deriving)
  `core/business/antiSpam.ts`, `core/business/idempotency.ts`,
  `core/business/outboundPolicy.ts`, and `core/approvals`.
- **Inbound**: `apps/api/src/routes/webhooks.ts` (signature-verified) ->
  `core/events` (`WHATSAPP.message_received`) -> `core/whatsapp/subscriber.ts`
  -> `core/whatsapp/ingest.ts` (mirrors `core/email/ingest.ts`).
- **Enforcement**: `whatsapp` is registered via the existing
  `toolRegistry.register()` - no new bypass, no parallel enforcement path.
  `core/enforcement`, `core/state`, `core/limits`, `core/ai/costControl.ts`,
  `core/worker/claim.ts`, `core/decision_engine`, `core/policy`, `core/auth`,
  `core/authz` are all **byte-for-byte untouched** since commit `0ef66f7`
  (`git diff --stat 0ef66f7 -- core/enforcement tools/registry.ts
  agents/registry.ts core/state core/limits core/ai/costControl.ts
  core/worker/claim.ts core/decision_engine core/policy core/auth core/authz`
  returns empty).

## 2. Which tables were generalized vs added

| Table | Change | Why |
|---|---|---|
| `Email` (`emails`) | `+channel` (default `"EMAIL"`), `+providerConversationId` | Every field (subject nullable, to/fromAddress, providerMessageId, idempotencyKey, riskCategory) already fit a WhatsApp message. Reused as the shared message log for both channels rather than a parallel `WhatsAppMessage` table. |
| `Communication` | none | `channel` was already a free string field from Phase 7 (`"email \| call \| sms \| whatsapp \| chat"`, documented in the schema comment). WhatsApp activity rows (`WHATSAPP_SENT`/`WHATSAPP_RECEIVED`) go through the SAME `recordActivity()`. |
| `SuppressedContact` | `normalizedEmail` relaxed to nullable, `+normalizedPhone` (unique) | Extends the existing suppression mechanism to a second identifier rather than a parallel WhatsApp-only suppression table. |
| `FollowUp` | `+channel` (default `"EMAIL"`) | Same dispatch pass/hourly job (`scheduleDueFollowUps`) now tags the Task `toolName: "email"` or `"whatsapp"` based on this field - no second scheduler. |
| `OutboundSendLog` | `+channel` (default `"EMAIL"`) | Observability/filtering only - `channel` is also folded into the idempotency-key hash basis itself (`computeChannelIdempotencyKey`), so cross-channel idempotency does not depend on this column. |
| `ApprovalRequest` | `+channel` (default `"EMAIL"`) | Filtering only; the actual channel/recipient/conversation detail already lives in `supportingContext` JSON (no schema change needed there - `core/approvals/index.ts` was not touched at all). |
| `Contact` | `+normalizedPhone` (nullable, non-unique, indexed) | E.164-style canonical phone form for dedup/identity - the gap Phase 7.1 explicitly disclosed and deferred. |

**No new WhatsApp-specific table was added.** Every genuinely new need (a
conversation-id concept, a canonical phone form) was an additive field on an
existing table.

## 3-4. WhatsApp provider abstraction

`tools/whatsapp/types.ts` defines `WhatsAppProvider`:
`getAccount / receiveMessages / getConversation / getMessage / sendMessage /
createDraft / markRead`. `tools/whatsapp/metaCloudProvider.ts` implements it
against the official WhatsApp Business Platform (Meta Cloud API, Graph API
`v19.0`) - **UNTESTED against the live API** (no credentials exist in this
sandbox), honestly returning `CONFIGURATION_REQUIRED` without
`WHATSAPP_ACCESS_TOKEN` / `WHATSAPP_PHONE_NUMBER_ID` /
`WHATSAPP_BUSINESS_ACCOUNT_ID` set (see `.env.example`). The Cloud API has no
"list inbox" endpoint (inbound is webhook-push only), so
`receiveMessages()`/`getConversation()` read from the local, webhook-ingested
`Email` rows instead of fabricating a provider capability that doesn't exist.
`tools/whatsapp/mockProvider.ts` (`MockWhatsAppProvider`) is the ONLY
provider any automated test exercises a send against.

## 5-6. Webhook + inbound trust boundary

`apps/api/src/routes/webhooks.ts`:
- `GET /webhooks/whatsapp`: the Cloud API's one-time verification handshake
  (`hub.verify_token` must exactly match `WHATSAPP_WEBHOOK_VERIFY_TOKEN`).
- `POST /webhooks/whatsapp`: verifies `X-Hub-Signature-256`
  (HMAC-SHA256 of the **raw** request body, keyed by `WHATSAPP_APP_SECRET`,
  constant-time compared - `core/whatsapp/webhook.ts`'s
  `verifyWebhookSignature()`) BEFORE touching the payload at all; rejects
  with 401 on mismatch, 503 if unconfigured (fail closed). Never logs the
  signature header or the app secret. Publishes one
  `WHATSAPP.message_received` typed event per message
  (`core/events/schemas.ts` gained a real `WHATSAPP` category) and returns a
  bare `{ ok: true }` - never internal state. Deduplication is the SAME
  mechanism as email: `Email.providerMessageId`'s DB unique constraint,
  enforced at persistence time in `core/whatsapp/ingest.ts`'s upsert.

**Trust boundary**: `core/research/trustBoundary.ts` gained
`wrapExternalWhatsAppContent()`, the same delimiter/labeling mechanism as
`wrapExternalContent()`/`wrapExternalEmailContent()`. **Honesty note**: there
is currently NO live LLM path that consumes WhatsApp message content at all
- intent classification (`core/business/whatsappIntent.ts`) and reply
drafting (`core/business/whatsappDraft.ts`) are both deterministic
pattern/template matching. `wrapExternalWhatsAppContent()` therefore has no
current call site; it exists so a future AI-assisted WhatsApp path (should
one be added, following the Phase 6.1 pattern) has nowhere else to go but
through the trust boundary. `core/whatsapp/ingest.test.ts` proves forged
authorization/approval/credential-reveal claims embedded in message text
never create an approval, never bypass suppression, and are only ever
classified as inert data.

## 7-9. Conversation threading, contact resolution, phone normalization

`core/whatsapp/conversation.ts`: deterministic conversation identity from
(business account id + provider conversation id, or business account id +
normalized phone as a fallback when the event carries no conversation id).
Contact resolution: normalized phone -> existing CRM mapping; an unparseable
number returns `UNRESOLVED_CONTACT` rather than guessing (never
auto-attached to an arbitrary contact - the ingested message row is still
persisted with `contactId: null` for later manual resolution).

`core/crm/dedup.ts`'s `normalizePhone()`: a dependency-free E.164-style
normalizer with explicit Pakistan handling (country code `92`,
leading-zero-stripping, `+92`/`0092`/`92`/bare-national-number/stray-local-0
variants), tolerant of spaces/hyphens/parens/dots, rejecting (never guessing)
anything it can't confidently resolve. 28 unit tests in
`core/crm/phone.test.ts` cover the exact variant shapes named in the brief.

## 10-11. Opt-out/suppression + communication preferences

Extends the EXISTING `SuppressedContact` table (`+normalizedPhone`) - not a
parallel table. `core/business/antiSpam.ts` gained
`isWhatsAppSuppressed()`/`suppressWhatsAppContact()` (phone-keyed siblings of
`isSuppressed()`/`suppressContact()`) and `isOptOutMessage()`: a short,
precise, exact-match phrase list (`stop`, `unsubscribe`, `remove me`, `do not
message`, `do not contact`, `opt out`) matched against the WHOLE trimmed
message, never a substring/fuzzy match - "please stop calling after 6pm"
does not trigger it (tested in `core/whatsapp/ingest.test.ts`).
**Design choice, documented honestly**: no separate transactional-vs-marketing
preference field was added - the existing suppressed/not-suppressed binary
already satisfies the hard requirement ("no outbound marketing after
opt-out"), and adding a second axis with nothing yet to differentiate on
would be unnecessary complexity.

## 12. Outbound WhatsApp safety pipeline (the anchor requirement)

`tools/whatsapp/whatsappTool.ts`'s `handleSend()`, same order as email's:
suppression/opt-out -> anti-spam/rate limit
(`checkWhatsAppAntiSpamLimits()`, same `OutboundSendLog` ledger and
Setting-backed config) -> idempotency (`computeChannelIdempotencyKey()` +
the SAME `reserveIdempotencyKey()`/`recordSendAttempt()` atomic mechanism) ->
outbound risk classification (`classifyOutboundEmail()`, called UNMODIFIED)
-> approval lookup (`core/approvals`, UNMODIFIED, `channel: "WHATSAPP"`
carried in `supportingContext`) -> the enforcement gate (automatic,
registered Tool) -> provider send -> audit -> CRM activity -> delivery
tracking.

**Provider send call-site count (verified)**:
```
$ grep -rn "\.sendMessage(" --include=*.ts core agents tools apps | grep -v "^[^:]*:[0-9]*: *//" | grep -v ".test.ts"
tools/whatsapp/whatsappTool.ts:305:  const result = await provider.sendMessage({ to, body, idempotencyKey });
tools/email/emailTool.ts:325:  const result = await provider.sendMessage({ to: [to], subject, body, idempotencyKey });
```
**Exactly 2**, one per channel, both inside their respective tool's own send
handler.

## 13-15. Risk classification, no financial autonomy, quotes

`core/business/outboundPolicy.ts` was NOT modified - `classifyOutboundEmail()`
is channel-agnostic BY CONSTRUCTION (risk depends on content, not channel);
the WhatsApp tool calls it with an empty `subject` and the message body.
`agents/no-autonomous-highrisk-send.test.ts` gained a mirrored
architectural + runtime proof suite for the WhatsApp path (17 tests total in
that file now). `agents/no-trading.test.ts`'s repo-wide scan (unmodified)
covers the new `core/whatsapp/`/`tools/whatsapp/` files too and passes with
zero matches. Quote preparation is NOT duplicated - the existing `Quote`
model/workflow (`core/business/quote.ts`) is channel-agnostic already; a
WhatsApp send of a quote notification goes through the same `whatsapp.send`
approval path as any other HIGH-risk WhatsApp message.

## 16-17. AI response generation, intent classification

**Deterministic only, this phase** - no AI-assisted WhatsApp drafting or
classification was built, matching Phase 7's own precedent and the brief's
explicit "start safely" instruction:
- `core/business/whatsappIntent.ts`: a thin adapter over
  `classifyEmailDeterministic()` (no duplicated keyword rules), mapping
  low-confidence/`GENERAL_REPLY` results to an explicit `UNKNOWN` outcome
  rather than force-classifying.
- `core/business/whatsappDraft.ts`: a thin adapter over `generateDraft()` /
  `validateDraftGrounding()` (the same configured-facts-only template
  generator email drafting uses), dropping the subject line for a
  chat-appropriate single body.

If AI-assisted WhatsApp drafting is added later, it must go through the
existing Phase 6.1 pattern (`core/ai/costControl.ts`, four-zone trust
boundary via `wrapExternalWhatsAppContent()`, grounding validation) - not a
second LLM call path.

## 18-23. CRM automation, lead pipeline, follow-ups, timeline, cross-channel protection

- CRM activities: `WHATSAPP_SENT`/`WHATSAPP_RECEIVED` added to
  `core/crm/pipeline.ts`'s `ACTIVITY_TYPES`, logged through the EXISTING
  `recordActivity()` - no forked activity system.
- Lead pipeline advancement (`core/whatsapp/ingest.ts`'s
  `maybeAdvanceLeadForContact()`): deterministic, explicit-intent-only -
  `SAMPLE_REQUEST` -> `SAMPLE_REQUESTED`, `PRICING_REQUEST` -> `QUOTING`,
  `COMPLAINT` -> `NURTURE` (conservative - routed to a human, not pushed
  forward); `UNKNOWN`/ambiguous intents never change lead status; closed
  (`WON`/`LOST`) leads are never touched.
- Follow-ups: `FollowUp.channel` (additive field) + the SAME
  `scheduleDueFollowUps()` dispatch pass now tags the Task
  `toolName: "email"` or `"whatsapp"` - no second scheduler.
- Unified timeline (item 21): `core/crm/activity.ts`'s
  `listUnifiedTimelineForContact()` - a read-model query over the existing
  channel-tagged `Communication` rows, exposed at
  `GET /crm/contacts/:id/timeline`. No new stored table.
- Cross-channel duplicate protection (item 22): `isFollowUpAllowed()`'s
  existing "customer replied since scheduling" check already queries
  `Communication` WITHOUT filtering by channel - it is naturally cross-channel
  once WhatsApp inbound messages also write a `Communication` row (which
  `core/whatsapp/ingest.ts` now does). Tested in both directions in
  `core/business/followUpWhatsApp.test.ts`.
- Cross-channel idempotency (item 23): `computeChannelIdempotencyKey()` folds
  `channel` into the hash basis - proven not to collide with the email key
  shape for the "same" recipient/content in
  `tools/whatsapp/whatsappTool.test.ts`.

## 24-25. Anti-spam, mass outbound

`checkWhatsAppAntiSpamLimits()` reuses the SAME `Setting`-backed
`AntiSpamConfig` and `OutboundSendLog` ledger as email (per-account daily
limit, per-contact cooldown; no per-domain check, since phone numbers have
no domain concept). **Mass outbound/broadcast campaigns are explicitly
NOT_IMPLEMENTED** - `whatsappTool.ts` rejects `isMassCampaign: true` outright
(status `ERROR`, not queued/gated) before any other check runs.

## 26-28. Attachments, voice notes, media/links

Attachment METADATA only (type/mimeType/filename) -
`core/whatsapp/webhook.ts`'s `normalizeInboundWebhookPayload()` never fetches
or interprets attachment content. Voice-note transcription:
**NOT_IMPLEMENTED** (no existing voice architecture to build on safely).
Links/media in message text are treated as untrusted plain text like any
other message content - never auto-fetched by the inbound processing path
itself.

## 29-31. Notifications, approval queue, attack tests

`core/notifications/index.ts` was NOT modified - `createApprovalRequest()`
(also unmodified) already calls `notificationService.create()`.
`ApprovalRequest.supportingContext` (JSON, already flexible) carries
`{ channel: "WHATSAPP", taskId, contactId, monetaryValue }` - no schema
change needed there. Attack tests (`agents/no-autonomous-highrisk-send.test.ts`,
17 WhatsApp-specific cases): no-approval, forged/nonexistent approval id,
rejected approval, expired approval (both at-decision and re-checked-at-send),
wrong-target approval, wrong-action approval, revoked approval, a
caller-supplied `approved: true` field (simply not part of the input schema
handling), and an APPROVED-but-since-suppressed request. All 17 pass; the
provider is never reached in any case.

## 32-34. Security audit, enforcement diff, authorization

- Grep for `skipApproval|forceSend|unsafeSend|adminOverride|bypass`: zero
  actual flags (only prose comments describing the ABSENCE of a bypass).
- Grep for `eval(`/`new Function(`: zero matches anywhere.
- `git diff --stat 0ef66f7` for every enforcement-critical path listed in
  section 1 above: empty (byte-for-byte untouched).
- Authorization: `apps/api/src/routes/webhooks.ts` is deliberately
  UNAUTHENTICATED by session (verified by provider signature instead - see
  item 5-6); every other new HTTP route (`GET /crm/contacts/:id/timeline`)
  goes through the existing `requireAuth`/`requireAuthz` middleware
  unmodified. Customer phone numbers/message content never become an
  `Identity` - `core/auth/identity.ts` was not touched, and nothing in
  `core/whatsapp/` constructs an `Identity` from inbound data. The existing
  Phase 3 role-enforcement tests (`core/authz/authz.test.ts`, unmodified)
  already prove an AGENT-kind identity cannot self-elevate to OWNER; nothing
  in this phase adds a second decision path that would need re-proving that.

## 35-36. Cost control, memory

No AI call was added this phase, so `core/ai/costControl.ts` has no new call
site to reuse (nothing to report beyond: it remains the only cost-controlled
path, untouched). Memory: `core/whatsapp/ingest.ts` writes only a durable,
classification-derived fact per new inbound message (category + confidence),
never the raw message body - same discipline as `core/email/ingest.ts`.

## 37-38. Business configuration, data minimization

WhatsApp drafting reads from the EXISTING `ProductCategory` model
(`core/crm/businessConfig.ts`) via the same `generateDraft()` function email
drafting uses - no new business-fact source. Data minimization: the only new
field collected is `Contact.normalizedPhone`, needed for WhatsApp identity
resolution.

## 39-44. Error handling, delivery states, events, worker, emergency stop

Provider errors (`CONFIGURATION_REQUIRED`/`TIMEOUT`/`PROVIDER_ERROR`/
`RATE_LIMITED`/`INVALID_RECIPIENT`) are surfaced honestly, never reported as
`OK`/sent (`tools/whatsapp/whatsappTool.test.ts` covers both a generic
provider failure and an invalid-recipient rejection). Delivery states in
this sandbox realistically stay at `SENT`/`FAILED` (no live Cloud API
webhook status callbacks are configured, since no credentials exist) - the
`Email.status` field is honest about this, never claiming `DELIVERED`/`READ`
without real provider evidence. `WHATSAPP.message_received` is a new typed
event category (`core/events/schemas.ts`), deduplicated by the
`Email.providerMessageId` unique constraint at persistence time, with no
business logic in the `publish()` call itself. WhatsApp follow-up Tasks go
through the EXISTING worker/claim/retry/watchdog machinery unmodified
(`core/worker/index.ts`'s `processClaimedTask()` needed no change - it
already dispatches any `toolName`-tagged task generically). Emergency stop:
`tools/whatsapp/whatsappTool.test.ts`'s last test proves `EMERGENCY_STOP`
halts a WhatsApp send at the registered-tool (enforcement-gate) level before
the provider is ever reached, mirroring Phase 6/7's exact pattern.

## 45-46. Dashboard, daily reports

`core/reports/dailyReport.ts` gained a `whatsapp` section (real counts:
messages sent/received today, pending/decided approvals, opt-outs today,
provider-configured flag) alongside the existing `emailCrm` section - both
now explicitly filtered by `channel`/`action` so neither double-counts the
other's rows on the shared `Email`/`ApprovalRequest` tables.
`apps/api/src/routes/crm.ts`'s dashboard gained
`pendingApprovalsByChannel` and `unresolvedWhatsAppContacts` (a real count of
inbound WhatsApp messages with no resolved contact). The `morning-briefing`
(`0 5 * * *`) and `daily-report` (`0 21 * * *`) jobs, both `Asia/Karachi`,
were NOT touched.

## 47. Testing

New test files (all against `MockWhatsAppProvider`/local logic - no live
network calls): `core/crm/phone.test.ts` (16 tests), `core/whatsapp/webhook.test.ts`
(13), `core/whatsapp/ingest.test.ts` (10), `tools/whatsapp/whatsappTool.test.ts`
(14), `core/business/followUpWhatsApp.test.ts` (5), plus the 12 new WhatsApp
cases appended to `agents/no-autonomous-highrisk-send.test.ts`. Full suite:
**513/513 passing** (444 baseline + 69 new), both typechecks clean, `prisma
validate` clean.

## 49-51. Migrations, docs, git discipline

One additive migration, `database/migrations/20260928162916_phase8_whatsapp_channel/`
(applied via `prisma migrate dev`, generated as a table-rebuild for SQLite's
`ADD COLUMN` limitations - no old migration file was edited). `prisma
generate`/`prisma validate` both clean. This document is the Phase 8 write-up;
`docs/PHASE7_EMAIL_CRM.md` was left as-is (its content remains accurate -
the generalization is additive and documented here, not a correction to what
Phase 7 said). Every commit this phase carries the
`Co-Authored-By`/`Claude-Session` trailer.

## 53.13 REAL / CONFIGURATION_REQUIRED / NOT_IMPLEMENTED

| Capability | Status | Notes |
|---|---|---|
| Meta Cloud API provider (send/receive/account) | **CONFIGURATION_REQUIRED** | Implemented against the documented API shape; untested live (no credentials in this sandbox). |
| Webhook signature verification | **REAL** | HMAC-SHA256 over raw body, constant-time compare, fails closed with no app secret. |
| Inbound ingestion, dedup, contact resolution | **REAL** | Mock-provider/local-payload tested. |
| Phone normalization | **REAL** | 16 unit tests against the named variant shapes. |
| Suppression / opt-out (phone-keyed) | **REAL** | Deterministic exact-phrase opt-out matching. |
| Outbound safety pipeline (suppression/anti-spam/idempotency/risk/approval) | **REAL** | Same mechanisms as email, channel-generalized. |
| Approval queue integration | **REAL** | `core/approvals` unmodified, reused as-is. |
| Deterministic intent classification | **REAL** | Thin adapter over the email classifier. |
| Deterministic reply drafting (templates) | **REAL** | Thin adapter over `generateDraft()`. |
| AI-assisted drafting/classification | **NOT_IMPLEMENTED** | Deterministic-only this phase, by design. |
| Lead pipeline auto-advancement | **REAL** | Deterministic, explicit-intent-only. |
| Follow-up scheduling/dispatch (WhatsApp channel) | **REAL** | Same dispatch pass as email, `channel` field. |
| Cross-channel duplicate/idempotency protection | **REAL** | Tested both directions. |
| Unified timeline | **REAL** | Read-model query, new route. |
| Daily report / dashboard WhatsApp metrics | **REAL** | Real DB counts, honest zero-state notes. |
| Mass outbound / broadcast campaigns | **NOT_IMPLEMENTED** | Rejected outright, not gated. |
| Voice-note transcription | **NOT_IMPLEMENTED** | No existing voice architecture. |
| Attachment content processing | **NOT_IMPLEMENTED (by design)** | Metadata only, permanently out of scope this phase. |
| Group chats / broadcast lists | **NOT_IMPLEMENTED** | Not built; conversation identity assumes 1:1. |

## 54-55. Stop conditions / non-goals

No stop condition was hit. Nothing in section 55's exclusion list
(browser/computer automation, telephony, trading/payment execution,
unrestricted autonomous messaging, mass campaigns, spam-evasion, WhatsApp Web
scraping) was built.
