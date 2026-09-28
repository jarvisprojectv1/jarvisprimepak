// core/state - Global JARVIS system state (Phase 2 / Step 3, part B).
//
// Persisted via the existing `settings` key-value table (no new tables
// needed): a handful of well-known keys hold the global state, the set of
// paused agents, and the set of disabled tools. Reads always go to the DB
// (no unsynchronized in-memory cache) so this is correct across multiple
// API processes sharing one SQLite file, at the cost of an extra query per
// gated call - an acceptable tradeoff at Phase 2 scale.
import { prisma } from "../../database/client";
import { log } from "../../security/logger";

export type SystemStateValue =
  | "RUNNING"
  | "PAUSED"
  | "MAINTENANCE"
  | "DEGRADED"
  | "EMERGENCY_STOP";

export interface SystemStateRecord {
  state: SystemStateValue;
  reason?: string;
  actor?: string;
  updatedAt: string;
}

const KEY_STATE = "system.state";
const KEY_PAUSED_AGENTS = "system.paused_agents";
const KEY_DISABLED_TOOLS = "system.disabled_tools";

async function readJson<T>(key: string, fallback: T): Promise<T> {
  const row = await prisma.setting.findUnique({ where: { key } });
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(key: string, value: unknown): Promise<void> {
  const json = JSON.stringify(value);
  await prisma.setting.upsert({
    where: { key },
    update: { value: json },
    create: { key, value: json },
  });
}

export async function getSystemState(): Promise<SystemStateRecord> {
  return readJson<SystemStateRecord>(KEY_STATE, {
    state: "RUNNING",
    updatedAt: new Date(0).toISOString(),
  });
}

export async function setSystemState(
  state: SystemStateValue,
  reason?: string,
  actor = "system"
): Promise<SystemStateRecord> {
  const record: SystemStateRecord = {
    state,
    reason,
    actor,
    updatedAt: new Date().toISOString(),
  };
  await writeJson(KEY_STATE, record);
  log("SECURITY", `system.state_change:${state}`, { reason, actor });
  return record;
}

async function getSet(key: string): Promise<Set<string>> {
  const arr = await readJson<string[]>(key, []);
  return new Set(arr);
}

async function addToSet(key: string, value: string): Promise<void> {
  const set = await getSet(key);
  set.add(value);
  await writeJson(key, Array.from(set));
}

async function removeFromSet(key: string, value: string): Promise<void> {
  const set = await getSet(key);
  set.delete(value);
  await writeJson(key, Array.from(set));
}

export async function pauseAgent(name: string, actor = "system"): Promise<void> {
  await addToSet(KEY_PAUSED_AGENTS, name);
  log("SECURITY", `system.agent_paused:${name}`, { actor });
}

export async function resumeAgent(name: string, actor = "system"): Promise<void> {
  await removeFromSet(KEY_PAUSED_AGENTS, name);
  log("SECURITY", `system.agent_resumed:${name}`, { actor });
}

export async function isAgentPaused(name: string): Promise<boolean> {
  const set = await getSet(KEY_PAUSED_AGENTS);
  return set.has(name);
}

export async function disableTool(name: string, actor = "system"): Promise<void> {
  await addToSet(KEY_DISABLED_TOOLS, name);
  log("SECURITY", `system.tool_disabled:${name}`, { actor });
}

export async function enableTool(name: string, actor = "system"): Promise<void> {
  await removeFromSet(KEY_DISABLED_TOOLS, name);
  log("SECURITY", `system.tool_enabled:${name}`, { actor });
}

export async function isToolDisabled(name: string): Promise<boolean> {
  const set = await getSet(KEY_DISABLED_TOOLS);
  return set.has(name);
}

/**
 * Emergency stop: sets system state to EMERGENCY_STOP, pauses every
 * currently-registered agent, and disables every currently-registered tool.
 *
 * Design note (documented per the task spec, which allows "your judgment"
 * here): Phase 2 takes the conservative position that NO tool in this
 * repository is safely exempt from an emergency stop. `files` can write
 * arbitrary sandboxed content, `email`/`calendar`/`voice`/`browser`/
 * `computer` are all either external-facing or NOT_IMPLEMENTED stubs for
 * capabilities that would be far riskier once real. Rather than guess which
 * future tool might be "read-only safe," emergency stop disables all tools;
 * an operator calls `recover()` and then explicitly re-enables/resumes
 * exactly what they intend to bring back. This trades a little convenience
 * for a much simpler, more auditable safety guarantee.
 */
export async function emergencyStop(actor: string, reason: string): Promise<void> {
  await setSystemState("EMERGENCY_STOP", reason, actor);

  // Lazy import to avoid a core/state <-> agents/tools circular dependency at
  // module-load time (agents/tools register through these modules).
  const { listAgents } = await import("../../agents/registry");
  const { toolRegistry } = await import("../../tools/registry");

  const agentNames = listAgents().map((a) => a.name);
  const toolNames = toolRegistry.list().map((t) => t.name);

  await writeJson(KEY_PAUSED_AGENTS, agentNames);
  await writeJson(KEY_DISABLED_TOOLS, toolNames);

  log("CRITICAL", "system.emergency_stop", { actor, reason, agentNames, toolNames });
}

/**
 * Safe recovery path: moves system state back to RUNNING. Does NOT
 * automatically resume paused agents or re-enable disabled tools - after an
 * emergency stop in particular, an operator should explicitly decide what to
 * bring back online rather than have everything silently reactivate.
 */
export async function recover(actor: string, reason?: string): Promise<SystemStateRecord> {
  return setSystemState("RUNNING", reason ?? "Manual recovery.", actor);
}

/** Convenience alias some callers may expect. */
export const resume = recover;
