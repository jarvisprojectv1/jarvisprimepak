-- CreateTable
CREATE TABLE "research_runs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT,
    "query" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "createdBy" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "summary" TEXT
);

-- CreateTable
CREATE TABLE "research_sources" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "researchRunId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "canonicalUrl" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "title" TEXT,
    "retrievedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" DATETIME,
    "contentHash" TEXT,
    "sourceType" TEXT NOT NULL,
    "discoveredByQuery" TEXT,
    CONSTRAINT "research_sources_researchRunId_fkey" FOREIGN KEY ("researchRunId") REFERENCES "research_runs" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "research_evidence" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "researchSourceId" TEXT NOT NULL,
    "extractedText" TEXT NOT NULL,
    "classification" TEXT NOT NULL,
    "relatedTaskId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "research_evidence_researchSourceId_fkey" FOREIGN KEY ("researchSourceId") REFERENCES "research_sources" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "research_topics" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "pollIntervalMinutes" INTEGER NOT NULL DEFAULT 1440,
    "lastPolledAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "skill_candidates" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "version" TEXT NOT NULL DEFAULT '0.1.0',
    "source" TEXT NOT NULL,
    "capabilities" TEXT,
    "requiredPermissions" TEXT,
    "dependencies" TEXT,
    "riskLevel" TEXT NOT NULL DEFAULT 'MEDIUM',
    "testStatus" TEXT NOT NULL DEFAULT 'NOT_RUN',
    "securityStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "activationStatus" TEXT NOT NULL DEFAULT 'DISCOVERED',
    "rejectionReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
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
    "updatedAt" DATETIME NOT NULL,
    "archivedAt" DATETIME
);
INSERT INTO "new_memory" ("archivedAt", "confidence", "content", "createdAt", "expiresAt", "id", "importance", "key", "metadata", "namespace", "relatedEntity", "source", "status", "supersedes", "updatedAt", "value") SELECT "archivedAt", "confidence", "content", "createdAt", "expiresAt", "id", "importance", "key", "metadata", "namespace", "relatedEntity", "source", "status", "supersedes", "updatedAt", "value" FROM "memory";
DROP TABLE "memory";
ALTER TABLE "new_memory" RENAME TO "memory";
CREATE INDEX "memory_namespace_key_idx" ON "memory"("namespace", "key");
CREATE TABLE "new_worker_heartbeats" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workerId" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastHeartbeat" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "currentTaskId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'IDLE',
    "processedTasks" INTEGER NOT NULL DEFAULT 0,
    "failedTasks" INTEGER NOT NULL DEFAULT 0,
    "restartCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_worker_heartbeats" ("currentTaskId", "failedTasks", "id", "lastHeartbeat", "processedTasks", "restartCount", "startedAt", "status", "updatedAt", "workerId") SELECT "currentTaskId", "failedTasks", "id", "lastHeartbeat", "processedTasks", "restartCount", "startedAt", "status", "updatedAt", "workerId" FROM "worker_heartbeats";
DROP TABLE "worker_heartbeats";
ALTER TABLE "new_worker_heartbeats" RENAME TO "worker_heartbeats";
CREATE UNIQUE INDEX "worker_heartbeats_workerId_key" ON "worker_heartbeats"("workerId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "research_runs_taskId_idx" ON "research_runs"("taskId");

-- CreateIndex
CREATE INDEX "research_sources_canonicalUrl_idx" ON "research_sources"("canonicalUrl");

-- CreateIndex
CREATE INDEX "research_sources_contentHash_idx" ON "research_sources"("contentHash");

-- CreateIndex
CREATE INDEX "research_evidence_relatedTaskId_idx" ON "research_evidence"("relatedTaskId");

-- CreateIndex
CREATE UNIQUE INDEX "research_topics_name_key" ON "research_topics"("name");
