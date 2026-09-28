// tools/reports.ts - genuinely generates and persists the Daily Executive
// Report (core/reports/dailyReport.ts). Registered like any other tool, so
// the worker (or a human/Brain) invoking it goes through the exact same
// enforcement gate (state/pause/rate/policy) as every other tool call - see
// docs/PHASE5_AUTONOMOUS_WORKER.md section 8/11.
import type { Tool, ToolResult } from "./registry";
import { generateAndSaveDailyReport, getLatestDailyReport } from "../core/reports/dailyReport";

export const reportsTool: Tool = {
  name: "reports",
  description: "Generate or fetch the Daily Executive Report from real, currently-available data.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", description: "'generate' (default) | 'latest'" },
    },
  },
  async execute(input): Promise<ToolResult> {
    const action = (input.action as string) ?? "generate";
    if (action === "latest") {
      const report = await getLatestDailyReport();
      return report
        ? { status: "OK", message: `Latest daily report is for ${report.date}.`, data: report }
        : { status: "OK", message: "No daily report has been generated yet.", data: null };
    }
    const report = await generateAndSaveDailyReport();
    return {
      status: "OK",
      message: `Generated daily executive report for ${report.date}: ${report.completedTasks.length} completed, ${report.failedTasks.length} failed, ${report.waitingTasks.length} waiting, ${report.blockedTasks.length} blocked task(s).`,
      data: report,
    };
  },
};
