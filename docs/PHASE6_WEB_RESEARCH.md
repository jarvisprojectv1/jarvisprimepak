# Phase 6: Web Research & Autonomous Intelligence

This phase adds controlled, honest web research capability on top of the
enforcement/policy/memory/worker infrastructure built in Phases 1-5. It does
**not** touch that infrastructure's core mechanisms - see "Untouched files"
at the end, verified with `git diff --stat`.

## 1. Web tool architecture

New package `tools/web/`:

- `types.ts` - `SearchProvider`, `SearchResult`, `ProviderError`,
  `FetchedPage` interfaces.
- `searchProvider.ts` - `BraveSearchProvider`, a real HTTP-backed
  implementation. **Honesty note: untested against the live Brave Search
  API** - no `BRAVE_SEARCH_API_KEY` credential is available in this sandbox.
  It is implemented carefully from Brave's documented request/response shape
  (a GET to `https://api.search.brave.com/res/v1/web/search` with an
  `X-Subscription-Token` header), with retry-on-429/5xx and a timeout, same
  pattern as `core/ai/provider.ts`. If the env var is unset, `search()`
  returns a typed `CONFIGURATION_REQUIRED` error - never a fabricated result.
- `searchTool.ts` - `WebSearchTool`, a thin `Tool` wrapper. Bounded result
  count (default 10, max 20), per-task search budget
  (`core/research/limits.ts`).
- `fetchTool.ts` - `WebFetchTool`. Enforces: protocol allowlist (http/https
  only), timeout, a hard redirect limit (manual redirect handling, not
  `fetch`'s automatic following), a streamed response-size cap (never
  buffers an unbounded body), a content-type allowlist
  (html/json/plain/xhtml), and reports `BLOCKED` (never bypasses) on a
  401/403/407/429 or content matching a bot-challenge/CAPTCHA pattern.
- `htmlExtract.ts` - dependency-light HTML text extraction: strips
  `<script>`/`<style>`/`<noscript>`/comments, extracts `<title>` and a
  `<link rel=canonical>` if present. No headless browser, no DOM library -
  intentionally simple, documented as such.
- `sourceResolver.ts` - `validateUrl` (protocol allowlist), `canonicalizeUrl`
  (strips tracking params, normalizes case/trailing slash/query order for
  dedup), `domainOf`.
- `mockSearchProvider.ts`, `testServer.ts` - test-only fakes (a fake
  `SearchProvider` and a local `http` server bound to `127.0.0.1` on an
  ephemeral port), never imported by production code.

Both tools are registered into `tools/registry.ts`'s `toolRegistry` in
`tools/index.ts`, so every call to them goes through the exact same
enforcement gate (`core/enforcement`) as every other tool: system state ->
per-tool disable -> rate limit -> policy -> execute -> audit. The old
`tools/web.ts` stub is left in place, unmodified - it still honestly reports
`CONFIGURATION_REQUIRED` for its own `action: "search"/"fetch"` shape; the
new tools are additive, named `web_search`/`web_fetch`.

## 2. Prompt-injection defense (the safety-critical part)

`core/research/trustBoundary.ts`:

- `wrapExternalContent(text, meta)` wraps any text extracted from a fetched
  page or search snippet in an explicit `===BEGIN
  EXTERNAL_WEB_CONTENT...===`/`===END...===` delimiter block, with source
  metadata (`source_url`, `source_title`, `retrieved_at`) and an explicit
  instruction that the content is data to quote/summarize, never an
  instruction - regardless of what it says. This is the **only** sanctioned
  way external web content may be interpolated into a prompt sent to
  `core/ai/provider.ts`.
- `scanForInjectionSignals`/`logInjectionSignalsIfAny` - a best-effort,
  **LOG-ONLY** pattern scan (never a blocking filter). Its only effect is a
  `SECURITY`-category log entry for human review. It is explicitly
  documented as *not* a security boundary - an attacker can trivially evade
  any fixed pattern list.
- **The real guarantee is architectural, not linguistic**: even a
  hypothetically "fully tricked" model can only ever respond with plain text
  or propose a `Plan` step (`core/brain/plan.ts`) naming a *registered*
  tool/agent. `validatePlan()` checks that name against the live
  `toolRegistry`/agent registry before anything runs, and execution then
  goes through the identical `core/enforcement` gate every other caller
  uses. Injected web content cannot invent a new tool, bypass authz/policy,
  or grant any capability beyond what a legitimate request could always
  reach. `core/research/trustBoundary.test.ts`'s test N constructs exactly
  this worst case (a fake "plan" embedded in scraped text naming a made-up
  `place_trade` tool) and proves `validatePlan()` rejects it because the
  tool isn't registered - not because of any content-based filtering.

