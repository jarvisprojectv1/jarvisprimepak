// core/worker/queue.ts - Task priority/selection (Phase 5 / Autonomous
// Worker, requirement #3).
//
// Selection order: priority level (CRITICAL > HIGH > NORMAL > LOW) first,
// then within the same priority: scheduled time (a future dueAt is not
// selected yet - enforced by the WHERE clause, not just eligibility),
// RETRYING tasks are interleaved by their normal position (their own backoff
// window is enforced by core/worker/eligibility.ts, not by exclusion here -
// so a single repeatedly-failing task never blocks the ones behind it),
// then creation time (FIFO tiebreak).
import { prisma } from "../../database/client";
import { PRIORITY_ORDER, type PlannedTask, type TaskPriority } from "../planner";

function toPlannedTaskLite(row: any): PlannedTask {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
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
    updatedAt: row.updatedAt,
  };
}

/**
 * Fetches worker-scoped candidate tasks (PENDING/QUEUED/RETRYING, top-level
 * only - see docs/PHASE5_AUTONOMOUS_WORKER.md "worker scope" for why
 * Brain-plan subtasks, which are already executed by core/brain/runPlan.ts,
 * are excluded), sorted by priority then creation time. Callers still run
 * core/worker/eligibility.ts's isTaskEligible() per candidate - this only
 * orders the pool, it does not itself decide eligibility.
 */
export async function selectCandidateTasks(limit = 50): Promise<PlannedTask[]> {
  const rows = await prisma.task.findMany({
    where: {
      status: { in: ["PENDING", "QUEUED", "RETRYING"] },
      parentId: null,
      stepId: null,
    },
    orderBy: [{ createdAt: "asc" }],
    take: limit,
  });
  const tasks = rows.map(toPlannedTaskLite);
  return tasks.sort((a, b) => {
    const p = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
    if (p !== 0) return p;
    return a.createdAt.getTime() - b.createdAt.getTime();
  });
}

/**
 * Fetches WAITING/BLOCKED top-level tasks whose blocker hasn't been
 * re-checked recently (backoff - requirement #2's "never hammer a blocked
 * task"), oldest-checked first, capped at `limit` per call.
 */
export async function selectStaleWaitingOrBlocked(cooldownMs: number, limit: number): Promise<PlannedTask[]> {
  const cutoff = new Date(Date.now() - cooldownMs);
  const rows = await prisma.task.findMany({
    where: {
      status: { in: ["WAITING", "BLOCKED"] },
      parentId: null,
      OR: [{ lastEligibilityCheckAt: null }, { lastEligibilityCheckAt: { lt: cutoff } }],
    },
    orderBy: [{ lastEligibilityCheckAt: "asc" }],
    take: limit,
  });
  return rows.map(toPlannedTaskLite);
}
