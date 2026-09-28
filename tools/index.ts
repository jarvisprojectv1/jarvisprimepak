// tools/index.ts - registers every built-in tool into the shared registry.
// Import this once at process startup (apps/api/src/index.ts does this)
// before the orchestrator tries to execute any tool by name.
import { toolRegistry } from "./registry";
import { filesTool } from "./files";
import { browserTool } from "./browser/browserTool";
import { computerTool } from "./computer/computerTool";
import { emailTool } from "./email/emailTool";
import { whatsappTool } from "./whatsapp/whatsappTool";
import { calendarTool } from "./calendar";
import { voiceTool } from "./voice";
import { webTool } from "./web";
import { reportsTool } from "./reports";
import { webSearchTool, webFetchTool } from "./web/index";

let registered = false;

export function registerBuiltinTools(): void {
  if (registered) return;
  for (const tool of [
    filesTool,
    browserTool,
    computerTool,
    emailTool,
    whatsappTool,
    calendarTool,
    voiceTool,
    webTool,
    reportsTool,
    // Phase 6: real (but honestly CONFIGURATION_REQUIRED-when-uncredentialed)
    // web search/fetch tools, replacing webTool's permanent stub for anything
    // that actually needs open-web research - see tools/web/.
    webSearchTool,
    webFetchTool,
  ]) {
    if (!toolRegistry.get(tool.name)) {
      toolRegistry.register(tool);
    }
  }
  registered = true;
}

export { toolRegistry } from "./registry";
export type { Tool, ToolResult, ToolStatus } from "./registry";