## 3. Source provenance

New Prisma models (migration `phase6_web_research`):

- `ResearchRun` (query, status, createdBy, taskId?)
- `ResearchSource` (url, canonicalUrl, domain, contentHash, sourceType,
  belongs to a `ResearchRun`)
- `ResearchEvidence` (extractedText, classification, belongs to a
  `ResearchSource`)
- `ResearchTopic` (Business Intelligence tracked topics - DATA rows)
- `SkillCandidate` (see section 5)

Traceability contract: a `Memory` row written from research sets
`relatedEntity` to the **`ResearchEvidence.id`** it came from (never a task
id or source id directly - always the evidence row, the most specific
link). `core/research/provenance.traceMemoryProvenance(memory.relatedEntity)`
walks Evidence -> Source -> Run in one call; `GET
/research/provenance/:memoryId` exposes this over HTTP.

## 4. Research agent

`agents/research-agent.ts`: internal `Knowledge` table lookup first (unchanged
from Phase 1); if empty AND `web_search` is configured, formulates a query,
calls `WebSearchTool` (via the same `toolRegistry.execute()` path), dedups
results by canonical URL (max 3 sources), fetches each via `WebFetchTool`,
classifies each extracted snippet with `core/research/evidence.ts`'s
conservative heuristic (`FACT | SOURCE_CLAIM | ANALYSIS | UNCERTAINTY` - a
single source's claim is `SOURCE_CLAIM`, never auto-`FACT`), compares across
independent domains (`compareAcrossSources`, a keyword-overlap heuristic that
honestly reports `CONFLICT` rather than silently picking a side), persists
real `ResearchRun`/`ResearchSource`/`ResearchEvidence` rows, and writes one
`Memory` entry per evidence item with real `source`/`confidence`/
`relatedEntity`, using `supersede()` (via `Memory.remember`, which archives
any prior entry for the same key) rather than a raw overwrite. If search is
unconfigured, or every fetch fails, the agent returns `NOT_IMPLEMENTED` or
`WAITING` - never a fabricated evidence/memory entry (see
`agents/research-agent.test.ts`).

`agents/market-agent.ts` is the exact same plumbing with a fixed set of
forex/macro/gold/BTC query topics - informational monitoring only. See
section 6 for the no-trading proof.

## 5. Web event source (bounded polling)

`core/events/webEventSource.ts` makes the previously-reserved `WEB` event
category real. On a 60-second internal check interval, it looks at every
enabled `ResearchTopic` row and polls the ones due (never more often than
`core/research/limits.minTopicPollIntervalMinutes`, enforced regardless of a
topic's own configured interval). It calls `web_search` (the same guarded
tool), checks each result's canonical URL against `ResearchSource` for
"already known," and `publish()`es a `WEB.new_research_result` event for
anything genuinely new - **it never calls `toolRegistry.execute` for
anything but `web_search`, and never acts on what it finds directly**. A new
seeded `ConditionRule` (`web-new-research-result`) turns that event into a
task tagged `agentName: "research"`, which the worker then executes through
its existing, unmodified path. This preserves the EVENT -> CONDITION -> TASK
-> AGENT -> TOOL pipeline as the *only* route from "found something new" to
"an action happens."

## 6. Business Intelligence topics / Market Intelligence

`core/research/topics.ts` seeds the 14 example topics from the task spec
(apparel packaging, garment trims, hang tags, ..., packaging market
developments) as `ResearchTopic` **data rows**, editable via `POST/PATCH
/research/topics` - never hardcoded business logic in TypeScript.

`agents/market-agent.ts`: forex/macro/gold/BTC research and monitoring only.
**Proof of no trading capability**: `agents/no-trading.test.ts` (1) greps
every `.ts` file under `core/`, `agents/`, `tools/`, `apps/` for
trading/broker/order-placement/fund-movement identifiers (with one
documented, justified exclusion: `core/policy/index.ts`'s `BLOCKED_KEYWORDS`
list, which *names* these identifiers specifically so it can hard-block
them - evidence of protection, not capability) and (2) inspects the live
tool/agent registries for any such entry. There is no broker integration,
order-placement code, or credential storage of any kind anywhere in this
codebase.

## 7. Daily intelligence

`core/reports/dailyReport.ts` gained a `research` section: if a web search
provider is configured, it reports how many research runs and new
tracked-topic results happened that day; if not, it explicitly says "web
research capability is not configured... covers internal system status
only" - never fabricates "overnight monitoring."

## 8. Skill Discovery / Registry / Security - FOUNDATION ONLY

`core/skills/` implements a real lifecycle, with an explicit, deliberate
ceiling:

```
DISCOVERED -> CANDIDATE -> ANALYZING -> (REJECTED | TESTING)
  -> VERIFIED (OWNER-only) -> ACTIVATABLE -> ACTIVE (OWNER-only)
```

- **Discovery/candidacy** (`createCandidate`, `promoteToCandidate`): real DB
  rows, no code execution.
- **Static analysis** (`core/skills/staticAnalysis.ts`, called from
  `analyzeCandidate`): a real (if simple) regex scan over candidate source
  text for `eval(`, `new Function(`, `child_process`/`fs`/`net`/`http`/`vm`
  module requires, `process.exit/env/binding`, and computed dynamic
  `import()`. Any hit **rejects the candidate terminally** (`REJECTED`,
  `securityStatus: "REJECTED"`) - never merely flagged.
- **"Test in sandbox"** (`runTestingStub`): honestly `NOT_IMPLEMENTED`. A
  real code-execution sandbox for arbitrary discovered skill code is
  explicitly out of scope (the non-negotiables forbid "automatic execution
  of arbitrary downloaded code," and building even a sandboxed executor is a
  significant undertaking in its own right). `TESTING` is a real, reachable
  status; nothing in this phase actually runs candidate code to leave it.
- **Verification** (`verifyCandidate`) and **activation**
  (`activateSkill`) are both **OWNER-only**, enforced twice (the API route's
  `requireAuthz("skills.activate")` *and* a redundant check inside the
  registry function itself, so a bug in one layer doesn't remove the other).
- **`ACTIVE` does not wire anything up.** It is a tracked status field only.
  No dynamic `import()`/`require()`/`eval` of a skill's `source` happens
  anywhere in `core/skills/`. Turning a genuinely `ACTIVE` skill into a live,
  callable capability would require a dynamic code-loading mechanism - out
  of scope for this phase, and explicitly documented as a remaining
  limitation.

## 9. Memory integration

Verified: `agents/research-agent.ts` and `agents/market-agent.ts` both call
`Memory.remember()` (which internally is `createMemory`, and always archives
any existing `ACTIVE` entry for the same `(namespace, key)` before inserting
the new one - i.e. every write already goes through the append-only
supersede path; there is no separate "overwrite" operation in
`core/memory/index.ts` to accidentally call instead).

## 10. Deduplication

`core/research/dedup.ts`: `hashContent` (SHA-256 of trimmed/lowercased/
whitespace-collapsed text, for catching the same content at a different
URL), `shouldRefetch` (checks `ResearchSource.retrievedAt` against a
configurable refresh window before allowing a re-fetch), `isUnchanged`,
`isDuplicateContent`. Canonical-URL normalization for exact-URL dedup lives
in `tools/web/sourceResolver.ts` (reused, not duplicated).

## 11. Observability routes

- `GET /research/runs`, `GET /research/runs/:id` - list/detail with
  sources+evidence.
- `GET /research/provenance/:memoryId` - "where did you get this."
- `GET/POST/PATCH /research/topics` - Business Intelligence topic CRUD.
- `GET/PATCH /research/limits` - resource-control config.
- `GET /research/errors` - research-run status counts + recent
  `web_search`/`web_fetch` tool-call log entries (only `TOOL`-category
  entries are persisted to `system_logs` in this codebase - see
  `security/logger.ts` - so this reads those, not a separate error table).
- `GET /skills`, `GET /skills/:id`, `POST /skills`, and one route per
  lifecycle transition (`/promote`, `/analyze`, `/test`, `/verify`,
  `/mark-activatable`, `/activate`, `/reject`, `/disable`) - `/activate` and
  `/disable` require the new `skills.activate` authz action (OWNER only).

New `AuthzAction`s, added strictly additively to `core/authz/index.ts`:
`research.read`, `research.write`, `skills.read`, `skills.write`,
`skills.activate`.

## 12. Cost/resource limits

`core/research/limits.ts` (same `Setting`-backed pattern as
`core/limits/index.ts`, which is untouched): max searches/fetches per task
(checked inside `WebSearchTool`/`WebFetchTool` when a `taskId` is supplied),
max concurrent research jobs, minimum topic-poll interval (also enforced
inside `webEventSource.ts` regardless of a topic's own setting), and a
failed-fetch backoff (`isBackedOff`/`recordFetchFailure` - a URL that fails
`failureBackoffThreshold` times in a row is temporarily skipped rather than
hammered). LLM spend remains entirely governed by the untouched
`core/ai/costControl.ts` - search/fetch are plain HTTP calls, not LLM calls.

## 13. Failure states

No new enums invented. `ToolResult.status` (`OK|NOT_IMPLEMENTED|
CONFIGURATION_REQUIRED|ERROR|BLOCKED`) and `AgentRunResult.status` are reused
throughout. One additive extension: `AgentStatus` gained `WAITING` (a
transient, retryable blocker distinct from `NOT_IMPLEMENTED`'s "not built
yet") - every existing switch over `AgentStatus` already had a default/else
branch, so this is a non-breaking addition (`core/worker/index.ts`'s
`processClaimedTask` was updated additively to route it to the `WAITING`
task status, same as `NOT_IMPLEMENTED`).

## 14. Untouched files (verified with `git diff --stat`)

`core/enforcement/`, `tools/registry.ts`'s guarding, `core/state/`,
`core/limits/`'s existing functions, `core/policy/`, `core/ai/costControl.ts`,
`core/worker/claim.ts` - all **zero diff**. `agents/registry.ts` and
`core/authz/index.ts` have small, purely additive diffs (new imports/
registrations, new action names/role grants; no existing line removed or
changed).

## 15. Real vs. foundation-only vs. NOT_IMPLEMENTED (exhaustive)

**Real:**
- `WebFetchTool` against arbitrary real URLs (all its controls - timeout,
  redirect limit, size cap, content-type check, HTML extraction, canonical
  resolution, BLOCKED-on-challenge - exercised against a local mock HTTP
  server in tests, and will work identically against a real server).
- URL canonicalization/validation/dedup, content hashing, refresh-interval
  logic.
- Source provenance persistence and the full traceability chain.
- The research/market agents' end-to-end flow against a configured search
  provider (tested with a fake `SearchProvider` + the real fetch tool
  against a local server).
- The prompt-injection wrapping mechanism and the architectural
  non-bypass guarantee.
- The `WEB` event category, its bounded poller, and its condition-rule ->
  task path.
- Skill static analysis (`eval`/`child_process`/etc. detection) and the
  DISCOVERED..ACTIVATABLE/ACTIVE lifecycle's DB state machine + audit trail.
- The no-trading architectural proof.

**Untested-against-live-service (implemented, not verified live):**
- `BraveSearchProvider` - no API key available in this sandbox. Implemented
  from Brave's documented API shape; genuinely exercised only via the fake
  `SearchProvider` in tests.

**Foundation-only, explicitly not wired to a live capability:**
- Skill `ACTIVE` status - tracked only, no dynamic capability injection.
- Skill sandboxed testing - `NOT_IMPLEMENTED`, by deliberate scope decision.

**Still `NOT_IMPLEMENTED`/reserved (unchanged from earlier phases):**
- `EMAIL`, `VOICE`, `CALENDAR` event sources (`CRM` unchanged from Phase 3 -
  still relies on manual/test publishes). `MarketEventSource`'s own
  interface is still a stub even though `MarketAgent` exists as an on-demand
  agent - no scheduled market-news polling was built (only the topic-driven
  `WebEventSource`).

## 16. Remaining architectural limitations

- `BraveSearchProvider` is unverified against the live API - the exact JSON
  shape Brave returns could differ from what's implemented here in an edge
  case (e.g. an undocumented field), though the code fails safe (missing
  `title`/`url` are filtered out, not crashed on).
- `compareAcrossSources`'s agreement/conflict detection is a keyword-overlap
  heuristic, not semantic - a real NLP-based claim comparator is future
  work.
- The skill registry has no dynamic code-loading mechanism at all, by
  design - `ACTIVE` skills do not become live, callable capabilities in this
  phase.
- `core/limits`/`core/research/limits`'s per-task counters remain
  in-process, non-distributed (same documented limitation as Phase 2's rate
  limiter) - a multi-process deployment would need a shared store.
