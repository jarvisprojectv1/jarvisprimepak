// core/brain/runPlan.ts - executes a validated Plan's steps, ALWAYS through
// the existing tools/registry + agents/registry (which are already wrapped
// by core/enforcement) - never a bypass path. Sequential execution is the
// safe default; steps with no `dependsOn` are treated as independent and run
// concurrently as one batch (not a full DAG scheduler - see
// docs/PHASE4_BRAIN_MEMORY.md for the documented policy).
import { toolRegistry } from "../../tools/registry";
import { getAgent } from "../../agents/registry";
import { updateTaskStatus, retryOrFailTask, type PlannedTask } from "../planner";
import { getLimitsConfig } from "../limits";
import { getSystemState } from "../state";
import { log } from "../../security/logger";
import type { Identity } from "../auth/identity";
import type { Plan, PlanStep } from "./plan";
import type { BrainResultStatus, BrainStepOutcome } from "./types";

export interface RunPlanResult {
  status: BrainResultStatus;
  steps: BrainStepOutcome[];
  haltedForSystemState?: string;
}

function taskStatusFor(outcomeStatus: BrainResultStatus): "DONE" | "WAITING" | "BLOCKED" | "FAILED" | "RETRYING" {
  switch (outcomeStatus) {
    case "SUCCESS":
      return "DONE";
    case "REQUIRES_TOOL":
    case "WAITING":
      return "WAITING";
    case "BLOCKED":
      return "BLOCKED";
    default:
      return "FAILED";
  }
}

async function isHalted(): Promise<string | null> {
  const state = await getSystemState();
  if (state.state === "PAUSED" || state.state === "EMERGENCY_STOP") return state.state;
  return null;
}

async function executeStep(
  step: PlanStep,
  taskId: string | undefined,
  identity: Identity | undefined,
  retryLimit: number
): Promise<BrainStepOutcome> {
  let outcomeStatus: BrainResultStatus;
  let detail: string;
  let evidence: unknown;

  try {
    if (step.tool) {
      const result = await toolRegistry.execute(step.tool, step.arguments ?? {}, identity);
      evidence = result.data ?? { message: result.message };
      if (result.status === "OK") {
        outcomeStatus = "SUCCESS";
        detail = result.message;
      } else if (result.status === "NOT_IMPLEMENTED" || result.status === "CONFIGURATION_REQUIRED") {
        outcomeStatus = "REQUIRES_TOOL";
        detail = `Tool "${step.tool}" is not usable yet: ${result.message}`;
      } else if (result.status === "BLOCKED") {
        outcomeStatus = "BLOCKED";
        detail = result.message;
      } else {
        outcomeStatus = "FAILED";
        detail = result.message;
      }
    } else if (step.agent) {
      const agent = getAgent(step.agent);
      if (!agent) {
        outcomeStatus = "FAILED";
        detail = `Agent "${step.agent}" is not registered (should have been caught by plan validation).`;
      } else {
        const result = await agent.run(step.arguments ?? {}, identity);
        evidence = result.evidence ?? result.result ?? result.data;
        if (result.status === "SUCCESS") {
          outcomeStatus = "SUCCESS";
          detail = result.summary;
        } else if (result.status === "NOT_IMPLEMENTED") {
          outcomeStatus = "REQUIRES_TOOL";
          detail = result.summary;
        } else {
          outcomeStatus = "FAILED";
          detail = result.summary;
        }
      }
    } else {
      outcomeStatus = "FAILED";
      detail = "Step named neither a tool nor an agent (should have been caught by plan validation).";
    }
  } catch (err) {
    outcomeStatus = "FAILED";
    detail = err instanceof Error ? err.message : String(err);
  }

  if (taskId) {
    const nextStatus = taskStatusFor(outcomeStatus);
    if (nextStatus === "FAILED") {
      await retryOrFailTask(taskId, retryLimit);
    } else {
      await updateTaskStatus(taskId, nextStatus);
    }
  }

  log("ACTION", "brain.step_outcome", { stepId: step.stepId, status: outcomeStatus, tool: step.tool, agent: step.agent });

  return { stepId: step.stepId, description: step.description, agent: step.agent, tool: step.tool, taskId, status: outcomeStatus, detail, evidence };
}

