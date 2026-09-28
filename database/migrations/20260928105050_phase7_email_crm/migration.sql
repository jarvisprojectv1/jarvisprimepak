/*
  Warnings:

  - Added the required column `updatedAt` to the `emails` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "communications" ADD COLUMN "activityType" TEXT;
ALTER TABLE "communications" ADD COLUMN "metadata" TEXT;
ALTER TABLE "communications" ADD COLUMN "relatedEntityId" TEXT;

-- CreateTable
CREATE TABLE "suppressed_contacts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "normalizedEmail" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "contactId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "outbound_send_log" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "idempotencyKey" TEXT NOT NULL,
    "taskId" TEXT,
    "contactId" TEXT,
    "emailId" TEXT,
    "status" TEXT NOT NULL,
    "providerMessageId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "approval_requests" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "action" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "proposedContent" TEXT NOT NULL,
    "supportingContext" TEXT,
    "riskClassification" TEXT NOT NULL,
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

-- CreateTable
CREATE TABLE "product_categories" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "positioning" TEXT,
    "certifications" TEXT,
    "minOrderQuantity" TEXT,
    "productionTimeNotes" TEXT,
    "costingRulesJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_companies" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "industry" TEXT,
    "website" TEXT,
    "phone" TEXT,
    "address" TEXT,
    "notes" TEXT,
    "domain" TEXT,
    "possibleDuplicate" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_companies" ("address", "createdAt", "id", "industry", "name", "notes", "phone", "updatedAt", "website") SELECT "address", "createdAt", "id", "industry", "name", "notes", "phone", "updatedAt", "website" FROM "companies";
DROP TABLE "companies";
ALTER TABLE "new_companies" RENAME TO "companies";
CREATE INDEX "companies_domain_idx" ON "companies"("domain");
CREATE TABLE "new_contacts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "title" TEXT,
    "companyId" TEXT,
    "notes" TEXT,
    "normalizedEmail" TEXT,
    "possibleDuplicate" BOOLEAN NOT NULL DEFAULT false,
    "unsubscribed" BOOLEAN NOT NULL DEFAULT false,
    "lastContactedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "contacts_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_contacts" ("companyId", "createdAt", "email", "firstName", "id", "lastName", "notes", "phone", "title", "updatedAt") SELECT "companyId", "createdAt", "email", "firstName", "id", "lastName", "notes", "phone", "title", "updatedAt" FROM "contacts";
DROP TABLE "contacts";
ALTER TABLE "new_contacts" RENAME TO "contacts";
CREATE INDEX "contacts_normalizedEmail_idx" ON "contacts"("normalizedEmail");
CREATE TABLE "new_emails" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "contactId" TEXT,
    "direction" TEXT NOT NULL,
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "emails_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_emails" ("body", "contactId", "createdAt", "direction", "id", "status", "subject") SELECT "body", "contactId", "createdAt", "direction", "id", "status", "subject" FROM "emails";
DROP TABLE "emails";
ALTER TABLE "new_emails" RENAME TO "emails";
CREATE UNIQUE INDEX "emails_providerMessageId_key" ON "emails"("providerMessageId");
CREATE UNIQUE INDEX "emails_idempotencyKey_key" ON "emails"("idempotencyKey");
CREATE INDEX "emails_threadId_idx" ON "emails"("threadId");
CREATE INDEX "emails_relatedLeadId_idx" ON "emails"("relatedLeadId");
CREATE TABLE "new_leads" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT,
    "contactId" TEXT,
    "source" TEXT,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "value" REAL,
    "notes" TEXT,
    "possibleDuplicate" BOOLEAN NOT NULL DEFAULT false,
    "researchRunId" TEXT,
    "qualification" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "leads_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "leads_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_leads" ("companyId", "contactId", "createdAt", "id", "notes", "source", "status", "updatedAt", "value") SELECT "companyId", "contactId", "createdAt", "id", "notes", "source", "status", "updatedAt", "value" FROM "leads";
DROP TABLE "leads";
ALTER TABLE "new_leads" RENAME TO "leads";
CREATE INDEX "leads_researchRunId_idx" ON "leads"("researchRunId");
CREATE TABLE "new_quotes" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT,
    "companyId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "total" REAL,
    "totalIsComputed" BOOLEAN NOT NULL DEFAULT false,
    "approvalRequestId" TEXT,
    "sentAt" DATETIME,
    "lineItems" TEXT,
    "leadId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "quotes_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "quotes_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_quotes" ("clientId", "companyId", "createdAt", "id", "lineItems", "status", "total", "updatedAt") SELECT "clientId", "companyId", "createdAt", "id", "lineItems", "status", "total", "updatedAt" FROM "quotes";
DROP TABLE "quotes";
ALTER TABLE "new_quotes" RENAME TO "quotes";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "suppressed_contacts_normalizedEmail_key" ON "suppressed_contacts"("normalizedEmail");

-- CreateIndex
CREATE UNIQUE INDEX "outbound_send_log_idempotencyKey_key" ON "outbound_send_log"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "approval_requests_idempotencyKey_key" ON "approval_requests"("idempotencyKey");

-- CreateIndex
CREATE INDEX "approval_requests_status_idx" ON "approval_requests"("status");

-- CreateIndex
CREATE INDEX "approval_requests_taskId_idx" ON "approval_requests"("taskId");

-- CreateIndex
CREATE UNIQUE INDEX "product_categories_name_key" ON "product_categories"("name");

-- CreateIndex
CREATE INDEX "communications_relatedEntityId_idx" ON "communications"("relatedEntityId");
