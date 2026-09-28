-- CreateTable
CREATE TABLE "business_snapshots" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "periodKey" TEXT NOT NULL,
    "snapshotType" TEXT NOT NULL,
    "periodStart" DATETIME NOT NULL,
    "periodEnd" DATETIME NOT NULL,
    "generatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metricsJson" TEXT NOT NULL,
    "provenanceJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "business_snapshots_snapshotType_periodStart_idx" ON "business_snapshots"("snapshotType", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "business_snapshots_periodKey_snapshotType_key" ON "business_snapshots"("periodKey", "snapshotType");
