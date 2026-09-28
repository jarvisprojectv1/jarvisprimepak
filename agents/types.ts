// agents/types.ts - the AgentInterface every agent implements (spec section 26).
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
  run(input?: Record<string, unknown>): Promise<AgentRunResult>;
}
