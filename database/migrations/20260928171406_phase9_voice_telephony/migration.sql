-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_calls" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "contactId" TEXT,
    "companyId" TEXT,
    "leadId" TEXT,
    "direction" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'NOT_IMPLEMENTED',
    "durationSecs" INTEGER,
    "transcript" TEXT,
    "startedAt" DATETIME,
    "answeredAt" DATETIME,
    "endedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "provider" TEXT,
    "providerCallId" TEXT,
    "callerNumber" TEXT,
    "normalizedCallerNumber" TEXT,
    "idempotencyKey" TEXT,
    "riskCategory" TEXT,
    "recordingStatus" TEXT NOT NULL DEFAULT 'NOT_RECORDED',
    "transcriptionStatus" TEXT,
    "transcriptLanguage" TEXT,
    "transcriptConfidence" REAL,
    "intent" TEXT,
    "outcome" TEXT,
    "costEstimate" REAL,
    CONSTRAINT "calls_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_calls" ("contactId", "createdAt", "direction", "durationSecs", "endedAt", "id", "startedAt", "status", "transcript") SELECT "contactId", "createdAt", "direction", "durationSecs", "endedAt", "id", "startedAt", "status", "transcript" FROM "calls";
DROP TABLE "calls";
ALTER TABLE "new_calls" RENAME TO "calls";
CREATE UNIQUE INDEX "calls_providerCallId_key" ON "calls"("providerCallId");
CREATE UNIQUE INDEX "calls_idempotencyKey_key" ON "calls"("idempotencyKey");
CREATE INDEX "calls_normalizedCallerNumber_idx" ON "calls"("normalizedCallerNumber");
CREATE INDEX "calls_contactId_idx" ON "calls"("contactId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
