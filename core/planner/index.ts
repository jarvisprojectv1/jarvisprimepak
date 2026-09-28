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
export type TaskPriority = "LOW" | "NORMAL" | "HIGH" | "URGENT";

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
  createdAt: Date;
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
  createdAt: Date;
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
    createdAt: row.createdAt,
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
export async function retryOrFailTask(id: string, retryLimit: number): Promise<PlannedTask> {
  const existing = await prisma.task.findUniqueOrThrow({ where: { id } });
  const nextRetryCount = existing.retryCount + 1;
  const nextStatus: TaskStatus = nextRetryCount < retryLimit ? "RETRYING" : "FAILED";
  const row = await prisma.task.update({
    where: { id },
    data: { retryCount: nextRetryCount, status: nextStatus },
  });
  log("ACTION", "planner.retry_or_fail", { taskId: id, retryCount: nextRetryCount, status: nextStatus });
  return toPlannedTask(row);
}

export async function updateTaskStatus(
  id: string,
  status: TaskStatus
): Promise<PlannedTask> {
  const row = await prisma.task.update({ where: { id }, data: { status } });
  log("ACTION", "planner.status_change", { taskId: id, status });
  return toPlannedTask(row);
}

/**
 * Phase 4: creates real Task rows from a validated Brain Plan
 * (core/brain/plan.ts) - one parent task for the goal, one subtask per step,
 * each subtask tagged with its stepId/agentName/toolName so the Brain can
 * map execution results back to plan steps. The caller (core/brain) is
 * responsible for validating the Plan BEFORE calling this - this function
 * does not re-validate step shape, only persists it.
 */
export async function planFromPlan(plan: {
  goal: string;
  steps: Array<{ stepId: string; description: string; agent?: string; tool?: string }>;
}): Promise<{ parent: PlannedTask; subtasks: PlannedTask[] }> {
  const parent = await prisma.task.create({
    data: { title: plan.goal, description: `Brain-generated plan with ${plan.steps.length} step(s).` },
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
