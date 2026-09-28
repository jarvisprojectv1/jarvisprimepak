// core/brain/types.ts - shared Brain result types (Phase 4 / Brain & Memory).
//
// BrainResultStatus is deliberately its own enum, not forced to be identical
// to AgentRunResult.status or Task.status - the three answer different
// questions at different granularities. See docs/PHASE4_BRAIN_MEMORY.md
// section "Status mapping" for the full reconciliation table. Rough mapping
// used by core/brain/index.ts:
//
//   BrainResultStatus      <- derived from ...
//   SUCCESS                   every step's AgentRunResult/ToolResult succeeded
//   PARTIAL                   some steps succeeded, at least one failed/was skipped
//   FAILED                    plan validation failed, or all steps failed
//   WAITING                   a step's tool/agent needs configuration, or cost limit hit
//   REQUIRES_INFORMATION      missing required input to build/execute a plan
//   REQUIRES_TOOL             a step named a NOT_IMPLEMENTED tool/capability
//   BLOCKED                   system state (PAUSED/EMERGENCY_STOP) or policy BLOCKED a step
export type BrainResultStatus =
  | "SUCCESS"
  | "PARTIAL"
  | "FAILED"
  | "WAITING"
  | "REQUIRES_INFORMATION"
  | "REQUIRES_TOOL"
  | "BLOCKED";

export interface BrainStepOutcome {
  stepId: string;
  description: string;
  agent?: string;
  tool?: string;
  taskId?: string;
  status: BrainResultStatus;
  detail: string;
  evidence?: unknown;
}

export interface BrainResult {
  status: BrainResultStatus;
  /** User-facing reply text. */
  reply: string;
  /** Populated only when the Brain generated and (partially) ran a plan. */
  plan?: { goal: string; reasoning_summary: string; successCriteria: string };
  steps?: BrainStepOutcome[];
  taskId?: string;
  model?: string;
  configurationRequired?: boolean;
}
