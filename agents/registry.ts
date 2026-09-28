// agents/registry.ts - a small in-memory registry of available agents, in
// the same spirit as the tool registry.
import type { AgentInterface } from "./types";
import { ResearchAgent } from "./research-agent";
import { CrmAgent } from "./crm-agent";
import { TaskAgent } from "./task-agent";
import { SystemAgent } from "./system-agent";
import { guardAgentExecution } from "../core/enforcement";

const agents = new Map<string, AgentInterface>();

export function registerAgent(agent: AgentInterface): void {
  // As with tools/registry.ts: mutate the agent object's own `run` in place
  // so an agent cannot self-declare permission and no caller - including one
  // holding a direct reference to the agent instance - can reach an
  // unguarded `run()`. Every run passes through the state gate, rate/
  // concurrency limits, and the Autonomy Policy Engine first.
  const original = agent.run.bind(agent);
  agent.run = guardAgentExecution(agent.name, original);
  agents.set(agent.name, agent);
}

export function getAgent(name: string): AgentInterface | undefined {
  return agents.get(name);
}

export function listAgents(): AgentInterface[] {
  return Array.from(agents.values());
}

let registered = false;
export function registerBuiltinAgents(): void {
  if (registered) return;
  registerAgent(new ResearchAgent());
  registerAgent(new CrmAgent());
  registerAgent(new TaskAgent());
  registerAgent(new SystemAgent());
  registered = true;
}

export type { AgentInterface, AgentRunResult, AgentStatus } from "./types";
