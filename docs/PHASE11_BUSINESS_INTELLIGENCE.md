# Phase 11: Advanced Business Intelligence & Decision Support

Read-only analytics/reporting over data the CRM already holds (Phases 6-10.1).
No new outbound-communication or browser-execution channel is added - the
outbound provider-send call-site count is unchanged at exactly 3
(`tools/email/emailTool.ts`, `tools/whatsapp/whatsappTool.ts`,
`tools/voice/voiceTool.ts` - verified by
`agents/phase11-bi-safety.test.ts`).

## What was built

All new code lives under `core/business/intelligence/` (additive-only
directory) plus one new tool (`tools/businessIntelligence.ts`) and small,
additive extensions to six existing files (`apps/api/src/index.ts`,
`core/conditions/rules.ts`, `core/reports/dailyReport.ts`,
`database/schema.prisma`, `scheduler/index.ts`, `tools/index.ts`) - see
`git diff --stat 7d10426` for the exact, small diff. No file under
`core/enforcement`, `core/state`, `core/limits`, `core/ai/costControl.ts`,
`core/worker/claim.ts`, `core/decision_engine`, `core/policy`, `core/auth`,
or `core/authz` was touched.

### Core taxonomy (section 2)

`core/business/intelligence/types.ts` - every BI statement is tagged
`FACT | OBSERVATION | CALCULATION | FORECAST | INFERENCE | RECOMMENDATION |
UNKNOWN`, carries its `provenance` (source ids, date range, calculation
method), and never fabricates a number for missing data (`UNKNOWN` with
`value: null` instead).

### Business config (section 3)

`core/business/intelligence/companyProfile.ts` - Prime Pak's own facts as
Setting-backed data, with the "Backed by 25+ years ... via its production
backbone (MM Printing Agency)" phrasing as the ONLY allowed wording, and
`checkForDisallowedClaims()` + `companyProfile.test.ts` mechanically
asserting the "Prime Pak itself has 25+ years" claim never appears. Seeded
idempotently at boot (`seedCompanyProfile()`), same pattern as Phase 7's
`seedDefaultProductCategories()`.

### BI modules implemented

- **Sales/Lead/Pipeline Intelligence** (`salesFunnel.ts`, sections 10-13):
  live funnel over the real `LEAD_STATUSES` pipeline, pipeline conversion,
  hedged `PIPELINE_RISK` staleness findings, fully explainable itemized lead
  scoring (extends `core/crm/qualification.ts`'s discipline, never a bare
  number).
- **Customer Intelligence + Timeline + Communication Intelligence**
  (`customerIntelligence.ts`, sections 14-16): real `Communication` timeline,
  per-contact rollups, response-rate proxy.
- **Follow-up Intelligence** (`followUpIntelligence.ts`, section 17): reuses
  the exact "any inbound Communication since the last outbound message"
  check `core/business/followUp.ts`'s `isFollowUpAllowed()` already
  performs - a replied-to lead is never a candidate. This module only
  *identifies* candidates; it never creates a `FollowUp`/`Task` or calls any
  send function.
- **Product Intelligence** (`productIntelligence.ts`, sections 18-19): real
  quote-volume metrics; per-category demand is honestly `UNKNOWN` (`Quote`
  has no structured `ProductCategory` link - never keyword-guessed).
- **Data Quality Engine** (`dataQuality.ts`, sections 42-43): reads
  `possibleDuplicate` flags `core/crm/dedup.ts` already maintains (no second
  dedup algorithm) plus missing-required-field counts.
- **Anomaly Detection** (`anomalyDetection.ts`, section 27): deterministic
  threshold rules (>=50% drop / >=200% spike vs. the prior equal-length
  window) over real counts - no ML/statistics library.
- **Forecasting** (`forecasting.ts`, sections 28-30, lower priority):
  minimal, honest - a simple moving average over historical windows with an
  explicit `LOW|MEDIUM|HIGH` confidence label derived from data volume,
  never a bare projected number.
- **Recommendation Engine** (`recommendations.ts`, sections 35-37):
  structured `Recommendation` (evidence, reason, expected impact, risks,
  required info, confidence, `INFORMATIONAL|LOW|MEDIUM|HIGH` priority).
  **Never executes anything** - see its file header and the architectural
  test below.
- **Executive Briefing + scheduler integration** (`executiveBriefing.ts`,
  `snapshot.ts`, sections 8, 31-34): a real, immutable, idempotent-per-period
  `BusinessSnapshot` (new Prisma model, additive migration
  `20260928183754_phase11_business_intelligence`), deterministic-first
  briefing assembly, and an optional AI narrative. `core/reports/dailyReport.ts`
  gained one new `businessIntelligence` section (extends the existing report,
  never a second report generator). A new `weekly-review` scheduler job
  (Monday 06:00 Asia/Karachi) was registered via the EXACT
  `scheduler.register()` pattern `morning-briefing`/`daily-report` already
  use, with its own `ConditionRule` (`core/conditions/rules.ts`) creating a
  task tagged `toolName: "business_intelligence"` - the two existing jobs'
  schedules (`0 5 * * *` / `0 21 * * *`, both `Asia/Karachi`) were not
  touched.
