# Phase 4 — Brain & Memory

This document covers what was added on top of Phase 3's Identity & Events
work: a completed AI provider layer, cost control, the JARVIS Core Brain, a
real Context Builder, an upgraded Memory system, structured Plans, an
upgraded Planner, two new agents, and Brain observability routes.

## 1. AI Provider Layer (`core/ai`)

`core/ai/provider.ts`'s `AIProvider` interface is unchanged in spirit
(`complete(messages)`), extended with a second `options` argument:

- **Timeout**: `AI_REQUEST_TIMEOUT_MS` env var (default 60000ms), passed to
  the Anthropic SDK's own per-request timeout.
- **Bounded retry with backoff**: up to `AI_MAX_RETRIES` (default 3)
  retries with exponential backoff (500ms, 1s, 2s, ...), but **only** on
  transient failures - HTTP 429 or 5xx, read from the real Anthropic SDK
  error's `.status` field. A 401/400/404 (permanent misconfiguration/invalid
  request) is never retried.
- **Real native tool-use**: `options.tools` is passed straight through to
  Anthropic's `tools` request parameter. The response's `tool_use` content
  blocks are parsed into `AIToolUse[]` - this is genuinely Anthropic's
  function-calling, not a text-parsing hack.
- **Real token/cost tracking**: `response.usage.input_tokens` /
  `output_tokens` are the SDK's own reported fields (never estimated), and
  `core/ai/pricing.ts` computes an **approximate** cost from a small,
  documented, comment-flagged per-model rate table (`MODEL_RATES`) - clearly
  not exact billing. Every call is persisted via `core/ai/usage.ts` to the
  new `AiUsage` Prisma model (provider, model, tokens, estimated cost, and
  optional `taskId`/`agentName` attribution).
- **Streaming**: honestly **not implemented**. The Anthropic SDK supports
  `messages.stream(...)`, but nothing built in this phase needs a token
  stream - the Brain needs one complete, parseable JSON tool-call response,
  not partial text. Rather than wire up a feature nobody calls, this is
  left as a documented gap, not a fabricated capability.
- **Secrets never logged**: the only things logged around a provider call
  are counts/model names/error messages, all passed through
  `security/logger.ts`'s `log()` (which redacts via `security/redact.ts`,
  already matching `sk-...` key shapes and long opaque tokens). No request/
  response body is ever logged.

## 2. Cost Control (`core/ai/costControl.ts`)

- `dailyLimitUsd` / `monthlyLimitUsd`, backed by the `settings` table (key
  `ai.cost_control`), sane defaults ($5/day, $50/month) if unset - same
  pattern as `core/limits`.
- `checkCostLimit(taskId?)` is called by the Brain **before** every LLM
  call. If either limit is already met (summed from real `AiUsage` rows for
  the current UTC day/month), **no API call is made**: a
  `notificationService.create()` (`ACTION_REQUIRED`) is raised, the
  associated task (if any) is moved to `WAITING` via
  `core/planner.updateTaskStatus`, and the check result carries a
  human-readable reason. Logged via `log("BUSINESS", ...)`.

## 3. The Brain (`core/brain`)

`Brain.handle(request, identity?)` implements, for one request: **OBSERVE
-> UNDERSTAND -> RETRIEVE -> PLAN -> POLICY CHECK -> EXECUTE -> VERIFY ->
REMEMBER -> REPORT**.

1. **OBSERVE**: `core/state.getSystemState()` is checked before anything
   else. `PAUSED`/`EMERGENCY_STOP` short-circuits to a `BLOCKED`
   `BrainResult` with zero LLM calls and zero side effects beyond that
   check.
