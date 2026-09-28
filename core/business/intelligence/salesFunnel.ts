// core/business/intelligence/salesFunnel.ts - Phase 11, sections 10-13:
// sales funnel, pipeline health, and lead scoring/prioritization.
//
// Uses the ACTUAL Lead.status pipeline (core/crm/pipeline.ts's LEAD_STATUSES
// - NEW/RESEARCHING/QUALIFIED/CONTACTED/RESPONDED/SAMPLE_REQUESTED/QUOTING/
// NEGOTIATION/WON/LOST/NURTURE), never invented stage names. Every finding is
// deterministic (a real DB aggregation), hedged where it involves any
// judgment (pipeline-risk language never claims a definitive prediction),
// and returned as IntelligenceStatement so callers can see its provenance.
import { prisma } from "../../../database/client";
import { LEAD_STATUSES, type LeadStatus } from "../../crm/pipeline";
import type { IntelligenceStatement, Provenance } from "./types";
import { unknownStatement } from "./types";
import type { ResolvedWindow } from "./timeWindows";

const OPEN_STATUSES: LeadStatus[] = LEAD_STATUSES.filter((s) => s !== "WON" && s !== "LOST") as LeadStatus[];

export interface FunnelStageCount {
  status: LeadStatus;
  count: number;
}

/** Section 10: current count of open leads per pipeline stage - a real, live groupBy, never a cached/stale number. */
export async function getSalesFunnel(): Promise<IntelligenceStatement<FunnelStageCount[]>> {
  const rows = await prisma.lead.groupBy({ by: ["status"], _count: { status: true } });
  const byStatus = new Map(rows.map((r) => [r.status, r._count.status]));
  const stages: FunnelStageCount[] = LEAD_STATUSES.map((status) => ({ status, count: byStatus.get(status) ?? 0 }));
  const provenance: Provenance = {
    sourceIds: [],
    sourceModel: "Lead",
    calculationMethod: "COUNT(*) GROUP BY status over all Lead rows, at query time.",
  };
  return {
    id: "sales_funnel.current",
    type: "FACT",
    label: "Current sales funnel by stage",
    value: stages,
    narrative: stages.map((s) => `${s.status}: ${s.count}`).join(", "),
    provenance,
  };
}

/** Section 11: stage-to-stage conversion within a window, based on leads that reached WON vs. total leads created in the window. Deliberately simple - Lead has no per-stage-transition history table, so this is a whole-funnel conversion, not per-adjacent-stage (documented, not fabricated). */
export async function getPipelineConversion(window: ResolvedWindow): Promise<IntelligenceStatement<{ created: number; won: number; lost: number; conversionRate: number | null }>> {
  const [created, won, lost] = await Promise.all([
    prisma.lead.count({ where: { createdAt: { gte: window.start, lt: window.end } } }),
    prisma.lead.count({ where: { status: "WON", updatedAt: { gte: window.start, lt: window.end } } }),
    prisma.lead.count({ where: { status: "LOST", updatedAt: { gte: window.start, lt: window.end } } }),
  ]);
  if (created === 0 && won === 0 && lost === 0) {
    return unknownStatement("sales_funnel.conversion", `Pipeline conversion (${window.label})`, "No lead activity in this window.");
  }
  // Conversion rate uses WON transitions in-window over leads CREATED in-window
  // as a simple proxy (a lead can convert in a later window than it was
  // created - this rate therefore approximates, not measures per-cohort
  // conversion; documented in the narrative rather than overclaimed).
  const conversionRate = created > 0 ? Math.round((won / created) * 1000) / 10 : null;
  return {
    id: "sales_funnel.conversion",
    type: "CALCULATION",
    label: `Pipeline conversion (${window.label})`,
    value: { created, won, lost, conversionRate },
    narrative:
      conversionRate !== null
        ? `${created} lead(s) created, ${won} reached WON and ${lost} reached LOST in this window (${conversionRate}% of leads created in this window later reached WON - an approximation, not strict same-cohort tracking).`
        : `${won} lead(s) reached WON and ${lost} reached LOST in this window; no leads were created in this window to compute a rate against.`,
    provenance: { sourceIds: [], sourceModel: "Lead", dateRangeStart: window.start.toISOString(), dateRangeEnd: window.end.toISOString(), calculationMethod: "COUNT(created in window), COUNT(status=WON updated in window), COUNT(status=LOST updated in window)." },
  };
}

export interface PipelineRiskFinding {
  leadId: string;
  status: LeadStatus;
  daysSinceUpdate: number;
  companyName: string | null;
}

const STALE_THRESHOLD_DAYS: Record<string, number> = {
  QUOTING: 7,
  NEGOTIATION: 10,
  CONTACTED: 14,
  QUALIFIED: 14,
  RESPONDED: 7,
  SAMPLE_REQUESTED: 10,
};

/**
 * Section 12: pipeline health - open leads that have not been updated
 * (Lead.updatedAt) in longer than that stage's configured staleness
 * threshold. Findings use explicitly hedged language ("has not been updated
 * recently", never "customer will leave") - Lead has no dedicated
 * stage-change timestamp, so `updatedAt` is the best real proxy available,
 * and the narrative says so rather than implying more precision than exists.
 */
