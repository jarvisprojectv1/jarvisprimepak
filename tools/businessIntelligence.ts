// tools/businessIntelligence.ts - Phase 11, section 46: the Brain-callable
// BI query tool. READ-ONLY BY CONSTRUCTION.
//
// SAFETY GUARANTEE: this file's `execute()` has NO code path that calls any
// send/call/browser-action function, and NEVER writes to the database. It
// only calls core/business/intelligence/* functions, which are themselves
// pure read/aggregation queries. "Analyze all customers and then contact
// them" therefore CANNOT implicitly chain into a send within this one tool
// call - the Brain would need a genuinely separate plan step naming a
// separate tool (e.g. "email") for any actual send, which then goes through
// the full suppression/anti-spam/idempotency/risk/approval pipeline again,
// exactly like every other outbound action in this codebase. Verified by
// agents/no-bi-execution-path.test.ts (source-level: no `.sendMessage(`/
// `.createCall(`/browser-execute call site in this file or anything it
// imports from core/business/intelligence).
import type { Tool, ToolResult } from "./registry";
import { resolveTimeWindow, type TimeWindowName } from "../core/business/intelligence/timeWindows";
import { buildExecutiveBriefing } from "../core/business/intelligence/executiveBriefing";
import type { SnapshotType } from "../core/business/intelligence/snapshot";
import { getSalesFunnel, getPipelineConversion, getPipelineRisk, prioritizeOpenLeads } from "../core/business/intelligence/salesFunnel";
import { getFollowUpCandidates } from "../core/business/intelligence/followUpIntelligence";
import { getDataQualityReport, listFlaggedDuplicates } from "../core/business/intelligence/dataQuality";
import { detectAnomalies } from "../core/business/intelligence/anomalyDetection";
import { generateRecommendations } from "../core/business/intelligence/recommendations";

const VALID_ACTIONS = [
  "sales_funnel",
  "pipeline_risk",
  "follow_up_candidates",
  "data_quality",
  "flagged_duplicates",
  "anomalies",
  "recommendations",
  "lead_priorities",
  "executive_briefing",
] as const;

function windowNameOf(input: Record<string, unknown>): TimeWindowName {
  const raw = typeof input.window === "string" ? input.window : "THIS_WEEK";
  const valid: TimeWindowName[] = ["TODAY", "YESTERDAY", "THIS_WEEK", "LAST_WEEK", "THIS_MONTH", "LAST_MONTH", "THIS_QUARTER", "LAST_QUARTER"];
  return (valid as string[]).includes(raw) ? (raw as TimeWindowName) : "THIS_WEEK";
}

function snapshotTypeFor(windowName: TimeWindowName): SnapshotType {
  if (windowName === "TODAY" || windowName === "YESTERDAY") return "DAILY";
  if (windowName === "THIS_WEEK" || windowName === "LAST_WEEK") return "WEEKLY";
  if (windowName === "THIS_MONTH" || windowName === "LAST_MONTH" || windowName === "THIS_QUARTER" || windowName === "LAST_QUARTER") return "MONTHLY";
  return "CUSTOM";
}

export const businessIntelligenceTool: Tool = {
  name: "business_intelligence",
  description:
    "Read-only business-intelligence queries over real CRM data (sales funnel, pipeline risk, follow-up candidates, data quality, anomalies, recommendations, lead scoring, executive briefing). Never sends any message/call and never writes to the database - a genuinely separate tool call is required for any actual outbound action.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", description: `One of: ${VALID_ACTIONS.join(", ")}. Defaults to 'executive_briefing'.` },
      window: { type: "string", description: "TODAY | YESTERDAY | THIS_WEEK | LAST_WEEK | THIS_MONTH | LAST_MONTH | THIS_QUARTER | LAST_QUARTER (defaults to THIS_WEEK)." },
    },
  },
  async execute(input): Promise<ToolResult> {
    const action = (typeof input.action === "string" ? input.action : "executive_briefing") as (typeof VALID_ACTIONS)[number];
    const window = resolveTimeWindow(windowNameOf(input));

    switch (action) {
      case "sales_funnel": {
        const data = await getSalesFunnel();
        return { status: "OK", message: data.narrative, data };
      }
      case "pipeline_risk": {
        const data = await getPipelineRisk();
        return { status: "OK", message: data.narrative, data };
      }
      case "follow_up_candidates": {
        const data = await getFollowUpCandidates();
        return { status: "OK", message: data.narrative, data };
      }
      case "data_quality": {
        const data = await getDataQualityReport();
        return { status: "OK", message: data.narrative, data };
      }
      case "flagged_duplicates": {
        const data = await listFlaggedDuplicates();
        return { status: "OK", message: data.narrative, data };
      }
      case "anomalies": {
        const data = await detectAnomalies(window);
        return { status: "OK", message: data.narrative, data };
      }
      case "recommendations": {
        const data = await generateRecommendations(window);
        return { status: "OK", message: `${data.length} recommendation(s) generated.`, data };
      }
      case "lead_priorities": {
        const data = await prioritizeOpenLeads();
        return { status: "OK", message: `${data.length} open lead(s) scored and ranked.`, data };
      }
      case "executive_briefing":
      default: {
        // Deterministic-only (no aiProvider passed) - a narrative-generating
        // caller must use core/business/intelligence/executiveBriefing.ts
        // directly with an AIProvider, going through its own cost-control/
        // grounding path; this Brain-callable tool never triggers an LLM
        // call on its own to keep tool calls cheap and side-effect-free.
        const chosenWindow = windowNameOf(input);
        const briefing = await buildExecutiveBriefing({ windowName: chosenWindow, snapshotType: snapshotTypeFor(chosenWindow), now: new Date() });
        return { status: "OK", message: `Executive briefing for ${briefing.periodLabel}: ${briefing.recommendations.length} recommendation(s).`, data: briefing };
      }
    }
  },
};
