// core/planner - minimal task-decomposition interface (spec section 5).
//
// Phase 1 uses a naive, deterministic decomposition (no LLM planning yet):
// a goal becomes a single top-level Task, optionally split into subtasks the
// caller already knows about. The point is the Task shape and persistence,
// not planning intelligence - that arrives in a later phase.
import { prisma } from "../../database/client";
import { log } from "../../security/logger";
import { publish } from "../events";

// Phase 2 (Autonomy Core) status set - see database/schema.prisma's Task
// model comment for the reconciliation rationale.
export type TaskStatus =
  | "PENDING"
  | "QUEUED"
  | "IN_PROGRESS"
  | "WAITING"
  | "BLOCKED"
  | "RETRYING"
  | "DONE"
  | "FAILED"
  | "CANCELLED";
// Phase 5 (Autonomous Worker): canonical 4-level priority. Reconciles the
// Phase 1-4 LOW|NORMAL|HIGH|URGENT set with the spec's CRITICAL|HIGH|NORMAL|LOW
// set by retiring URGENT in favor of CRITICAL (see migration
// phase5_autonomous_worker, which rewrites any existing "URGENT" rows, and
// docs/PHASE5_AUTONOMOUS_WORKER.md for the full rationale). Every call site
// that referenced "URGENT" has been updated to "CRITICAL".
export type TaskPriority = "CRITICAL" | "HIGH" | "NORMAL" | "LOW";
export const PRIORITY_ORDER: Record<TaskPriority, number> = { CRITICAL: 0, HIGH: 1, NORMAL: 2, LOW: 3 };

export interface TaskInput {
  title: string;
  description?: string;
  priority?: TaskPriority;
  dueAt?: Date;
  ownerId?: string;
  subtasks?: string[]; // titles of naive, flat subtasks
  /** Phase 4: when this task originates from a validated Brain Plan step. */
  stepId?: string;
  agentName?: string;
  toolName?: string;
  /** Phase 5: explicit parent, for autonomous follow-up tasks (core/worker/spawn.ts) and worker-created tasks. */
  parentId?: string;
}

export interface PlannedTask {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  retryCount: number;
  parentId: string | null;
  dueAt: Date | null;
  stepId: string | null;
  agentName: string | null;
  toolName: string | null;
  waitingReason: string | null;
  blockedReason: string | null;
  claimedBy: string | null;
  claimedAt: Date | null;
  claimExpiresAt: Date | null;
  lastEligibilityCheckAt: Date | null;
  failureReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function toPlannedTask(row: {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  retryCount?: number;
  parentId: string | null;
  dueAt: Date | null;
  stepId?: string | null;
  agentName?: string | null;
  toolName?: string | null;
  waitingReason?: string | null;
  blockedReason?: string | null;
  claimedBy?: string | null;
  claimedAt?: Date | null;
  claimExpiresAt?: Date | null;
  lastEligibilityCheckAt?: Date | null;
  failureReason?: string | null;
  createdAt: Date;
  updatedAt?: Date;
}): PlannedTask {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status as TaskStatus,
    priority: (row.priority as TaskPriority) ?? "NORMAL",
    retryCount: row.retryCount ?? 0,
    parentId: row.parentId,
    dueAt: row.dueAt,
    stepId: row.stepId ?? null,
    agentName: row.agentName ?? null,
    toolName: row.toolName ?? null,
    waitingReason: row.waitingReason ?? null,
    blockedReason: row.blockedReason ?? null,
    claimedBy: row.claimedBy ?? null,
    claimedAt: row.claimedAt ?? null,
    claimExpiresAt: row.claimExpiresAt ?? null,
    lastEligibilityCheckAt: row.lastEligibilityCheckAt ?? null,
    failureReason: row.failureReason ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt ?? row.createdAt,
  };
}

/**
 * Naive planner: creates one top-level task, plus one flat subtask per
 * string in `subtasks`. Real (LLM-driven) decomposition is a later phase.
 */
