// tools/registry.ts - the Tool Registry (spec section 43).
//
// This is the concrete mechanism that makes "JARVIS can execute registered
// tools" true: tools implement the `Tool` interface, register themselves
// here, and the orchestrator (or an agent) invokes them by name.
import { log } from "../security/logger";

export interface ToolInputSchema {
  /** JSON-schema-ish description, kept simple for Phase 1. */
  type: "object";
  properties: Record<string, { type: string; description?: string }>;
  required?: string[];
}

export type ToolStatus = "OK" | "NOT_IMPLEMENTED" | "CONFIGURATION_REQUIRED" | "ERROR";

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
