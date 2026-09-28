// core/worker/heartbeat.ts - Worker liveness (Phase 5 / Autonomous Worker,
// requirement #4). One DB row per worker instance (workerId), refreshed on a
// short interval independent of the (slower) task-processing tick, so
// GET /system/health and the watchdog can tell "the loop is alive and ticking"
// from "the loop stopped/crashed" without any in-process-only signal.
import { prisma } from "../../database/client";

export type WorkerHeartbeatStatus = "RUNNING" | "IDLE" | "DEGRADED" | "STOPPED" | "CRASHED";

export interface WorkerHeartbeatRecord {
  workerId: string;
  startedAt: Date;
  lastHeartbeat: Date;
  currentTaskId: string | null;
  status: WorkerHeartbeatStatus;
  processedTasks: number;
  failedTasks: number;
  restartCount: number;
  updatedAt: Date;
}

function toRecord(row: {
  workerId: string;
  startedAt: Date;
  lastHeartbeat: Date;
  currentTaskId: string | null;
  status: string;
  processedTasks: number;
  failedTasks: number;
  restartCount: number;
  updatedAt: Date;
}): WorkerHeartbeatRecord {
  return { ...row, status: row.status as WorkerHeartbeatStatus };
}

/** Creates (or resets) the heartbeat row for `workerId` at worker startup. */
export async function initHeartbeat(workerId: string): Promise<WorkerHeartbeatRecord> {
  const now = new Date();
  const row = await prisma.workerHeartbeat.upsert({
    where: { workerId },
    update: { startedAt: now, lastHeartbeat: now, status: "IDLE", currentTaskId: null },
    create: { workerId, startedAt: now, lastHeartbeat: now, status: "IDLE" },
  });
  return toRecord(row);
}

export interface HeartbeatPatch {
  status?: WorkerHeartbeatStatus;
  currentTaskId?: string | null;
  incrementProcessed?: boolean;
  incrementFailed?: boolean;
  incrementRestart?: boolean;
}

/** Refreshes `lastHeartbeat` and applies any provided patch fields/counters. */
export async function beat(workerId: string, patch: HeartbeatPatch = {}): Promise<WorkerHeartbeatRecord> {
  const row = await prisma.workerHeartbeat.upsert({
    where: { workerId },
    update: {
      lastHeartbeat: new Date(),
      ...(patch.status ? { status: patch.status } : {}),
      ...(patch.currentTaskId !== undefined ? { currentTaskId: patch.currentTaskId } : {}),
      ...(patch.incrementProcessed ? { processedTasks: { increment: 1 } } : {}),
      ...(patch.incrementFailed ? { failedTasks: { increment: 1 } } : {}),
      ...(patch.incrementRestart ? { restartCount: { increment: 1 } } : {}),
    },
    create: {
      workerId,
      status: patch.status ?? "IDLE",
      currentTaskId: patch.currentTaskId ?? null,
      processedTasks: patch.incrementProcessed ? 1 : 0,
      failedTasks: patch.incrementFailed ? 1 : 0,
      restartCount: patch.incrementRestart ? 1 : 0,
    },
  });
  return toRecord(row);
}

export async function getHeartbeat(workerId: string): Promise<WorkerHeartbeatRecord | null> {
  const row = await prisma.workerHeartbeat.findUnique({ where: { workerId } });
  return row ? toRecord(row) : null;
}

export async function listHeartbeats(): Promise<WorkerHeartbeatRecord[]> {
  const rows = await prisma.workerHeartbeat.findMany({ orderBy: { workerId: "asc" } });
  return rows.map(toRecord);
}

export function isStale(heartbeat: WorkerHeartbeatRecord, timeoutMs: number, now = new Date()): boolean {
  return now.getTime() - heartbeat.lastHeartbeat.getTime() > timeoutMs;
}
