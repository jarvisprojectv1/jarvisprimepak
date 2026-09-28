// tools/web/searchTool.ts - WebSearchTool (Phase 6, item 2). A thin Tool
// wrapper around a SearchProvider. Rate limiting / concurrency is already
// enforced generically for every tool by core/enforcement (per-tool rate
// limit, see core/limits.checkToolRate) at registration time - this file
// does not duplicate that gate. Research-specific "max searches per task"
// limits live in core/research/limits.ts and are checked here when a taskId
// is supplied, per item 18.
import type { Tool, ToolResult } from "../registry";
import type { SearchProvider } from "./types";
import { isProviderError } from "./types";
import { createDefaultSearchProvider } from "./searchProvider";
import { checkResearchOpBudget } from "../../core/research/limits";

const DEFAULT_RESULT_COUNT = 10;
const MAX_RESULT_COUNT = 20;

export function createWebSearchTool(provider: SearchProvider = createDefaultSearchProvider()): Tool {
  return {
    name: "web_search",
    description: `Search the web via ${provider.name}. Returns CONFIGURATION_REQUIRED if no provider credential is set.`,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query." },
        count: { type: "string", description: "Max results to return (default 10, max 20)." },
        taskId: { type: "string", description: "Optional task id, for per-task search budget accounting." },
      },
      required: ["query"],
    },
    async execute(input): Promise<ToolResult> {
      const query = typeof input.query === "string" ? input.query.trim() : "";
      if (!query) {
        return { status: "ERROR", message: "web_search requires a non-empty 'query'." };
      }

      const taskId = typeof input.taskId === "string" ? input.taskId : undefined;
      if (taskId) {
        const budget = await checkResearchOpBudget(taskId, "search");
        if (!budget.allowed) {
          return { status: "BLOCKED", message: budget.reason ?? "Search budget exceeded for this task." };
        }
      }

      const rawCount = typeof input.count === "string" ? parseInt(input.count, 10) : (input.count as number | undefined);
      const count = Math.min(Math.max(1, Number.isFinite(rawCount) ? (rawCount as number) : DEFAULT_RESULT_COUNT), MAX_RESULT_COUNT);

      const outcome = await provider.search(query, { count });
      if (isProviderError(outcome)) {
        const status = outcome.code === "CONFIGURATION_REQUIRED" ? "CONFIGURATION_REQUIRED" : outcome.code === "TIMEOUT" ? "ERROR" : "ERROR";
        return { status, message: outcome.message };
      }

      return {
        status: "OK",
        message: `Found ${outcome.length} result(s) for "${query}".`,
        data: { query, results: outcome },
      };
    },
  };
}

export const webSearchTool: Tool = createWebSearchTool();
