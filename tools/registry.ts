// tools/registry.ts - the Tool Registry (spec section 43).
//
// This is the concrete mechanism that makes "JARVIS can execute registered
// tools" true: tools implement the `Tool` interface, register themselves
// here, and the orchestrator (or an agent) invokes them by name.
import { log } from "../security/logger";
import { guardToolExecution } from "../core/enforcement";

export interface ToolInputSchema {
  /** JSON-schema-ish description, kept simple for Phase 1. */
  type: "object";
  properties: Record<string, { type: string; description?: string }>;
  required?: string[];
}

export type ToolStatus =
  | "OK"
  | "NOT_IMPLEMENTED"
  | "CONFIGURATION_REQUIRED"
  | "ERROR"
  // Set only by the enforcement gate (core/enforcement) when the Autonomy
  // Policy Engine or the global/per-tool state gate refuses to run the tool.
  | "BLOCKED";

export interface ToolResult {
  status: ToolStatus;
  message: string;
  data?: unknown;
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  execute(input: Record<string, unknown>): Promise<ToolResult>;
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered.`);
    }
    // Mutate the tool object's own `execute` in place so that EVERY caller
    // - the registry's own execute() below, apps/api routes, the scheduler,
    // or an agent that imported the tool module directly and holds a
    // reference to the same object - goes through the enforcement gate
    // (system state -> per-tool disable -> rate limits -> policy engine).
    // There is no unguarded `tool.execute` left to call once this returns.
    const original = tool.execute.bind(tool);
    tool.execute = guardToolExecution(tool.name, original);
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return Array.from(this.tools.values());
  }

  async execute(
    name: string,
    input: Record<string, unknown> = {}
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        status: "ERROR",
        message: `No tool registered with name "${name}". Known tools: ${Array.from(
          this.tools.keys()
        ).join(", ")}`,
      };
    }

    log("TOOL", `tool.execute:${name}`, { input });
    try {
      const result = await tool.execute(input);
      log("TOOL", `tool.result:${name}`, { status: result.status });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log("ERROR", `tool.error:${name}`, { error: message });
      return { status: "ERROR", message };
    }
  }
}

// Singleton registry shared by the orchestrator, agents, and the API layer.
export const toolRegistry = new ToolRegistry();
