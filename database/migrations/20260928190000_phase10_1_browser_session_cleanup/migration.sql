-- Phase 10.1: browser session cleanup bookkeeping.
-- Adds bounded-retry cleanup-failure fields to browser_sessions so a
-- cleanup failure is persisted (never held only in memory, never silently
-- discarded) and survives a process restart. `status` itself needs no
-- column change (SQLite has no enums; the widened status vocabulary -
-- CREATED | ACTIVE | IDLE | CLEANING | EXPIRED | CLOSED | CRASHED |
-- ORPHANED | CLEANUP_FAILED - is validated in application code).
ALTER TABLE "browser_sessions" ADD COLUMN "cleanupAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "browser_sessions" ADD COLUMN "lastCleanupError" TEXT;
ALTER TABLE "browser_sessions" ADD COLUMN "lastCleanupAttemptAt" DATETIME;
ALTER TABLE "browser_sessions" ADD COLUMN "nextCleanupRetryAt" DATETIME;
