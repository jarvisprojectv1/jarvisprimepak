// tools/computer/computerTool.ts - the `computer` Tool (Phase 10). Replaces
// the old permanent Phase-1 stub with a typed ComputerProvider-backed
// implementation - still honestly NOT_IMPLEMENTED for every real operation,
// see tools/computer/mockProvider.ts's header for why.
import type { Tool, ToolResult } from "../registry";
import type { ComputerProvider } from "../browser/types";
import { MockComputerProvider } from "./mockProvider";

export function createComputerTool(provider: ComputerProvider = new MockComputerProvider()): Tool {
  return {
    name: "computer",
    description:
      "Control the local computer (mouse, keyboard, screen reading, app automation). NOT IMPLEMENTED - no GUI/desktop environment is available in this deployment; every action honestly returns NOT_IMPLEMENTED. See docs for the ComputerProvider interface (architecture-complete, unimplemented).",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "e.g. 'click', 'type', 'screenshot'" },
      },
      required: ["action"],
    },
    async execute(input): Promise<ToolResult> {
      const action = typeof input.action === "string" ? input.action : "";
      const outcome = await (async () => {
        switch (action) {
          case "moveMouse": return provider.moveMouse(0, 0);
          case "clickMouse": return provider.clickMouse(0, 0);
          case "doubleClick": return provider.doubleClick(0, 0);
          case "rightClick": return provider.rightClick(0, 0);
          case "scroll": return provider.scroll("down", 0);
          case "typeText": return provider.typeText("");
          case "pressKey": return provider.pressKey("");
          case "screenshot": return provider.screenshot();
          case "locateVisualTarget": return provider.locateVisualTarget("");
          case "drag": return provider.drag(0, 0, 0, 0);
          case "resize": return provider.resize(0, 0);
          case "focusWindow": return provider.focusWindow("");
          default:
            return { ok: false, message: `Unknown or unimplemented computer action "${action}".` };
        }
      })();
      return { status: "NOT_IMPLEMENTED", message: outcome.message };
    },
  };
}

export const computerTool: Tool = createComputerTool();
