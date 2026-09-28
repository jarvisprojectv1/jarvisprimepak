// tools/web.ts - general web search/fetch. No search provider is configured
// in Phase 1 (e.g. no SERP API key), so this always reports what is missing
// rather than fabricating search results.
import type { Tool, ToolResult } from "./registry";

export const webTool: Tool = {
  name: "web",
  description: "Search the web / fetch a URL. CONFIGURATION REQUIRED: no search provider configured.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", description: "'search' | 'fetch'" },
      query: { type: "string" },
      url: { type: "string" },
    },
    required: ["action"],
  },
  async execute(): Promise<ToolResult> {
    return {
      status: "CONFIGURATION_REQUIRED",
      message:
        "CONFIGURATION REQUIRED: no web search/fetch provider is configured yet. This will be wired up in a later phase.",
    };
  },
};
