// core/business/intelligence/snapshot.ts - Phase 11, section 8:
// BusinessSnapshot creation. Immutable once generated: this module only
// ever CREATES a BusinessSnapshot row, never updates/deletes one (no
// `.update`/`.delete` call anywhere in this file - see
// snapshot.test.ts's "never mutates" assertion). Deterministic idempotency
// key: `${snapshotType}:${periodStart}:${periodEnd}`, DB-unique-constrained
// (periodKey + snapshotType), so a worker retry regenerating the same
// period cannot create a duplicate row - the same idempotency discipline
// core/business/idempotency.ts already established for outbound sends,
// applied here via BusinessSnapshot's own unique constraint (not
// OutboundSendLog, which is send-specific).
import { prisma } from "../../../database/client";
import type { IntelligenceStatement } from "./types";
import type { ResolvedWindow } from "./timeWindows";
import { getSalesFunnel, getPipelineConversion, getPipelineRisk } from "./salesFunnel";
import { getCommunicationStats } from "./customerIntelligence";
import { getDataQualityReport } from "./dataQuality";
import { detectAnomalies } from "./anomalyDetection";
import { getFollowUpCandidates } from "./followUpIntelligence";

export type SnapshotType = "DAILY" | "WEEKLY" | "MONTHLY" | "CUSTOM";

export function computePeriodKey(snapshotType: SnapshotType, window: ResolvedWindow): string {
  return `${snapshotType}:${window.start.toISOString()}:${window.end.toISOString()}`;
}

export interface BusinessSnapshotRecord {
  id: string;
  periodKey: string;
  snapshotType: SnapshotType;
  periodStart: Date;
  periodEnd: Date;
  generatedAt: Date;
  statements: Record<string, IntelligenceStatement>;
}

/** Computes the full deterministic statement set for a period - the same set every executive briefing/snapshot draws from. */
export async function computeSnapshotStatements(window: ResolvedWindow): Promise<Record<string, IntelligenceStatement>> {
  const [funnel, conversion, risk, comms, dataQuality, anomalies, followUps] = await Promise.all([
    getSalesFunnel(),
    getPipelineConversion(window),
    getPipelineRisk(),
    getCommunicationStats(window),
    getDataQualityReport(),
    detectAnomalies(window),
    getFollowUpCandidates(),
  ]);
  const all = [funnel, conversion, risk, comms, dataQuality, anomalies, followUps];
  const byId: Record<string, IntelligenceStatement> = {};
  for (const s of all) byId[s.id] = s;
  return byId;
}

/**
 * Gets-or-creates the BusinessSnapshot for this exact period+type. If one
 * already exists (the idempotency key already claimed), returns it AS-IS -
 * never regenerates/overwrites it (immutability). Callers that want a fresh
 * view of a period that already has a snapshot should generate a new
 * snapshotType/period rather than expecting this to mutate the old one.
 */
export async function getOrCreateBusinessSnapshot(snapshotType: SnapshotType, window: ResolvedWindow): Promise<BusinessSnapshotRecord> {
  const periodKey = computePeriodKey(snapshotType, window);

  const existing = await prisma.businessSnapshot.findUnique({ where: { periodKey_snapshotType: { periodKey, snapshotType } } });
  if (existing) {
    return {
      id: existing.id,
      periodKey: existing.periodKey,
      snapshotType: existing.snapshotType as SnapshotType,
      periodStart: existing.periodStart,
      periodEnd: existing.periodEnd,
      generatedAt: existing.generatedAt,
      statements: JSON.parse(existing.metricsJson) as Record<string, IntelligenceStatement>,
    };
  }

  const statements = await computeSnapshotStatements(window);
  const provenance = Object.fromEntries(Object.entries(statements).map(([id, s]) => [id, s.provenance]));

  try {
    const created = await prisma.businessSnapshot.create({
      data: {
        periodKey,
        snapshotType,
        periodStart: window.start,
        periodEnd: window.end,
        metricsJson: JSON.stringify(statements),
        provenanceJson: JSON.stringify(provenance),
      },
    });
    return {
      id: created.id,
      periodKey: created.periodKey,
      snapshotType: created.snapshotType as SnapshotType,
      periodStart: created.periodStart,
      periodEnd: created.periodEnd,
      generatedAt: created.generatedAt,
      statements,
    };
  } catch {
    // Unique-constraint race: another caller created it between our read and
    // write. Re-read rather than fail - still never a duplicate row.
    const raced = await prisma.businessSnapshot.findUnique({ where: { periodKey_snapshotType: { periodKey, snapshotType } } });
    if (!raced) throw new Error("BusinessSnapshot creation failed and no existing row was found for its idempotency key.");
    return {
      id: raced.id,
      periodKey: raced.periodKey,
      snapshotType: raced.snapshotType as SnapshotType,
      periodStart: raced.periodStart,
      periodEnd: raced.periodEnd,
      generatedAt: raced.generatedAt,
      statements: JSON.parse(raced.metricsJson) as Record<string, IntelligenceStatement>,
    };
  }
}
