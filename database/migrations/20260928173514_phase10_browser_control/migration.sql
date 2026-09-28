-- CreateTable
CREATE TABLE "browser_sessions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "profileId" TEXT,
    "currentUrl" TEXT,
    "currentDomain" TEXT,
    "isolationLevel" TEXT NOT NULL DEFAULT 'CONTEXT',
    "taskId" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActivityAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    "closedAt" DATETIME,
    "closeReason" TEXT
);

-- CreateTable
CREATE TABLE "browser_tasks" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT,
    "sessionId" TEXT,
    "domain" TEXT,
    "action" TEXT NOT NULL,
    "targetText" TEXT,
    "riskCategory" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "approvalId" TEXT,
    "result" TEXT,
    "failureReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME
);

-- CreateIndex
CREATE INDEX "browser_sessions_status_idx" ON "browser_sessions"("status");

-- CreateIndex
CREATE INDEX "browser_sessions_taskId_idx" ON "browser_sessions"("taskId");

-- CreateIndex
CREATE INDEX "browser_tasks_taskId_idx" ON "browser_tasks"("taskId");

-- CreateIndex
CREATE INDEX "browser_tasks_sessionId_idx" ON "browser_tasks"("sessionId");

-- CreateIndex
CREATE INDEX "browser_tasks_status_idx" ON "browser_tasks"("status");
