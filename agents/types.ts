// agents/types.ts - the AgentInterface every agent implements (spec section 26).
import type { Identity } from "../core/auth/identity";

export type AgentStatus = "IDLE" | "RUNNING" | "SUCCESS" | "FAILED" | "NOT_IMPLEMENTED";

/**
 * Phase 4 (Brain & Memory) standardizes AgentRunResult to include `evidence`
 * and `nextAction` per the master spec, while keeping the Phase 1-3 fields
 * (`summary`, `data`) working for every existing caller -
 * core/enforcement.guardAgentExecution only ever reads `.status`, so this is
 * a pure extension, not a breaking rename.
 *
 * Contract (documented, not always mechanically enforceable at runtime - see
 * agents/contract.ts for the one check that IS runtime-enforced): an agent
 * must never report status "SUCCESS" without real `evidence` describing what
 * it actually did. `evidence` should point at something concrete (a query
 * result, a row count, a created record id) - never a restatement of the
 * request.
 */
export interface AgentRunResult {
  status: AgentStatus;
  /** Short human-readable summary of what happened. */
  summary: string;
  /** Structured result data from the action actually taken (Phase 1-3 name). */
  data?: unknown;
  /** Alias for `data` under the Phase 4 spec's naming - always equal to `data` when set. */
  result?: unknown;
  /** Concrete evidence the claimed status is real (e.g. row ids, query counts, a tool's own result). Required for a true SUCCESS. */
  evidence?: unknown;
  /** Any errors encountered, even on a SUCCESS/PARTIAL result (e.g. one sub-step failed but the rest succeeded). */
  errors?: string[];
  /** What the agent recommends happens next (e.g. "needs a search provider", "retry after configuration"). */
  nextAction?: string;
}

export interface AgentInterface {
  name: string;
  objective: string;
  status: AgentStatus;
  // The second, optional `identity` parameter is populated by the
  // enforcement gate wrapper (core/enforcement.guardAgentExecution) at
  // registration time; a plain agent implementation only needs the one-arg shape.
  run(input?: Record<string, unknown>, identity?: Identity): Promise<AgentRunResult>;
}
