// core/tasks - task-engine recovery (Phase 2 / Step 3, part E).
//
// A crashed JARVIS process can leave Task rows stuck in IN_PROGRESS with no
// live handler for them anymore. recoverUnfinishedTasks() runs once at API
// startup and reconciles that: any task still IN_PROGRESS from a previous
// process is moved to RETRYING (if it has retries left) or FAILED (if not),
// with a logged, honest reason - never silently left as if it were still
// running.
import { prisma } from "../../database/client";
import { log } from "../../security/logger";
import { getLimitsConfig } from "../limits";

export interface RecoveryReport {
  inspected: number;
  movedToRetrying: string[];
  movedToFailed: string[];
}

/**
 * Recovers tasks left in IN_PROGRESS (Phase 1's "running" state) from a
 * process that no longer exists. Call this once, at API boot, before any new
 * work is dispatched.
 */
export async function recoverUnfinishedTasks(): Promise<RecoveryReport> {
  const limits = await getLimitsConfig();
  const stuck = await prisma.task.findMany({ where: { status: "IN_PROGRESS" } });

  const report: RecoveryReport = { inspected: stuck.length, movedToRetrying: [], movedToFailed: [] };

  for (const task of stuck) {
    const nextRetryCount = task.retryCount + 1;
    const canRetry = nextRetryCount < limits.retryLimit;
    const nextStatus = canRetry ? "RETRYING" : "FAILED";

    await prisma.task.update({
      where: { id: task.id },
      data: { status: nextStatus, retryCount: nextRetryCount },
    });

    if (canRetry) {
      report.movedToRetrying.push(task.id);
    } else {
      report.movedToFailed.push(task.id);
    }

    log("WARNING", "tasks.recovered_after_crash", {
      taskId: task.id,
      title: task.title,
      previousStatus: "IN_PROGRESS",
      newStatus: nextStatus,
      retryCount: nextRetryCount,
      reason: "Task was IN_PROGRESS at process start with no live handler - a crashed JARVIS run.",
    });
  }

  log("INFO", "tasks.recovery_complete", {
    inspected: report.inspected,
    retried: report.movedToRetrying.length,
    failed: report.movedToFailed.length,
  });

  return report;
}
