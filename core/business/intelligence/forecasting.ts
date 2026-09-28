// core/business/intelligence/forecasting.ts - Phase 11, sections 28-30
// (lower priority per the phase's own triage - kept intentionally minimal
// and honest rather than a sophisticated model this codebase cannot verify
// the accuracy of).
//
// A single deterministic method: simple moving-average trend over the last
// N equal-length historical windows of new-lead counts, projected one window
// forward. Confidence is explicitly labeled from data volume - never implied
// by tone, never a bare number with no caveat (section 30's requirement).
import { prisma } from "../../../database/client";
import type { IntelligenceStatement } from "./types";
import { unknownStatement } from "./types";
import type { TimeWindowName, ResolvedWindow } from "./timeWindows";
import { resolveTimeWindow } from "./timeWindows";

export interface LeadForecast {
  historicalCounts: number[];
  projectedNextWindow: number;
  method: "simple_moving_average";
}

const WINDOW_SEQUENCE: Record<string, TimeWindowName> = { THIS_WEEK: "THIS_WEEK", THIS_MONTH: "THIS_MONTH" };

/**
 * Projects next-window new-lead count as the average of the last
 * `periods` equal-length historical windows preceding `window`.
 * Confidence: HIGH only with >=8 periods of real data, MEDIUM with >=4,
 * LOW otherwise (fewer than 4 real historical periods is barely a trend at
 * all - documented, not hidden).
 */
export async function forecastNewLeads(window: ResolvedWindow, periods = 8): Promise<IntelligenceStatement<LeadForecast>> {
  const durationMs = window.end.getTime() - window.start.getTime();
  const counts: number[] = [];
  for (let i = periods; i >= 1; i -= 1) {
    const start = new Date(window.start.getTime() - i * durationMs);
    const end = new Date(start.getTime() + durationMs);
    // eslint-disable-next-line no-await-in-loop -- small, bounded (<=periods) sequential historical scan; deterministic, not a hot path.
    const count = await prisma.lead.count({ where: { createdAt: { gte: start, lt: end } } });
    counts.push(count);
  }

  const nonZeroPeriods = counts.filter((c) => c > 0).length;
  if (nonZeroPeriods === 0) {
    return unknownStatement("forecast.new_leads", "New-lead forecast", "No historical lead-creation data in any of the preceding periods to project from.");
  }

  const avg = counts.reduce((a, b) => a + b, 0) / counts.length;
  const projected = Math.round(avg);
  const confidence: "LOW" | "MEDIUM" | "HIGH" = nonZeroPeriods >= 8 ? "HIGH" : nonZeroPeriods >= 4 ? "MEDIUM" : "LOW";

  return {
    id: "forecast.new_leads",
    type: "FORECAST",
    label: `New-lead forecast for the period after ${window.label}`,
    value: { historicalCounts: counts, projectedNextWindow: projected, method: "simple_moving_average" },
    narrative: `Projected ~${projected} new lead(s) next period, based on a simple moving average of the last ${counts.length} equal-length periods (${nonZeroPeriods} with non-zero data). This is a deterministic trend projection, not a guarantee.`,
    provenance: { sourceIds: [], sourceModel: "Lead", calculationMethod: `Average of Lead.count(createdAt in window) over the ${periods} equal-length periods preceding ${window.label}.` },
    confidence,
  };
}

export { resolveTimeWindow };
