// tools/computer.ts - Phase 4 territory (desktop-native "computer control":
// controlling the mouse/keyboard, reading the screen, driving other apps).
// Not implemented in Phase 1.
import type { Tool, ToolResult } from "./registry";

export const computerTool: Tool = {
  name: "computer",
  description:
    "Control the local computer (mouse, keyboard, screen reading, app automation). NOT IMPLEMENTED in Phase 1.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", description: "e.g. 'click', 'type', 'screenshot'" },
    },
    required: ["action"],
  },
  async execute(): Promise<ToolResult> {
    return {
      status: "NOT_IMPLEMENTED",
      message:
        "Computer control is planned for Phase 4 (desktop app). No native automation is wired up yet.",
    };
  },
};
