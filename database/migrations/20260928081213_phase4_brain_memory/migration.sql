/*
  Warnings:

  - Added the required column `updatedAt` to the `memory` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "tasks" ADD COLUMN "agentName" TEXT;
ALTER TABLE "tasks" ADD COLUMN "stepId" TEXT;
ALTER TABLE "tasks" ADD COLUMN "toolName" TEXT;

-- CreateTable
CREATE TABLE "ai_usage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "estimatedCostUsd" REAL NOT NULL,
    "taskId" TEXT,
    "agentName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_memory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "namespace" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "content" TEXT,
    "source" TEXT,
    "confidence" REAL NOT NULL DEFAULT 1,
    "relatedEntity" TEXT,
    "metadata" TEXT,
    "expiresAt" DATETIME,
    "importance" INTEGER NOT NULL DEFAULT 5,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "supersedes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archivedAt" DATETIME
);
-- Backfill updatedAt from createdAt for pre-existing rows (this table had no
-- updatedAt column before this migration, so there is no better source of
-- truth for "when was this last touched").
INSERT INTO "new_memory" ("archivedAt", "createdAt", "id", "importance", "key", "namespace", "status", "supersedes", "value", "updatedAt") SELECT "archivedAt", "createdAt", "id", "importance", "key", "namespace", "status", "supersedes", "value", "createdAt" FROM "memory";
DROP TABLE "memory";
ALTER TABLE "new_memory" RENAME TO "memory";
CREATE INDEX "memory_namespace_key_idx" ON "memory"("namespace", "key");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "ai_usage_createdAt_idx" ON "ai_usage"("createdAt");