function overallStatus(outcomes: BrainStepOutcome[]): BrainResultStatus {
  if (outcomes.length === 0) return "FAILED";
  if (outcomes.some((o) => o.status === "BLOCKED")) return "BLOCKED";
  if (outcomes.every((o) => o.status === "SUCCESS")) return "SUCCESS";
  if (outcomes.some((o) => o.status === "REQUIRES_TOOL")) {
    return outcomes.every((o) => o.status === "SUCCESS" || o.status === "REQUIRES_TOOL")
      ? "REQUIRES_TOOL"
      : "PARTIAL";
  }
  if (outcomes.some((o) => o.status === "SUCCESS")) return "PARTIAL";
  return "FAILED";
}

/**
 * Runs every step of a validated Plan, checking system state (PAUSED /
 * EMERGENCY_STOP) before starting AND between steps/batches - a Brain run
 * started while paused, or paused mid-way, halts additional steps rather
 * than plowing through the rest of a multi-step plan.
 */
export async function runPlan(
  plan: Plan,
  taskIdByStep: Map<string, string>,
  identity?: Identity
): Promise<RunPlanResult> {
  const limits = await getLimitsConfig();
  const outcomes: BrainStepOutcome[] = [];
  const failedOrBlocked = new Set<string>();

  const halted = await isHalted();
  if (halted) {
    for (const step of plan.steps) {
      outcomes.push({
        stepId: step.stepId,
        description: step.description,
        agent: step.agent,
        tool: step.tool,
        taskId: taskIdByStep.get(step.stepId),
        status: "BLOCKED",
        detail: `System is ${halted}; no steps were started.`,
      });
    }
    return { status: "BLOCKED", steps: outcomes, haltedForSystemState: halted };
  }

  const independentSteps = plan.steps.filter((s) => !s.dependsOn || s.dependsOn.length === 0);
  const dependentSteps = plan.steps.filter((s) => s.dependsOn && s.dependsOn.length > 0);

  if (independentSteps.length > 0) {
    const results = await Promise.all(
      independentSteps.map((step) => executeStep(step, taskIdByStep.get(step.stepId), identity, limits.retryLimit))
    );
    for (const r of results) {
      outcomes.push(r);
      if (r.status !== "SUCCESS") failedOrBlocked.add(r.stepId);
    }
  }

  for (const step of dependentSteps) {
    const haltedNow = await isHalted();
    if (haltedNow) {
      outcomes.push({
        stepId: step.stepId,
        description: step.description,
        agent: step.agent,
        tool: step.tool,
        taskId: taskIdByStep.get(step.stepId),
        status: "BLOCKED",
        detail: `System is ${haltedNow}; remaining steps were not started.`,
      });
      failedOrBlocked.add(step.stepId);
      continue;
    }

    const blockedDep = (step.dependsOn ?? []).find((d) => failedOrBlocked.has(d));
    if (blockedDep) {
      const taskId = taskIdByStep.get(step.stepId);
      if (taskId) await updateTaskStatus(taskId, "BLOCKED");
      outcomes.push({
        stepId: step.stepId,
        description: step.description,
        agent: step.agent,
        tool: step.tool,
        taskId,
        status: "BLOCKED",
        detail: `Skipped: depends on step "${blockedDep}" which did not succeed.`,
      });
      failedOrBlocked.add(step.stepId);
      continue;
    }

    const outcome = await executeStep(step, taskIdByStep.get(step.stepId), identity, limits.retryLimit);
    outcomes.push(outcome);
    if (outcome.status !== "SUCCESS") failedOrBlocked.add(outcome.stepId);
  }

  return { status: overallStatus(outcomes), steps: outcomes };
}
