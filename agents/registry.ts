// agents/registry.ts - a small in-memory registry of available agents, in
// the same spirit as the tool registry.
import type { AgentInterface } from "./types";
import { ResearchAgent } from "./research-agent";
import { CrmAgent } from "./crm-agent";

const agents = new Map<string, AgentInterface>();

export function registerAgent(agent: AgentInterface): void {
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
  registered = true;
}

export type { AgentInterface, AgentRunResult, AgentStatus } from "./types";
