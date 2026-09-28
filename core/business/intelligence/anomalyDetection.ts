// core/business/intelligence/anomalyDetection.ts - Phase 11, section 27:
// anomaly detection, deterministic-first (per the phase's own triage
// instruction). No ML/statistics library, no LLM - a small set of
// documented, threshold-based rules over real counts, comparing the current
// window against the immediately preceding window of the same length.
import type { IntelligenceStatement } from "./types";
import { unknownStatement } from "./types";
import { prisma } from "../../../database/client";
import type { ResolvedWindow } from "./timeWindows";

export interface Anomaly {
  metric: string;
  currentValue: number;
  previousValue: number;
  percentChange: number | null;
  description: string;
}

const DROP_THRESHOLD_PCT = -50; // a >=50% drop vs. the prior window of equal length
const SPIKE_THRESHOLD_PCT = 200; // a >=200% increase vs. the prior window

function percentChange(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null; // undefined % change from zero baseline - never divide by zero
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

/**
 * Compares a small, fixed set of real counts (new leads created, outbound
 * emails sent, outbound WhatsApp sent, new communications received) between
 * `window` and the immediately preceding window of the same duration.
 * Flags a metric as anomalous only when the percent change crosses an
 * explicit, documented threshold - never a vague "looks off" judgment.
 */
export async function detectAnomalies(window: ResolvedWindow): Promise<IntelligenceStatement<Anomaly[]>> {
  const durationMs = window.end.getTime() - window.start.getTime();
  const prevStart = new Date(window.start.getTime() - durationMs);
  const prevEnd = window.start;

  const metrics: Array<{ metric: string; where: (start: Date, end: Date) => Promise<number> }> = [
    { metric: "new_leads", where: (s, e) => prisma.lead.count({ where: { createdAt: { gte: s, lt: e } } }) },
    { metric: "outbound_emails", where: (s, e) => prisma.email.count({ where: { channel: "EMAIL", direction: "outbound", status: "SENT", createdAt: { gte: s, lt: e } } }) },
    { metric: "outbound_whatsapp", where: (s, e) => prisma.email.count({ where: { channel: "WHATSAPP", direction: "outbound", status: "SENT", createdAt: { gte: s, lt: e } } }) },
    { metric: "inbound_communications", where: (s, e) => prisma.communication.count({ where: { direction: "inbound", createdAt: { gte: s, lt: e } } }) },
  ];

  const anomalies: Anomaly[] = [];
  for (const m of metrics) {
    const [current, previous] = await Promise.all([m.where(window.start, window.end), m.where(prevStart, prevEnd)]);
    const change = percentChange(current, previous);
    if (change === null) continue; // undefined baseline - not flaggable
    if (change <= DROP_THRESHOLD_PCT || change >= SPIKE_THRESHOLD_PCT) {
      anomalies.push({
        metric: m.metric,
        currentValue: current,
        previousValue: previous,
        percentChange: change,
        description: `${m.metric}: ${current} in ${window.label} vs. ${previous} in the prior equal-length window (${change > 0 ? "+" : ""}${change}%).`,
      });
    }
  }

  if (anomalies.length === 0) {
    return unknownStatement("anomaly_detection.result", `Anomaly scan (${window.label})`, "no metric crossed the configured drop/spike thresholds - not an error, just nothing to report.");
  }
  return {
    id: "anomaly_detection.result",
    type: "OBSERVATION",
    label: `Anomaly scan (${window.label})`,
    value: anomalies,
    narrative: `${anomalies.length} metric(s) crossed the configured threshold (drop <= ${DROP_THRESHOLD_PCT}% or spike >= ${SPIKE_THRESHOLD_PCT}% vs. the prior equal-length window).`,
    provenance: { sourceIds: [], sourceModel: "Lead+Email+Communication", dateRangeStart: window.start.toISOString(), dateRangeEnd: window.end.toISOString(), calculationMethod: `Percent change vs. prior equal-length window; thresholds: drop<=${DROP_THRESHOLD_PCT}%, spike>=${SPIKE_THRESHOLD_PCT}%.` },
  };
}
