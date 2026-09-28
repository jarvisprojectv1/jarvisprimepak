// tools/files.ts - the one tool in Phase 1 that does something genuinely real:
// read/write/list files inside a sandboxed directory (never outside it).
import fs from "node:fs/promises";
import path from "node:path";
import type { Tool, ToolResult } from "./registry";
import { appConfig } from "../config/env";

function resolveSafePath(relativePath: string): string {
  const sandboxRoot = path.resolve(appConfig.sandboxDir);
  const resolved = path.resolve(sandboxRoot, relativePath);
  if (!resolved.startsWith(sandboxRoot)) {
    throw new Error("Path escapes the sandbox directory.");
  }
  return resolved;
}

export const filesTool: Tool = {
  name: "files",
  description:
    "Read, write, and list files inside a sandboxed directory (data/sandbox). Actions: 'read', 'write', 'list'.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", description: "'read' | 'write' | 'list'" },
      path: { type: "string", description: "Path relative to the sandbox root" },
      content: { type: "string", description: "Content to write (for action='write')" },
    },
    required: ["action"],
  },
  async execute(input): Promise<ToolResult> {
    const action = input.action as string | undefined;
    const relPath = (input.path as string | undefined) ?? ".";

    try {
      await fs.mkdir(appConfig.sandboxDir, { recursive: true });

      if (action === "list") {
        const target = resolveSafePath(relPath);
        const entries = await fs.readdir(target, { withFileTypes: true });
        return {
          status: "OK",
          message: `Listed ${entries.length} entries.`,
          data: entries.map((e) => ({
            name: e.name,
            type: e.isDirectory() ? "directory" : "file",
          })),
        };
      }

      if (action === "read") {
        const target = resolveSafePath(relPath);
        const content = await fs.readFile(target, "utf-8");
        return { status: "OK", message: "File read.", data: { content } };
      }

      if (action === "write") {
        const target = resolveSafePath(relPath);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, (input.content as string) ?? "", "utf-8");
        return { status: "OK", message: `Wrote ${relPath}.` };
      }

      return {
        status: "ERROR",
        message: `Unknown action "${action}". Use 'read', 'write', or 'list'.`,
      };
    } catch (err) {
      return {
        status: "ERROR",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  },
};
