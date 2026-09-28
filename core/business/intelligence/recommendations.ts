// core/business/intelligence/recommendations.ts - Phase 11, sections 35-37:
// decision support / recommendation engine.
//
// SAFETY-CRITICAL GUARANTEE: this file NEVER calls any send/call/browser
// function, NEVER creates a Task/FollowUp itself, and NEVER writes anything
// to the DB. It only reads already-computed IntelligenceStatement data
// (from salesFunnel.ts/followUpIntelligence.ts/dataQuality.ts/
// anomalyDetection.ts) and returns pure, structured Recommendation objects.
// If a caller (a human, or a future authorized worker step) decides to act
// on a HIGH-priority recommendation, that action must go through the
// existing, separate, fully-guarded pipeline (core/business/followUp.ts's
// scheduleFollowUp() -> Task -> tools/email|whatsapp|voice - approval
// architecture included) - a SEPARATE plan step naming a SEPARATE tool, per
// the phase spec's explicit "query safety" requirement (section 46). This
// file's own tool wrapper (tools/businessIntelligence.ts) is verified
// read-only by agents/no-bi-execution-path.test.ts.
import type { Recommendation, IntelligenceStatement } from "./types";
import { getPipelineRisk } from "./salesFunnel";
import { getFollowUpCandidates } from "./followUpIntelligence";
import { getDataQualityReport } from "./dataQuality";
import { detectAnomalies } from "./anomalyDetection";
import type { ResolvedWindow } from "./timeWindows";

function priorityFor(count: number, mediumAt: number, highAt: number): "INFORMATIONAL" | "LOW" | "MEDIUM" | "HIGH" {
  if (count === 0) return "INFORMATIONAL";
  if (count >= highAt) return "HIGH";
  if (count >= mediumAt) return "MEDIUM";
  return "LOW";
}

/**
 * Builds a small set of structured recommendations from already-computed,
 * deterministic BI findings. Every recommendation names its evidence
 * (the IntelligenceStatement it came from) and is hedged, never phrased as
 * a certainty or an instruction that will execute itself.
 */
export async function generateRecommendations(window: ResolvedWindow): Promise<Recommendation[]> {
  const [pipelineRisk, followUpCandidates, dataQuality, anomalies] = await Promise.all([
    getPipelineRisk(),
    getFollowUpCandidates(),
    getDataQualityReport(),
    detectAnomalies(window),
  ]);

  const recs: Recommendation[] = [];

  const riskCount = Array.isArray(pipelineRisk.value) ? pipelineRisk.value.length : 0;
  if (riskCount > 0) {
    recs.push(
      buildRec({
        id: "rec.pipeline_risk_review",
        recommendation: `Review ${riskCount} open lead(s) that have not been updated within their stage's expected window.`,
        evidence: [pipelineRisk],
        reason: "Leads sitting past their stage's staleness threshold are a common precursor to lost opportunities, though not a certain one.",
        expectedImpact: "Reduces the risk of leads silently stalling; no guaranteed dollar impact without further human judgment.",
        risks: ["Some flagged leads may simply be legitimately slow-moving (e.g. long procurement cycles) - review before acting."],
        requiredInfo: ["Current status of each flagged lead from the account owner, if not already in CRM notes."],
        confidence: "MEDIUM",
        priority: priorityFor(riskCount, 3, 8),
        actionType: "REVIEW_PIPELINE",
      })
    );
  }

  const candidateCount = Array.isArray(followUpCandidates.value) ? followUpCandidates.value.length : 0;
  if (candidateCount > 0) {
    recs.push(
      buildRec({
        id: "rec.follow_up_candidates",
        recommendation: `Consider scheduling a follow-up for ${candidateCount} lead(s) with no reply since the last outbound message.`,
        evidence: [followUpCandidates],
        reason: "These leads have gone quiet on every channel since the last outbound message and have not yet replied.",
        expectedImpact: "Keeps engaged-but-quiet leads from going cold; actual conversion impact is not knowable in advance.",
        risks: ["A follow-up sent too soon or too often can annoy a prospect - respect the existing cooldown/suppression rules."],
        requiredInfo: [],
        confidence: "MEDIUM",
        priority: priorityFor(candidateCount, 3, 8),
        actionType: "FOLLOW_UP",
      })
    );
  }

  const dq = dataQuality.value;
  const dqIssues = dq ? dq.duplicateCompanies + dq.duplicateContacts + dq.duplicateLeads + dq.contactsMissingEmailAndPhone : 0;
  if (dqIssues > 0) {
    recs.push(
      buildRec({
        id: "rec.data_quality_cleanup",
        recommendation: `Review and resolve ${dqIssues} flagged data-quality issue(s) (possible duplicates / missing contact info).`,
        evidence: [dataQuality],
        reason: "Unresolved duplicates and missing contact fields degrade every downstream BI metric and outbound targeting decision.",
        expectedImpact: "More accurate KPIs and fewer misdirected/duplicate outreach attempts.",
        risks: ["Merging flagged duplicates requires a human decision - this system never auto-merges records."],
        requiredInfo: [],
        confidence: "HIGH",
        priority: priorityFor(dqIssues, 5, 15),
        actionType: "DATA_CLEANUP",
      })
    );
  }

  const anomalyList = Array.isArray(anomalies.value) ? anomalies.value : [];
  if (anomalyList.length > 0) {
    recs.push(
      buildRec({
        id: "rec.anomaly_review",
        recommendation: `Investigate ${anomalyList.length} metric(s) that moved sharply versus the prior period.`,
        evidence: [anomalies],
        reason: "A large swing in a core activity metric can indicate a real business change (good or bad) or a broken integration - worth a look either way.",
        expectedImpact: "Early detection of a business or system issue.",
        risks: ["A threshold crossing is not itself proof of a real problem - could reflect normal small-sample volatility."],
        requiredInfo: [],
        confidence: "LOW",
        priority: priorityFor(anomalyList.length, 2, 4),
        actionType: "ESCALATE",
      })
    );
  }

  return recs;
}

function buildRec(input: Omit<Recommendation, "evidence"> & { evidence: IntelligenceStatement[] }): Recommendation {
  return { ...input };
}
