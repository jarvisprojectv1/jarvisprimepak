-- Phase 5: Autonomous Worker
-- Adds worker/eligibility/claiming fields to Task, retires the "URGENT"
-- priority value in favor of "CRITICAL" (canonical 4-level priority set),
-- and adds the WorkerHeartbeat and DailyReport tables.

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN "waitingReason" TEXT;
ALTER TABLE "tasks" ADD COLUMN "blockedReason" TEXT;
ALTER TABLE "tasks" ADD COLUMN "claimedBy" TEXT;
ALTER TABLE "tasks" ADD COLUMN "claimedAt" DATETIME;
ALTER TABLE "tasks" ADD COLUMN "claimExpiresAt" DATETIME;
ALTER TABLE "tasks" ADD COLUMN "lastEligibilityCheckAt" DATETIME;
ALTER TABLE "tasks" ADD COLUMN "failureReason" TEXT;

-- Priority reconciliation: rewrite any existing "URGENT" rows to "CRITICAL".
-- Safe on an empty table; documented in docs/PHASE5_AUTONOMOUS_WORKER.md.
UPDATE "tasks" SET "priority" = 'CRITICAL' WHERE "priority" = 'URGENT';

-- CreateTable
CREATE TABLE "worker_heartbeats" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workerId" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastHeartbeat" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "currentTaskId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'IDLE',
    "processedTasks" INTEGER NOT NULL DEFAULT 0,
    "failedTasks" INTEGER NOT NULL DEFAULT 0,
    "restartCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "worker_heartbeats_workerId_key" ON "worker_heartbeats"("workerId");

-- CreateTable
CREATE TABLE "daily_reports" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "reportDate" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "daily_reports_reportDate_key" ON "daily_reports"("reportDate");
