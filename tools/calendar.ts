// tools/calendar.ts - real calendar integration (e.g. Google Calendar)
// requires OAuth credentials not configured in Phase 1.
import type { Tool, ToolResult } from "./registry";

export const calendarTool: Tool = {
  name: "calendar",
  description:
    "Create/read calendar events. CONFIGURATION REQUIRED: GOOGLE_CALENDAR_CLIENT_ID/SECRET.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", description: "e.g. 'create', 'list'" },
      title: { type: "string" },
      startAt: { type: "string" },
    },
    required: ["action"],
  },
  async execute(): Promise<ToolResult> {
    if (!process.env.GOOGLE_CALENDAR_CLIENT_ID) {
      return {
        status: "CONFIGURATION_REQUIRED",
        message:
          "CONFIGURATION REQUIRED: GOOGLE_CALENDAR_CLIENT_ID / GOOGLE_CALENDAR_CLIENT_SECRET must be set (see .env.example).",
      };
    }
    return {
      status: "NOT_IMPLEMENTED",
      message: "Calendar integration is configured but not yet implemented.",
    };
  },
};