- **AI synthesis + grounding** (`synthesis.ts`, `biGroundingValidator.ts`,
  sections 49-52, 61): reuses `core/ai/costControl.ts`'s `checkCostLimit()`,
  omits `tools` from the completion call (same no-tools guarantee as
  `core/research/synthesis.ts`), wraps any research-derived input through
  `core/research/trustBoundary.ts`'s `wrapExternalContent()`, and validates
  every output claim through `biGroundingValidator.ts` - a structurally
  identical sibling of `core/research/groundingValidator.ts` (empty
  citations rejected; any unknown statement id rejects the whole claim,
  all-or-nothing). `synthesis.test.ts` includes the required scenario: a
  claim citing an invented statement id is proven rejected, and a real claim
  mixed with a fabricated one keeps only the real one.
- **Memory integration** (`memoryIntegration.ts`, sections 38-40, 69): only
  `FACT`-typed statements are written to `Memory` (namespace `BUSINESS`) as
  confirmed facts (confidence 1, key prefix `bi:fact:`); a
  `FORECAST`/`INFERENCE`/`RECOMMENDATION` is written, only if explicitly
  opted in, as a distinctly-keyed, lower-confidence assumption
  (`bi:assumption:`) - never conflated with a confirmed fact.
- **Query safety / Brain tool** (`tools/businessIntelligence.ts`, section
  46): a read-only tool registered through the normal `toolRegistry`, with
  no code path reaching any send/call/browser function - verified by
  `agents/phase11-bi-safety.test.ts`.

### Time windows (section 9)

`timeWindows.ts` resolves `TODAY|YESTERDAY|THIS_WEEK|LAST_WEEK|THIS_MONTH|
LAST_MONTH|THIS_QUARTER|LAST_QUARTER|CUSTOM` against Asia/Karachi using the
same fixed-UTC+5-no-DST fact `scheduler/index.ts` already verified and
documented - never implicit server-local time.

## Outbound/financial/browser safety verification (sections 54-56, 75E/F/G)

`agents/phase11-bi-safety.test.ts`:
- **(E)**: a repo-wide, comment-stripped grep for `provider.sendMessage(`/
  `provider.createCall(` finds exactly 3 call sites, all inside the three
  pre-existing outbound tools - unchanged from the Phase 9/10 baseline.
- **(F)**: every Phase 11 BI file is scanned for the same
  financial/trading-execution-shaped identifiers `agents/no-trading.test.ts`
  already checks repo-wide - none found.
- **(G)**: every Phase 11 BI file is scanned for a direct browser-provider
  reference or a direct `toolRegistry.execute("browser", ...)` call - none
  found (Market/Competitor Intelligence's browser-based research, sections
  24-25, is deferred - see below - so BI never touches the browser tool at
  all in this phase).
- **Query safety**: `tools/businessIntelligence.ts` itself is scanned and
  contains no send/call/browser call site.

`agents/no-trading.test.ts` and `agents/no-browser-financial-bypass.test.ts`
were re-run unmodified and still pass (Phase 11 added no financial
capability and did not touch `core/business/browserPolicy.ts`).

## What was deferred (honest, per this phase's own triage instructions)

- **Market/Competitor Intelligence** (sections 24-25): no browser-based
  competitor research was built. If added later, it must reuse the existing
  `browser` tool through `toolRegistry.execute()`'s normal enforcement path
  (never a privileged BI-only bypass) and `core/business/browserPolicy.ts`'s
  financial hard-block, exactly as this phase's spec requires.
- **Revenue/Margin/Production Intelligence** (sections 21-23): not built -
  the schema has no verified revenue/margin/capacity data source to compute
  these from honestly (Quote.total is only sometimes computed, and there is
  no cost-of-goods/production-capacity table). Building this without a real
  data source would mean fabricating numbers, which this phase's own
  section 59 forbids.
- **Business Assumptions/Experiments as a dedicated tracked entity**
  (sections 40-41): the FACT-vs-assumption *distinction* is implemented
  (`memoryIntegration.ts`), but no dedicated "Experiment" tracking model/
  workflow was built.
- **Knowledge Graph** (section 44) and **Dashboard** (section 66): not
  built - explicitly lower priority per the phase's own triage instruction.
  `tools/businessIntelligence.ts`'s structured JSON outputs are
  dashboard-ready for a future UI to consume.
- Full breadth of all 15 possible "BI modules" and all 76 numbered sections
  was not attempted; the above list is what was prioritized and actually
  built, matching Phase 9/10's own precedent of reporting deferred breadth
  plainly.

## Database

One additive migration: `20260928183754_phase11_business_intelligence`
(`BusinessSnapshot` model - `CREATE TABLE` + two indexes, no changes to any
existing table). `npx prisma migrate deploy` (this repo's existing `pretest`
step) applies it like any other migration.

## Testing

63 new tests across `core/business/intelligence/*.test.ts` and
`agents/phase11-bi-safety.test.ts`. Full suite: 698/698 passing (635
pre-existing + 63 new), `npx tsc --noEmit` clean at the repo root and inside
`apps/api`.
