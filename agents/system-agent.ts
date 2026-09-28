// agents/system-agent.ts - a read-only agent wrapping core/health and
// core/state queries, so the Brain can ask "what's the system status" as a
// delegated agent call rather than reaching into those modules directly.
// Deliberately READ-ONLY: this agent cannot pause/stop/disable anything -
// that stays OWNER-only via the HTTP /system routes (apps/api/src/routes/system.ts).
import type { AgentInterface, AgentRunResult, AgentStatus } from "./types";
import { getSystemHealth } from "../core/health";
import { getSystemState } from "../core/state";
import { log } from "../security/logger";

type SystemAgentAction = "health" | "state";

export class SystemAgent implements AgentInterface {
  name = "system";
  objective = "Report system health and state to the Brain, read-only.";
  status: AgentStatus = "IDLE";

  async run(input: Record<string, unknown> = {}): Promise<AgentRunResult> {
    this.status = "RUNNING";
    const action = (input.action as SystemAgentAction) ?? "health";

    try {
      let result: AgentRunResult;
      if (action === "state") {
        const state = await getSystemState();
        result = {
          status: "SUCCESS",
          summary: `System state: ${state.state}.`,
          data: { state },
          result: { state },
          evidence: { state: state.state, updatedAt: state.updatedAt },
        };
      } else {
        const health = await getSystemHealth();
        result = {
          status: "SUCCESS",
          summary: `Overall system health: ${health.status}.`,
          data: { health },
          result: { health },
          evidence: { status: health.status, checkedAt: health.checkedAt },
        };
      }
      this.status = result.status;
      log("AGENT", "system-agent.run", { action, status: result.status });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.status = "FAILED";
      log("ERROR", "system-agent.error", { error: message });
      return { status: "FAILED", summary: message, errors: [message] };
    }
  }
}
