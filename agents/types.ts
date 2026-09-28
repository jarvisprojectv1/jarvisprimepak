// agents/types.ts - the AgentInterface every agent implements (spec section 26).
import type { Identity } from "../core/auth/identity";

export type AgentStatus = "IDLE" | "RUNNING" | "SUCCESS" | "FAILED" | "NOT_IMPLEMENTED";

export interface AgentRunResult {
  status: AgentStatus;
  summary: string;
  data?: unknown;
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
