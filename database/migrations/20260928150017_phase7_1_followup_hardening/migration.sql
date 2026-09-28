-- CreateTable
CREATE TABLE "follow_ups" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "leadId" TEXT,
    "contactId" TEXT,
    "sequenceStep" INTEGER NOT NULL DEFAULT 1,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "scheduledFor" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "cancelReason" TEXT,
    "taskId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "follow_ups_taskId_key" ON "follow_ups"("taskId");

-- CreateIndex
CREATE INDEX "follow_ups_status_scheduledFor_idx" ON "follow_ups"("status", "scheduledFor");

-- CreateIndex
CREATE UNIQUE INDEX "follow_ups_leadId_sequenceStep_key" ON "follow_ups"("leadId", "sequenceStep");
