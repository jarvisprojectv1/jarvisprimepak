// tools/email.ts - sending real email requires SMTP credentials that are not
// configured in Phase 1. Returns CONFIGURATION_REQUIRED (not NOT_IMPLEMENTED)
// because the *code path* exists conceptually - it's the third-party
// configuration that is missing.
import type { Tool, ToolResult } from "./registry";

export const emailTool: Tool = {
  name: "email",
  description: "Send an email via SMTP. CONFIGURATION REQUIRED: SMTP_* env vars.",
  inputSchema: {
    type: "object",
    properties: {
      to: { type: "string" },
      subject: { type: "string" },
      body: { type: "string" },
    },
    required: ["to", "subject", "body"],
  },
  async execute(): Promise<ToolResult> {
    if (!process.env.SMTP_HOST || !process.env.SMTP_USER) {
      return {
        status: "CONFIGURATION_REQUIRED",
        message:
          "CONFIGURATION REQUIRED: SMTP_HOST, SMTP_USER, SMTP_PASSWORD (see .env.example) must be set to send email.",
      };
    }
    // A real SMTP client (e.g. nodemailer) would be wired in here in Phase 2.
    return {
      status: "NOT_IMPLEMENTED",
      message: "SMTP is configured, but email sending is not yet implemented.",
    };
  },
};