export async function getPipelineRisk(now: Date = new Date()): Promise<IntelligenceStatement<PipelineRiskFinding[]>> {
  const leads = await prisma.lead.findMany({
    where: { status: { in: Object.keys(STALE_THRESHOLD_DAYS) } },
    include: { company: true },
  });
  const findings: PipelineRiskFinding[] = [];
  for (const lead of leads) {
    const threshold = STALE_THRESHOLD_DAYS[lead.status];
    if (!threshold) continue;
    const daysSinceUpdate = Math.floor((now.getTime() - lead.updatedAt.getTime()) / (24 * 60 * 60 * 1000));
    if (daysSinceUpdate >= threshold) {
      findings.push({ leadId: lead.id, status: lead.status as LeadStatus, daysSinceUpdate, companyName: lead.company?.name ?? null });
    }
  }
  return {
    id: "pipeline_risk.stale_leads",
    type: "OBSERVATION",
    label: "Pipeline stage staleness (PIPELINE_RISK)",
    value: findings,
    narrative:
      findings.length === 0
        ? "No open leads currently exceed their stage's configured staleness threshold."
        : `${findings.length} open lead(s) have not been updated in longer than their stage's expected window - worth a human review, not a certain loss. (Based on Lead.updatedAt, the closest available proxy for stage-change recency.)`,
    provenance: { sourceIds: findings.map((f) => f.leadId), sourceModel: "Lead", calculationMethod: `now - Lead.updatedAt compared against a per-stage threshold: ${JSON.stringify(STALE_THRESHOLD_DAYS)}.` },
  };
}

export interface LeadScoreFactor {
  factor: string;
  points: number;
  reason: string;
}

export interface LeadScoreResult {
  leadId: string;
  score: number;
  maxScore: number;
  factors: LeadScoreFactor[];
}

/**
 * Section 13: fully explainable lead scoring - a score plus itemized
 * factors, never an opaque number. Extends (rather than forks)
 * core/crm/qualification.ts's deterministic-rule discipline: reads the
 * lead's persisted `qualification` JSON (from qualifyLead()) as one input
 * signal, and adds pipeline-observable signals qualification doesn't cover
 * (recency of contact, presence of an estimated value, duplicate flag).
 */
export async function scoreLead(leadId: string): Promise<LeadScoreResult | null> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, include: { contact: true } });
  if (!lead) return null;

  const factors: LeadScoreFactor[] = [];

  if (lead.qualification) {
    try {
      const q = JSON.parse(lead.qualification) as { qualified: boolean | "UNKNOWN"; reasons: string[] };
      if (q.qualified === true) factors.push({ factor: "qualification", points: 30, reason: "Lead was deterministically qualified (core/crm/qualification.ts)." });
      else if (q.qualified === "UNKNOWN") factors.push({ factor: "qualification", points: 10, reason: "Qualification result is UNKNOWN - partial credit pending more information." });
      else factors.push({ factor: "qualification", points: 0, reason: "Lead was deterministically disqualified." });
    } catch {
      factors.push({ factor: "qualification", points: 0, reason: "Qualification data present but unparseable - no credit given." });
    }
  } else {
    factors.push({ factor: "qualification", points: 0, reason: "No qualification has been run yet." });
  }

  if (typeof lead.value === "number" && lead.value > 0) {
    const points = lead.value >= 5000 ? 25 : lead.value >= 1000 ? 15 : 5;
    factors.push({ factor: "estimated_value", points, reason: `Lead has an estimated value of ${lead.value}.` });
  } else {
    factors.push({ factor: "estimated_value", points: 0, reason: "No estimated value recorded on this lead." });
  }

  if (lead.contact?.email || lead.contact?.phone) {
    factors.push({ factor: "reachable_contact", points: 15, reason: "Lead has a known contact email or phone number." });
  } else {
    factors.push({ factor: "reachable_contact", points: 0, reason: "No contact email/phone known for this lead." });
  }

  if (["QUOTING", "NEGOTIATION", "SAMPLE_REQUESTED", "RESPONDED"].includes(lead.status)) {
    factors.push({ factor: "stage_momentum", points: 20, reason: `Lead is in an active-engagement stage (${lead.status}).` });
  } else if (["NEW", "RESEARCHING"].includes(lead.status)) {
    factors.push({ factor: "stage_momentum", points: 5, reason: `Lead is early-stage (${lead.status}).` });
  } else {
    factors.push({ factor: "stage_momentum", points: 10, reason: `Lead is in stage ${lead.status}.` });
  }

  if (lead.possibleDuplicate) {
    factors.push({ factor: "data_quality", points: -10, reason: "Lead is flagged as a possible duplicate - unresolved data-quality issue." });
  } else {
    factors.push({ factor: "data_quality", points: 10, reason: "No duplicate flag on this lead." });
  }

  const score = Math.max(0, factors.reduce((sum, f) => sum + f.points, 0));
  return { leadId, score, maxScore: 100, factors };
}

/** Ranks all currently-open leads by scoreLead(), for prioritization (section 13). Bounded (no unlimited full-table LLM-style scan - this is deterministic arithmetic, not an AI call, so a full scan is cheap and safe). */
export async function prioritizeOpenLeads(limit = 50): Promise<LeadScoreResult[]> {
  const openLeads = await prisma.lead.findMany({ where: { status: { in: OPEN_STATUSES as string[] } }, select: { id: true } });
  const scored = await Promise.all(openLeads.map((l) => scoreLead(l.id)));
  return scored
    .filter((s): s is LeadScoreResult => s !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
