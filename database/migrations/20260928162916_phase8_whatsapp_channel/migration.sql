-- AlterTable
ALTER TABLE "contacts" ADD COLUMN "normalizedPhone" TEXT;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_approval_requests" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "action" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "proposedContent" TEXT NOT NULL,
    "supportingContext" TEXT,
    "riskClassification" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'EMAIL',
    "taskId" TEXT,
    "idempotencyKey" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdBy" TEXT NOT NULL,
    "decidedBy" TEXT,
    "decidedAt" DATETIME,
    "decisionNote" TEXT,
    "expiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_approval_requests" ("action", "createdAt", "createdBy", "decidedAt", "decidedBy", "decisionNote", "expiresAt", "id", "idempotencyKey", "proposedContent", "reason", "riskClassification", "status", "supportingContext", "target", "taskId", "updatedAt") SELECT "action", "createdAt", "createdBy", "decidedAt", "decidedBy", "decisionNote", "expiresAt", "id", "idempotencyKey", "proposedContent", "reason", "riskClassification", "status", "supportingContext", "target", "taskId", "updatedAt" FROM "approval_requests";
DROP TABLE "approval_requests";
ALTER TABLE "new_approval_requests" RENAME TO "approval_requests";
CREATE UNIQUE INDEX "approval_requests_idempotencyKey_key" ON "approval_requests"("idempotencyKey");
CREATE INDEX "approval_requests_status_idx" ON "approval_requests"("status");
CREATE INDEX "approval_requests_taskId_idx" ON "approval_requests"("taskId");
CREATE TABLE "new_emails" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "contactId" TEXT,
    "direction" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'EMAIL',
    "subject" TEXT,
    "body" TEXT,
    "status" TEXT NOT NULL DEFAULT 'NOT_IMPLEMENTED',
    "providerMessageId" TEXT,
    "threadId" TEXT,
    "toAddress" TEXT,
    "fromAddress" TEXT,
    "classification" TEXT,
    "classificationReasons" TEXT,
    "riskCategory" TEXT,
    "idempotencyKey" TEXT,
    "relatedLeadId" TEXT,
    "providerConversationId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "emails_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_emails" ("body", "classification", "classificationReasons", "contactId", "createdAt", "direction", "fromAddress", "id", "idempotencyKey", "providerMessageId", "relatedLeadId", "riskCategory", "status", "subject", "threadId", "toAddress", "updatedAt") SELECT "body", "classification", "classificationReasons", "contactId", "createdAt", "direction", "fromAddress", "id", "idempotencyKey", "providerMessageId", "relatedLeadId", "riskCategory", "status", "subject", "threadId", "toAddress", "updatedAt" FROM "emails";
DROP TABLE "emails";
ALTER TABLE "new_emails" RENAME TO "emails";
CREATE UNIQUE INDEX "emails_providerMessageId_key" ON "emails"("providerMessageId");
CREATE UNIQUE INDEX "emails_idempotencyKey_key" ON "emails"("idempotencyKey");
CREATE INDEX "emails_threadId_idx" ON "emails"("threadId");
CREATE INDEX "emails_relatedLeadId_idx" ON "emails"("relatedLeadId");
CREATE INDEX "emails_channel_idx" ON "emails"("channel");
CREATE INDEX "emails_providerConversationId_idx" ON "emails"("providerConversationId");
CREATE TABLE "new_follow_ups" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "leadId" TEXT,
    "contactId" TEXT,
    "sequenceStep" INTEGER NOT NULL DEFAULT 1,
    "channel" TEXT NOT NULL DEFAULT 'EMAIL',
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "scheduledFor" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "cancelReason" TEXT,
    "taskId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_follow_ups" ("body", "cancelReason", "contactId", "createdAt", "id", "leadId", "scheduledFor", "sequenceStep", "status", "subject", "taskId", "updatedAt") SELECT "body", "cancelReason", "contactId", "createdAt", "id", "leadId", "scheduledFor", "sequenceStep", "status", "subject", "taskId", "updatedAt" FROM "follow_ups";
DROP TABLE "follow_ups";
ALTER TABLE "new_follow_ups" RENAME TO "follow_ups";
CREATE UNIQUE INDEX "follow_ups_taskId_key" ON "follow_ups"("taskId");
CREATE INDEX "follow_ups_status_scheduledFor_idx" ON "follow_ups"("status", "scheduledFor");
CREATE UNIQUE INDEX "follow_ups_leadId_sequenceStep_key" ON "follow_ups"("leadId", "sequenceStep");
CREATE TABLE "new_outbound_send_log" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "idempotencyKey" TEXT NOT NULL,
    "taskId" TEXT,
    "contactId" TEXT,
    "emailId" TEXT,
    "channel" TEXT NOT NULL DEFAULT 'EMAIL',
    "status" TEXT NOT NULL,
    "providerMessageId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_outbound_send_log" ("contactId", "createdAt", "emailId", "id", "idempotencyKey", "providerMessageId", "status", "taskId") SELECT "contactId", "createdAt", "emailId", "id", "idempotencyKey", "providerMessageId", "status", "taskId" FROM "outbound_send_log";
DROP TABLE "outbound_send_log";
ALTER TABLE "new_outbound_send_log" RENAME TO "outbound_send_log";
CREATE UNIQUE INDEX "outbound_send_log_idempotencyKey_key" ON "outbound_send_log"("idempotencyKey");
CREATE TABLE "new_suppressed_contacts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "normalizedEmail" TEXT,
    "normalizedPhone" TEXT,
    "reason" TEXT NOT NULL,
    "contactId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_suppressed_contacts" ("contactId", "createdAt", "id", "normalizedEmail", "reason") SELECT "contactId", "createdAt", "id", "normalizedEmail", "reason" FROM "suppressed_contacts";
DROP TABLE "suppressed_contacts";
ALTER TABLE "new_suppressed_contacts" RENAME TO "suppressed_contacts";
CREATE UNIQUE INDEX "suppressed_contacts_normalizedEmail_key" ON "suppressed_contacts"("normalizedEmail");
CREATE UNIQUE INDEX "suppressed_contacts_normalizedPhone_key" ON "suppressed_contacts"("normalizedPhone");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "contacts_normalizedPhone_idx" ON "contacts"("normalizedPhone");
