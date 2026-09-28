// core/worker/config.ts - Autonomous Worker configuration (Phase 5).
//
// Same pattern as core/limits/getLimitsConfig(): sane in-code defaults,
// overridable via the `settings` table (key "worker.config") so an operator
// can tune the loop without a redeploy.
import { prisma } from "../../database/client";

export interface WorkerConfig {
  /**
   * Concurrent task-processing "slots" within THIS Node process. This is
   * NOT multiple OS processes - there is no process supervisor in this
   * stack. "MAX_WORKERS" here means "how many tasks this one process will
   * claim and run at once", nothing more. See docs/PHASE5_AUTONOMOUS_WORKER.md.
   */
  maxWorkers: number;
  /** How often the main loop ticks (selects + processes eligible tasks). */
  tickIntervalMs: number;
  /** How often the heartbeat row is refreshed - independent of, and shorter than, the task tick. */
  heartbeatIntervalMs: number;
  /** How long a DB claim is valid before it's considered abandoned (crash recovery trigger). */
  claimTimeoutMs: number;
  /** Minimum time between re-checking a WAITING/BLOCKED task's eligibility (backoff - never hammer). */
  recheckCooldownMs: number;
  /** How many WAITING/BLOCKED tasks get re-checked per tick (bounded, so a large backlog doesn't stall the tick). */
  recheckBatchSize: number;
  /** Watchdog: heartbeat older than this is considered a stopped/crashed worker. */
  heartbeatTimeoutMs: number;
  /** Watchdog: max automatic restart attempts within restartWindowMs before giving up permanently. */
  maxRestartAttempts: number;
  /** Watchdog: restart-attempt accounting window. */
  restartWindowMs: number;
  /** Watchdog: base exponential backoff between restart attempts. */
  restartBackoffBaseMs: number;
  /** Watchdog: ticks with eligible-but-unprocessed tasks before flagging starvation. */
  starvationTicks: number;
  /** #10: max direct child tasks a single parent task may spawn. */
  maxChildTasksPerParent: number;
  /** #10: max parent->child recursion depth. */
  maxRecursionDepth: number;
  /** #10: max total tasks (including the root) in one task tree. */
  maxTasksPerTree: number;
}

export const DEFAULT_WORKER_CONFIG: WorkerConfig = {
  maxWorkers: 2,
  tickIntervalMs: 2000,
  heartbeatIntervalMs: 1000,
  claimTimeoutMs: 5 * 60 * 1000,
  recheckCooldownMs: 60 * 1000,
  recheckBatchSize: 5,
  heartbeatTimeoutMs: 30 * 1000,
  maxRestartAttempts: 5,
  restartWindowMs: 10 * 60 * 1000,
  restartBackoffBaseMs: 1000,
  starvationTicks: 10,
  maxChildTasksPerParent: 5,
  maxRecursionDepth: 3,
  maxTasksPerTree: 20,
};

const SETTINGS_KEY = "worker.config";

export async function getWorkerConfig(): Promise<WorkerConfig> {
  const row = await prisma.setting.findUnique({ where: { key: SETTINGS_KEY } });
  if (!row) return { ...DEFAULT_WORKER_CONFIG };
  try {
    return { ...DEFAULT_WORKER_CONFIG, ...(JSON.parse(row.value) as Partial<WorkerConfig>) };
  } catch {
    return { ...DEFAULT_WORKER_CONFIG };
  }
}

export async function setWorkerConfig(partial: Partial<WorkerConfig>): Promise<WorkerConfig> {
  const current = await getWorkerConfig();
  const next = { ...current, ...partial };
  await prisma.setting.upsert({
    where: { key: SETTINGS_KEY },
    update: { value: JSON.stringify(next) },
    create: { key: SETTINGS_KEY, value: JSON.stringify(next) },
  });
  return next;
}
