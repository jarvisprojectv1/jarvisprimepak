// tools/browser.ts - Phase 4 territory (browser control / automation).
// Not implemented in Phase 1: there is no headless-browser integration wired
// up. This stub exists so the registry, orchestrator, and UI have a real
// contract to call against, and returns an explicit NOT_IMPLEMENTED status
// rather than fabricating a browsing result.
import type { Tool, ToolResult } from "./registry";

export const browserTool: Tool = {
  name: "browser",
  description:
    "Control a web browser (navigate, click, extract content). NOT IMPLEMENTED in Phase 1.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", description: "e.g. 'navigate', 'click', 'extract'" },
      url: { type: "string", description: "Target URL" },
    },
    required: ["action"],
  },
  async execute(): Promise<ToolResult> {
    return {
      status: "NOT_IMPLEMENTED",
      message:
        "Browser automation is planned for a later phase. No browser integration is wired up yet.",
    };
  },
};