export async function planTask(input: TaskInput): Promise<PlannedTask[]> {
  const parent = await prisma.task.create({
    data: {
      title: input.title,
      description: input.description,
      priority: input.priority ?? "NORMAL",
      dueAt: input.dueAt,
      ownerId: input.ownerId,
      stepId: input.stepId,
      agentName: input.agentName,
      toolName: input.toolName,
      parentId: input.parentId,
    },
  });

  const created: PlannedTask[] = [toPlannedTask(parent)];

  for (const subtaskTitle of input.subtasks ?? []) {
    const sub = await prisma.task.create({
      data: {
        title: subtaskTitle,
        priority: input.priority ?? "NORMAL",
        parentId: parent.id,
        ownerId: input.ownerId,
      },
    });
    created.push(toPlannedTask(sub));
  }

  log("ACTION", "planner.plan", {
    taskId: parent.id,
    subtaskCount: created.length - 1,
  });

  // Proof-of-pipe: EVENT -> DECISION (see core/events' registerDefaultSubscribers).
  await publish({ type: "task.created", payload: { taskId: parent.id, title: parent.title }, source: "planner" });

  return created;
}

/**
 * Records a failed attempt at a task and either moves it to RETRYING (if
 * under the configured retry limit) or FAILED (if the limit is reached).
 */
export async function retryOrFailTask(id: string, retryLimit: number, reason?: string): Promise<PlannedTask> {
  const existing = await prisma.task.findUniqueOrThrow({ where: { id } });
  const nextRetryCount = existing.retryCount + 1;
  const nextStatus: TaskStatus = nextRetryCount < retryLimit ? "RETRYING" : "FAILED";
  const row = await prisma.task.update({
    where: { id },
    data: { retryCount: nextRetryCount, status: nextStatus, failureReason: reason ?? existing.failureReason },
  });
  log("ACTION", "planner.retry_or_fail", { taskId: id, retryCount: nextRetryCount, status: nextStatus, reason });
  return toPlannedTask(row);
}

export async function updateTaskStatus(
  id: string,
  status: TaskStatus,
  reason?: string
): Promise<PlannedTask> {
  // Phase 5: WAITING gets a persisted `waitingReason` (transient/informational
  // blocker), BLOCKED gets a persisted `blockedReason` (policy/system
  // blocker) - see core/worker/eligibility.ts. Moving OFF one of these
  // statuses clears its reason so a stale reason never lingers.
  const data: Record<string, unknown> = { status };
  if (status === "WAITING") {
    data.waitingReason = reason ?? null;
  } else if (status === "BLOCKED") {
    data.blockedReason = reason ?? null;
  } else {
    data.waitingReason = null;
    data.blockedReason = null;
  }
  const row = await prisma.task.update({ where: { id }, data });
  log("ACTION", "planner.status_change", { taskId: id, status, reason });
  return toPlannedTask(row);
}

export async function getTask(id: string): Promise<PlannedTask | null> {
  const row = await prisma.task.findUnique({ where: { id } });
  return row ? toPlannedTask(row) : null;
}

/**
 * Phase 4: creates real Task rows from a validated Brain Plan
 * (core/brain/plan.ts) - one parent task for the goal, one subtask per step,
 * each subtask tagged with its stepId/agentName/toolName so the Brain can
 * map execution results back to plan steps. The caller (core/brain) is
 * responsible for validating the Plan BEFORE calling this - this function
 * does not re-validate step shape, only persists it.
 */
export async function planFromPlan(
  plan: {
    goal: string;
    steps: Array<{ stepId: string; description: string; agent?: string; tool?: string }>;
  },
  parentId?: string
): Promise<{ parent: PlannedTask; subtasks: PlannedTask[] }> {
  const parent = await prisma.task.create({
    data: {
      title: plan.goal,
      description: `Brain-generated plan with ${plan.steps.length} step(s).`,
      parentId,
    },
  });

  const subtasks: PlannedTask[] = [];
  for (const step of plan.steps) {
    const sub = await prisma.task.create({
      data: {
        title: step.description,
        parentId: parent.id,
        stepId: step.stepId,
        agentName: step.agent,
        toolName: step.tool,
      },
    });
    subtasks.push(toPlannedTask(sub));
  }

  log("ACTION", "planner.plan_from_plan", { taskId: parent.id, stepCount: subtasks.length });
  await publish({ type: "task.created", payload: { taskId: parent.id, title: plan.goal }, source: "brain" });

  return { parent: toPlannedTask(parent), subtasks };
}

export async function listTasks(parentId?: string | null): Promise<PlannedTask[]> {
  const rows = await prisma.task.findMany({
    where: parentId === undefined ? {} : { parentId },
    orderBy: { createdAt: "desc" },
  });
  return rows.map(toPlannedTask);
}
