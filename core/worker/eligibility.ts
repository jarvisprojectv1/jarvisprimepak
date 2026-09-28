// core/worker/eligibility.ts - deterministic task-eligibility pre-filter
// (Phase 5 / Autonomous Worker).
//
// This is a PRE-FILTER, not a second enforcement gate: the real,
// authoritative checks (state/pause/disable/rate/policy) still run inside
// core/enforcement when the worker actually calls a tool/agent/Brain. This
// function exists to avoid wasted Brain/tool invocations by predicting,
// cheaply, whether a call would be refused - and to give a WAITING/BLOCKED
// task an honest, persisted reason instead of just silently never running.
import type { PlannedTask } from "../planner";
import { getLimitsConfig } from "../limits";
import { peekToolRate, peekAgentRate } from "../limits";
import { getSystemState, isAgentPaused, isToolDisabled } from "../state";
import { evaluatePolicy } from "../policy";
import { toolRegistry } from "../../tools/registry";
import { getTask } from "../planner";

export type EligibilityCategory = "SKIP" | "WAITING" | "BLOCKED";

export interface EligibilityResult {
  eligible: boolean;
  reason?: string;
  /**
   * When ineligible: WAITING for a transient/informational blocker (system
   * paused, rate-limited, scheduled for later, cost/config), BLOCKED for a
   * policy/system-disable blocker, SKIP when the task simply isn't in an
   * eligible status at all (already terminal, or already WAITING/BLOCKED -
   * no status transition should be made for SKIP).
   */
  category?: EligibilityCategory;
}

const ELIGIBLE_STATUSES = new Set(["PENDING", "QUEUED", "RETRYING"]);

function eligible(): EligibilityResult {
  return { eligible: true };
}
function waiting(reason: string): EligibilityResult {
  return { eligible: false, reason, category: "WAITING" };
}
function blocked(reason: string): EligibilityResult {
  return { eligible: false, reason, category: "BLOCKED" };
}
function skip(reason: string): EligibilityResult {
  return { eligible: false, reason, category: "SKIP" };
}

export interface EligibilityOptions {
  now?: Date;
}

/**
 * Checks, in order: status, scheduled time, dependency (parent task),
 * system state, retry backoff/limit, agent pause, tool
 * existence/disablement, autonomy policy pre-check, rate-limit pre-check.
 * The FIRST failing check wins (fail fast, single clear reason).
 */
export async function isTaskEligible(task: PlannedTask, options: EligibilityOptions = {}): Promise<EligibilityResult> {
  const now = options.now ?? new Date();

  if (!ELIGIBLE_STATUSES.has(task.status)) {
    return skip(`Task status "${task.status}" is not a worker-eligible status.`);
  }

  if (task.dueAt && task.dueAt.getTime() > now.getTime()) {
    return waiting(`Scheduled for ${task.dueAt.toISOString()}, not due yet.`);
  }

  if (task.parentId) {
    const parent = await getTask(task.parentId);
    if (parent && parent.status !== "DONE") {
      return blocked(`Waiting on parent task "${parent.title}" (${parent.status}) to complete.`);
    }
  }

  const state = await getSystemState();
  if (state.state !== "RUNNING") {
    return waiting(`System is ${state.state}, not RUNNING.`);
  }

  const limits = await getLimitsConfig();
  if (task.status === "RETRYING" && task.retryCount >= limits.retryLimit) {
    return blocked(`Retry limit (${limits.retryLimit}) already reached.`);
  }
  if (task.status === "RETRYING") {
    // Bounded exponential backoff between retry attempts (never hammer a
    // failing task back-to-back): 2^retryCount seconds, capped at 5 minutes.
    const backoffMs = Math.min(30_000 * 2 ** task.retryCount, 5 * 60 * 1000);
    const readyAt = task.updatedAt.getTime() + backoffMs;
    if (now.getTime() < readyAt) {
      return waiting(`Retry backoff active; next attempt eligible at ${new Date(readyAt).toISOString()}.`);
    }
  }

  if (task.agentName) {
    if (await isAgentPaused(task.agentName)) {
      return blocked(`Agent "${task.agentName}" is paused.`);
    }
  }

  if (task.toolName) {
    const tool = toolRegistry.get(task.toolName);
    if (!tool) {
      return blocked(`Tool "${task.toolName}" is not registered.`);
    }
    if (await isToolDisabled(task.toolName)) {
      return blocked(`Tool "${task.toolName}" is disabled.`);
    }
  }

  // Cheap autonomy-policy pre-check. The real, authoritative policy check
  // still runs inside core/enforcement at execution time - this only avoids
  // starting a Brain/tool call we already know would be BLOCKED.
  const policyName = task.toolName ?? task.agentName ?? task.title;
  const policyResult = evaluatePolicy(policyName, {
    toolName: task.toolName ?? undefined,
    agentName: task.agentName ?? undefined,
  });
  if (policyResult.level === "BLOCKED") {
    return blocked(`Autonomy policy would block this action: ${policyResult.reason}`);
  }

  if (task.toolName && !(await peekToolRate(task.toolName))) {
    return waiting(`Tool "${task.toolName}" is currently rate-limited.`);
  }
  if (task.agentName && !(await peekAgentRate(task.agentName))) {
    return waiting(`Agent "${task.agentName}" is currently rate-limited.`);
  }

  return eligible();
}