2. **UNDERSTAND + RETRIEVE**: `core/context.buildBrainContext()` (see §4).
3. **Cost check**: `checkCostLimit()` before the LLM call.
4. **PLAN**: a single `AIProvider.complete()` call, with one synthetic tool
   definition, `propose_plan`, whose `input_schema` mirrors the Plan type.
   The model either replies in plain text (no action needed - the "simple
   chat" path, functionally identical to the pre-Brain orchestrator) or
   calls `propose_plan` with a structured plan as its **already-parsed JSON
   tool input** (real Anthropic tool-use, not a fragile "parse text as
   JSON" hack for the plan itself).
5. **Validate** (`core/brain/plan.ts`'s `validatePlan`): fails closed -
   zero steps, a step naming an unregistered tool/agent, a step naming both
   or neither, missing required fields, or a `dependsOn` reference to an
   unknown step id, all reject the **whole plan** before any step runs. A
   malformed-JSON tool input is treated identically (see `parseAndValidatePlan`,
   used by any caller working from raw text rather than a native tool-use
   payload).
6. **Task creation**: `core/planner.planFromPlan()` creates one parent Task
   (the goal) and one subtask per step (tagged with `stepId`/`agentName`/
   `toolName`).
7. **POLICY CHECK + EXECUTE** (`core/brain/runPlan.ts`): every step calls
   **only** `toolRegistry.execute(name, args, identity)` or
   `getAgent(name)!.run(args, identity)` - the exact same guarded objects
   `core/enforcement` already wraps at registration time. The Brain never
   evaluates policy itself and never holds a second, unguarded reference to
   a tool/agent. `core/brain/brain.test.ts` proves this the same way Phase
   2's `enforcement.test.ts` did: disabling a tool via `core/state` still
   blocks a Brain-driven step.
8. **Mid-run halting**: before starting the plan and before every dependent
   step, `core/state.getSystemState()` is re-checked; a pause/emergency-stop
   mid-plan halts all remaining dependent steps (marked `BLOCKED`) rather
   than running the rest of a multi-step plan. Proven by
   `core/brain/brain.test.ts`'s "pauses mid-plan" test (a tool that pauses
   the system as its own side effect, followed by a dependent step that
   must not run).
9. **Execution policy** (documented, simple-by-design, not a full DAG
   scheduler): steps with no `dependsOn` are "independent" and run
   concurrently as one `Promise.all` batch (bounded by the existing
   `core/limits` concurrent-agent limit, unchanged); steps with `dependsOn`
   run sequentially afterward, in plan order; a step whose dependency did
   not succeed is skipped (`BLOCKED`, "dependency did not succeed") rather
   than run.
10. **Failure handling**: a tool/agent error moves that step's Task through
    `core/planner.retryOrFailTask` (respecting `core/limits`' `retryLimit`,
    unchanged mechanism from Phase 2); a `NOT_IMPLEMENTED`/
    `CONFIGURATION_REQUIRED` result moves it to `WAITING` and the step's
    `BrainResultStatus` is `REQUIRES_TOOL` - **never** faked as `SUCCESS`.
    This is the literal "find me 50 apparel prospects" case from the spec:
    a plan step naming the `web` tool (no search provider configured)
    genuinely returns `REQUIRES_TOOL`, and the Brain's reply says so
    honestly instead of fabricating a prospect list - proven by
    `brain.test.ts`.
11. **Minimal single re-plan attempt**: if the *overall* plan run ends
    `FAILED` (not `WAITING`/`REQUIRES_TOOL`/`BLOCKED` - those aren't
    fixable by trying again with the same information), `Brain.handle()`
    calls itself **exactly once more**, with the failure surfaced in the
    request text, before returning to the caller. This is intentionally
    shallow - a single documented attempt, not a replanning loop - per the
    task's own "minimal is acceptable" guidance.
12. **REMEMBER**: the plan + step outcomes are persisted to `Memory`
    (`DECISION` namespace, `source: "brain"`, `relatedEntity` = the parent
    task id).
13. **REPORT**: a plain-text summary naming every step's status and detail
    - never claims a step succeeded that didn't.

**Personality/system prompt** (`core/brain/systemPrompt.ts`): a `Setting`-
backed string (key `brain.system_prompt`) with a sane default emphasizing
directness, honesty, and never fabricating certainty or a completed action;
never asks the model for hidden chain-of-thought (`reasoning_summary` in the
Plan schema is a short, user-facing summary).

### Why `/chat` now routes through the Brain

The Brain is a strict superset of the old `core/orchestrator`: a plain
conversational message that needs no tool/agent still produces the exact
same reply text (`completion.content`, verbatim) with the same memory
side-effects, so `apps/api/src/routes/chat.ts` was updated to call
`brain.handle()` instead of `orchestrator.handleChat()`. The existing
CONFIGURATION_REQUIRED chat test keeps passing unmodified. `core/orchestrator`
itself is left in place (untouched) rather than deleted, in case another
caller still wants the older, simpler direct-provider path, but no route
calls it anymore.

## 4. Context Builder (`core/context`)

`buildBrainContext(request, conversationId)` replaces the Phase 1 stub with
a bounded assembly, every category capped and documented in code:

- **Conversation history**: last 10 `CONVERSATION` memory entries for this
  conversation id.
- **Relevant memories**: deterministic keyword extraction from the request
  (lowercased, punctuation-stripped, words >3 chars, top 8 keywords) fed
  into `Memory.search()` per keyword, deduplicated, sorted by importance +
  recency, capped at top 10. **No embeddings/vector search** - explicit
  keyword/category matching only, per instruction.
- **Active tasks**: `core/planner.listTasks()` filtered to non-terminal
  statuses (`DONE`/`FAILED`/`CANCELLED` excluded), capped at 10.
- **Recent leads**: only included when the request looks business-related
  (a fixed keyword list - "lead", "client", "quote", "packaging", etc.),
  last 5 leads by `updatedAt`.
- **System state**: `core/state.getSystemState()`.
- **Available tools**: every registered tool that is not administratively
  disabled (`core/state.isToolDisabled`). Whether a tool is genuinely
  `NOT_IMPLEMENTED`/`CONFIGURATION_REQUIRED` is only knowable by actually
  calling it (that's the tool's own honest `ToolResult.status`), so the
  context builder cannot pre-filter those - the Brain's step execution
  handles that result honestly instead (§3, point 10).

## 5. Structured Plans (`core/brain/plan.ts`)

```ts
interface Plan {
  goal: string;
  reasoning_summary: string; // short, user-facing - never hidden chain-of-thought
  steps: PlanStep[];
  successCriteria: string;
}
interface PlanStep {
  stepId: string;
  description: string;
  agent?: string;   // mutually exclusive with tool
  tool?: string;     // mutually exclusive with agent
  arguments?: Record<string, unknown>;
  expectedResult: string;
  verification: string;
  dependsOn?: string[];
}
```

A Plan is **pure data**, exactly like `core/conditions`' condition trees -
never `eval`'d, never used to construct code. `validatePlan()` runs before
any step executes and rejects the whole plan (never partial execution) for:
zero steps, a missing/duplicate `stepId`, a step naming neither/both of
`agent`/`tool`, a step naming a tool/agent not in the live registry, a
malformed `arguments`/`dependsOn` shape, or a `dependsOn` reference to an
unknown step id. `parseAndValidatePlan(raw)` additionally tolerates a
fenced-code-block-wrapped JSON string and fails closed on malformed JSON.
11 dedicated tests in `core/brain/plan.test.ts`.

## 6. Planner upgrade (`core/planner`)

- `TaskInput` gained optional `stepId`/`agentName`/`toolName` (new nullable
  `Task` columns, migration `phase4_brain_memory`), so a Task created from a
  plan step can be traced back to it.
- New `planFromPlan(plan)`: creates one parent Task (the goal) plus one
  subtask per step, tagged with its `stepId`/`agentName`/`toolName`, and
  publishes the existing `task.created` event - reusing `planTask`'s
  underlying `prisma.task.create` shape rather than introducing a second
  task-creation code path.
- `updateTaskStatus`/`listTasks`/`retryOrFailTask` are unchanged - every
  existing caller (`/tasks` routes, `core/conditions`) keeps working
  untouched.

## 7. Memory upgrade (`core/memory`)

**Design choice** (documented per the task's "pick one coherent design"):
`content` (nullable string) is the new primary human-readable field; the
original `value` (JSON-encoded) stays as the structured payload. Both may be
set; `createMemory` requires at least one. This avoids breaking every
Phase 1-3 caller that only ever passed `value` while giving Phase 4 callers
a real free-text field.

New columns (migration `phase4_brain_memory`): `content`, `source`,
`confidence` (0-1, default 1), `relatedEntity`, `metadata` (JSON),
`expiresAt`, `updatedAt` (was missing before this phase). New namespace:
`DECISION` (10 total). Operations, old names kept as aliases so nothing
breaks:

| Spec name  | Implementation |
|---|---|
| `remember()` | alias of `createMemory` (append-only, archives prior ACTIVE entry for the same key) |
| `retrieve()` | alias of `readMemory` (excludes expired entries) |
| `search()`   | extended: `includeExpired`, `relatedEntity` filters added; still deterministic substring match, now also over `content` |
| `update()`   | unchanged (same archive-and-replace semantics) |
| `supersede()`| explicit first-class alias of `update()`/`createMemory()` - documented as intentionally the same code path, since there is exactly one way a memory is ever replaced |
| `forget()`/`expire()` | **new**: sets `expiresAt = now()`, never deletes the row. `search()`/`retrieve()` exclude expired entries by default; `history()` still returns them - matching the append-only philosophy |

All 6 original test assertions' intent is preserved in the updated
`core/memory/memory.test.ts` (now 10 tests: the 6 original plus DECISION
namespace, rich-field remember/retrieve, supersede, and forget coverage).

## 8. Agent coordination (`agents/`)

`AgentRunResult` gained `result` (alias of `data`), `evidence`, `errors`,
and `nextAction` as **additive, optional** fields - `summary`/`data` are
unchanged, and `core/enforcement.guardAgentExecution` only ever reads
`.status`, so this is a pure extension, not a breaking rename.
`ResearchAgent`/`CrmAgent` now populate `evidence`/`result`/`nextAction` on
every path.

Two new, real, DB-backed agents:

- **`TaskAgent`** (`agents/task-agent.ts`): wraps `core/planner`
  (`create`/`update_status`/`list`) so the Brain can delegate task
  bookkeeping to an agent call, same enforcement gate as any other agent.
- **`SystemAgent`** (`agents/system-agent.ts`): wraps `core/health` and
  `core/state` **read-only** queries. It cannot pause/stop/disable
  anything - those stay OWNER-only via the `/system` HTTP routes; this
  agent has no access to the mutating functions at all (not even imported).

**The "never SUCCESS with no evidence" contract**: `agents/contract.ts`'s
`checkAgentResultContract()` is a real, runtime-callable check (not just a
convention) that flags a `SUCCESS` result whose `evidence`/`data`/`result`
are all empty. `agents/contract.test.ts` proves it catches a fabricated
empty-evidence `SUCCESS` and passes every built-in agent's real `SUCCESS`
path. Honest limitation: this can only check "is evidence present," not "is
it true evidence of the claimed action" - the second half is enforced by
convention and code review, not a runtime type system.

## 9. Failure handling: status mapping

`BrainResultStatus` (`core/brain/types.ts`):
`SUCCESS | PARTIAL | FAILED | WAITING | REQUIRES_INFORMATION |
REQUIRES_TOOL | BLOCKED`. It is intentionally its own enum, not forced
identical to `AgentRunResult.status` or `Task.status` - they answer
different-grained questions. Rough mapping used by `core/brain`:

| BrainResultStatus | Derived from... | Task.status set to |
|---|---|---|
| `SUCCESS` | every step's tool/agent result succeeded | `DONE` |
| `PARTIAL` | some steps succeeded, at least one failed | `DONE` (parent) / mixed (subtasks) |
| `FAILED` | plan validation failed, or every step failed | `FAILED` |
| `WAITING` | cost limit hit, or a step needs configuration | `WAITING` |
| `REQUIRES_INFORMATION` | AI provider needs configuration (no API key) | (no task created yet) |
| `REQUIRES_TOOL` | a step named a `NOT_IMPLEMENTED`/`CONFIGURATION_REQUIRED` tool/agent | `WAITING` |
| `BLOCKED` | system `PAUSED`/`EMERGENCY_STOP`, or a step's tool/agent call was policy-`BLOCKED` | `BLOCKED` |

## 10. Dashboard/API observability (`apps/api/src/routes/brain.ts`)

- `GET /brain/tasks` - active vs. completed plan-derived tasks, each
  summarized as `{ id, goal, status, stepCount, stepsSummary, createdAt }`
  (`stepsSummary` is `{stepId, title, status}` per subtask) - never the raw
  plan JSON or any model reasoning text.
- `GET /brain/usage` - today's and this month's `AiUsage` totals (call
  count, token counts, estimated cost) plus the configured cost-control
  limits.

Both require authentication + the new `brain.read` authz action (granted to
OWNER and SYSTEM, matching the existing `system.health.read` pattern).

## 11. Known limitations (honest accounting)

- Re-planning is a single, shallow attempt (§3.11), not a loop - deeper
  replanning strategies are future work.
- The execution scheduler is "independent batch, then sequential," not a
  full dependency-graph scheduler - correct and simple for the plan sizes
  this phase targets, not optimal for a large plan with a complex dependency
  graph.
- Relevance ranking in the Context Builder is deterministic keyword
  matching, not semantic search - a request whose relevant memories don't
  share a keyword with it will miss them. This was an explicit instruction,
  not an oversight.
- The agent "never fake SUCCESS" contract is a runtime evidence-presence
  check, not a guarantee the evidence is genuine - that half relies on
  code review discipline.
- Cost control checks `AiUsage` rows written by the *same* process; like
  `core/limits`, this is correct for a single-process deployment and not a
  distributed rate limiter.
- Streaming is not implemented (§1) - an honest gap, not a stub pretending
  to stream.

## 12. Recommended next phase

A standing autonomous loop (Phase 5): a scheduler-driven or event-driven
loop that periodically re-invokes the Brain against active/waiting tasks
without a human message triggering each run, plus real event sources for
the still-reserved categories (CRM/EMAIL/WEB/MARKET/VOICE/CALENDAR) so the
Brain can react to real business events instead of only direct chat
requests.
