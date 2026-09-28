// tools/voice.ts - voice input/output and telephony (cold-calling) are
// explicitly Phase 2/3 territory per the spec. No STT/TTS/telephony provider
// is wired up in Phase 1.
import type { Tool, ToolResult } from "./registry";

export const voiceTool: Tool = {
  name: "voice",
  description:
    "Speech-to-text, text-to-speech, and telephony (calls). NOT IMPLEMENTED in Phase 1.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", description: "e.g. 'transcribe', 'speak', 'call'" },
    },
    required: ["action"],
  },
  async execute(): Promise<ToolResult> {
    return {
      status: "NOT_IMPLEMENTED",
      message:
        "Voice and telephony (including cold-calling) are planned for a later phase.",
    };
  },
};
