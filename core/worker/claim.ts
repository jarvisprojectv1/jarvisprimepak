// core/worker/claim.ts - DB-backed task claiming (Phase 5 / Autonomous
// Worker, requirement #7).
//
// The claim is enforced by a conditional Prisma `updateMany` WHERE clause
// succeeding or failing at the database layer - never by an in-memory
// mutex alone. Two concurrent worker "slots" (in this single process, or in
// principle two processes sharing one SQLite file) racing to claim the same
// task will have exactly one `updateMany` match one row; the loser's
// `updateMany` matches zero rows and it moves on. A claim expires
// (`claimExpiresAt`) so a crashed worker's abandoned claim becomes
// reclaimable - see reclaimExpiredTasks(), the crash-recovery tie-in for
// requirement #6.
import { prisma } from "../../database/client";
import { log } from "../../security/logger";
import { getTask, retryOrFailTask, type PlannedTask } from "../planner";
import { getLimitsConfig } from "../limits";

export interface ClaimResult {
  claimed: boolean;
  task?: PlannedTask;
}

/**
 * Attempts to atomically claim `taskId` for `workerId`. Succeeds only if the
 * task is currently in an eligible status AND either unclaimed or its
 * previous claim has expired. On success, the task's status is moved to
 * IN_PROGRESS as part of the same write.
 */
export async function claimTask(taskId: string, workerId: string, claimTimeoutMs: number): Promise<ClaimResult> {
  const now = new Date();
  const claimExpiresAt = new Date(now.getTime() + claimTimeoutMs);

  const { count } = await prisma.task.updateMany({
    where: {
      id: taskId,
      status: { in: ["PENDING", "QUEUED", "RETRYING"] },
      OR: [{ claimedBy: null }, { claimExpiresAt: { lt: now } }],
    },
    data: {
      status: "IN_PROGRESS",
      claimedBy: workerId,
      claimedAt: now,
      claimExpiresAt,
    },
  });

  if (count === 0) {
    return { claimed: false };
  }

  const task = await getTask(taskId);
  log("ACTION", "worker.task_claimed", { taskId, workerId });
  return { claimed: true, task: task ?? undefined };
}

/**
 * Releases a claim this worker holds. Guarded by `claimedBy = workerId` so a
 * worker can never release (or race-clear) another worker's claim. Does NOT
 * touch `status` - the caller has already set the task's final status
 * (DONE/WAITING/BLOCKED/RETRYING/FAILED) via core/planner before calling this.
 */
export async function releaseClaim(taskId: string, workerId: string): Promise<void> {
  await prisma.task.updateMany({
    where: { id: taskId, claimedBy: workerId },
    data: { claimedBy: null, claimedAt: null, claimExpiresAt: null },
  });
}

export interface ReclaimReport {
  inspected: number;
  movedToRetrying: string[];
  movedToFailed: string[];
}

/**
 * Crash recovery for worker-claimed tasks (requirement #6/#7): a task left
 * IN_PROGRESS with an EXPIRED claim means the worker slot that claimed it
 * died before finishing. Moves it to RETRYING (if retries remain) or FAILED,
 * clearing the stale claim - exactly the same policy
 * core/tasks.recoverUnfinishedTasks() applies at boot for pre-Phase-5 stuck
 * tasks, extended here to also fire periodically while the process is alive
 * (a claim can expire without the whole process dying, e.g. one slot hangs).
 */
export async function reclaimExpiredTasks(): Promise<ReclaimReport> {
  const limits = await getLimitsConfig();
  const now = new Date();
  const stuck = await prisma.task.findMany({
    where: {
      status: "IN_PROGRESS",
      claimedBy: { not: null },
      claimExpiresAt: { lt: now },
    },
  });

  const report: ReclaimReport = { inspected: stuck.length, movedToRetrying: [], movedToFailed: [] };

  for (const task of stuck) {
    const reason = `Claim by worker "${task.claimedBy}" expired at ${task.claimExpiresAt?.toISOString()} with no completion - the process/slot that held it likely died.`;
    const updated = await retryOrFailTask(task.id, limits.retryLimit, reason);
    await prisma.task.update({
      where: { id: task.id },
      data: { claimedBy: null, claimedAt: null, claimExpiresAt: null },
    });
    if (updated.status === "RETRYING") report.movedToRetrying.push(task.id);
    else report.movedToFailed.push(task.id);
    log("WARNING", "worker.reclaimed_expired_task", { taskId: task.id, newStatus: updated.status });
  }

  return report;
}
