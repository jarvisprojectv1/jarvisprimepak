// config/providers.ts - Phase 12 (Production Integration): honest,
// evidence-based provider configuration classification.
//
// Ground rule (per Phase 12 instructions): NEVER report a provider as
// "REAL"/working purely from an env var being set. This module only
// classifies whether the environment VARIABLES an integration needs are
// PRESENT - it never performs a live credential check (no network calls
// here; a live check belongs to the provider's own code, e.g. an actual
// send attempt). "CONFIGURED" here means "the code path for this provider
// will attempt real work instead of returning CONFIGURATION_REQUIRED" -
// whether the credential is actually VALID is only proven the moment a real
// call is attempted and succeeds/fails, which this module does not do.
//
// Each provider's own tool code (tools/email, tools/whatsapp, tools/voice,
// tools/web, core/ai) is the actual source of truth for what env vars it
// requires - this module mirrors those exact checks so operators (and
// GET /system/health, GET /health/ready) have ONE place that answers
// "what still needs configuring", without duplicating or drifting from the
// enforcement-critical tool code itself. Nothing here weakens or bypasses
// any tool's own CONFIGURATION_REQUIRED check.
export type ProviderState =
  | "CONFIGURED"
  | "OPTIONAL"
  | "CONFIGURATION_REQUIRED"
  | "INVALID";

export interface ProviderStatus {
  id: string;
  label: string;
  state: ProviderState;
  requiredVars: string[];
  missingVars: string[];
  invalidVars: string[];
  note: string;
}

function present(name: string): boolean {
  const v = process.env[name];
  return typeof v === "string" && v.trim() !== "";
}

function missingOf(names: string[]): string[] {
  return names.filter((n) => !present(n));
}

/** Best-effort shape check for a value that IS present but structurally cannot be valid (e.g. empty after trim already excluded; here: obviously placeholder text). Never a live/network check. */
function looksLikePlaceholder(name: string): boolean {
  const v = process.env[name];
  if (!v) return false;
  return /^(changeme|replace_me|your[-_]?key|xxx+|placeholder|<.*>)$/i.test(v.trim());
}

function classifyRequired(id: string, label: string, required: string[], noteConfigured: string, noteMissing: string): ProviderStatus {
  const missing = missingOf(required);
  const invalid = required.filter((n) => !missing.includes(n) && looksLikePlaceholder(n));
  if (invalid.length > 0) {
    return { id, label, state: "INVALID", requiredVars: required, missingVars: missing, invalidVars: invalid, note: `Placeholder-looking value(s) in ${invalid.join(", ")} - these will fail at the first real call.` };
  }
  if (missing.length > 0) {
    return { id, label, state: "CONFIGURATION_REQUIRED", requiredVars: required, missingVars: missing, invalidVars: [], note: noteMissing };
  }
  return { id, label, state: "CONFIGURED", requiredVars: required, missingVars: [], invalidVars: [], note: noteConfigured };
}

/** Anthropic API (core/ai) - required for the Brain/orchestrator and AI-assisted synthesis (Phase 11 BI narrative). */
function anthropic(): ProviderStatus {
  return classifyRequired(
    "anthropic",
    "Anthropic API (Claude)",
    ["ANTHROPIC_API_KEY"],
    "ANTHROPIC_API_KEY is set - AI calls will be attempted (validity only proven by a real call; core/ai/costControl.ts still governs cost).",
    "ANTHROPIC_API_KEY is not set - core/ai calls return CONFIGURATION_REQUIRED (see core/ai)."
  );
}

/** Email provider (tools/email/gmailProvider.ts). */
function email(): ProviderStatus {
  return classifyRequired(
    "email",
    "Email (Gmail API)",
    ["GMAIL_ACCESS_TOKEN", "GMAIL_USER_EMAIL"],
    "Gmail credentials are set - tools/email/emailTool.ts's handleSend() will attempt a real send. Token refresh is NOT implemented (docs/PHASE7_EMAIL_CRM.md) - a short-lived token expiring in production is a real, disclosed gap.",
    "GMAIL_ACCESS_TOKEN/GMAIL_USER_EMAIL not set - tools/email returns CONFIGURATION_REQUIRED, never a fabricated send."
  );
}

/** WhatsApp / Meta Cloud API (tools/whatsapp/whatsappTool.ts + core/whatsapp/webhook.ts). */
function whatsapp(): ProviderStatus {
  const required = ["WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_APP_SECRET"];
  const status = classifyRequired(
    "whatsapp",
    "WhatsApp (Meta Cloud API)",
    required,
    "WhatsApp send credentials are set - tools/whatsapp/whatsappTool.ts's handleSend() will attempt a real send.",
    "WhatsApp credentials not set - tools/whatsapp returns CONFIGURATION_REQUIRED. Note: WHATSAPP_APP_SECRET is ALSO required for inbound webhook signature verification (core/whatsapp/webhook.ts) - without it POST /webhooks/whatsapp fails closed with 503, it does not merely skip verification."
  );
  if (status.state === "CONFIGURED" && !present("WHATSAPP_WEBHOOK_VERIFY_TOKEN")) {
    return { ...status, state: "CONFIGURATION_REQUIRED", missingVars: [...status.missingVars, "WHATSAPP_WEBHOOK_VERIFY_TOKEN"], note: "Send credentials present, but WHATSAPP_WEBHOOK_VERIFY_TOKEN is unset - the GET webhook subscription handshake will always be rejected (403), so Meta cannot subscribe this endpoint." };
  }
  return status;
}

/** Voice / Twilio (tools/voice/voiceTool.ts + core/voice/webhook.ts). */
function voice(): ProviderStatus {
  const required = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER"];
  const status = classifyRequired(
    "voice",
    "Voice (Twilio)",
    required,
    "Twilio credentials are set - tools/voice/voiceTool.ts's handleOutboundCall() will attempt a real call. TWILIO_AUTH_TOKEN also HMAC-verifies inbound webhooks (core/voice/webhook.ts) - it is a dual-purpose secret.",
    "Twilio credentials not set - tools/voice returns CONFIGURATION_REQUIRED, and POST /webhooks/voice fails closed (no secret to verify signatures against)."
  );
  if (status.state === "CONFIGURED" && !present("VOICE_PUBLIC_WEBHOOK_URL")) {
    return { ...status, state: "CONFIGURATION_REQUIRED", missingVars: [...status.missingVars, "VOICE_PUBLIC_WEBHOOK_URL"], note: "Twilio credentials present, but VOICE_PUBLIC_WEBHOOK_URL is unset - Twilio has no reachable status-callback URL to call back, so a real call cannot be placed in production." };
  }
  return status;
}

/** Web research provider (tools/web - Brave Search). Genuinely optional: research degrades, nothing else depends on it. */
function webResearch(): ProviderStatus {
  const cfg = classifyRequired(
    "web_research",
    "Web Research (Brave Search)",
    ["BRAVE_SEARCH_API_KEY"],
    "BRAVE_SEARCH_API_KEY is set - tools/web will attempt real searches.",
    "BRAVE_SEARCH_API_KEY not set - tools/web returns CONFIGURATION_REQUIRED; research/BI features that need live web data degrade gracefully (no crash), see docs/PHASE6_WEB_RESEARCH.md and docs/PHASE11_BUSINESS_INTELLIGENCE.md."
  );
  // This one is OPTIONAL by design (nothing else in the system requires it
  // to function at all), so a missing key is OPTIONAL, not
  // CONFIGURATION_REQUIRED, unless the operator has started setting related
  // config (partial config is still worth flagging as CONFIGURATION_REQUIRED
  // via classifyRequired's own logic - there is none here since it's a
  // single var).
  if (cfg.state === "CONFIGURATION_REQUIRED") {
    return { ...cfg, state: "OPTIONAL", note: "Optional: " + cfg.note };
  }
  return cfg;
}

/** Browser automation (tools/browser, core/browser) - Playwright is a bundled dependency, not an external credential. Always CONFIGURED if the Playwright browser binary is installed; this module cannot verify a binary install without spawning a process, so it reports OPTIONAL/no-vars-needed honestly rather than guessing. */
function browserAutomation(): ProviderStatus {
  return {
    id: "browser_automation",
    label: "Browser Automation (Playwright)",
    state: "OPTIONAL",
    requiredVars: [],
    missingVars: [],
    invalidVars: [],
    note: "No credential env var is needed - Playwright is a bundled dependency. This module cannot verify the browser binary is actually installed without spawning a process (out of scope here); core/browser's own session code reports a real error if launch fails. core/business/browserPolicy.ts's financial hard-block applies regardless of this state.",
  };
}

export function getAllProviderStatuses(): ProviderStatus[] {
  return [anthropic(), email(), whatsapp(), voice(), webResearch(), browserAutomation()];
}

export function getProviderStatus(id: string): ProviderStatus | undefined {
  return getAllProviderStatuses().find((p) => p.id === id);
}

/** Summary used by health/readiness and the Phase 12 self-classification. */
export function summarizeProviders(): {
  configured: string[];
  optional: string[];
  configurationRequired: string[];
  invalid: string[];
} {
  const all = getAllProviderStatuses();
  return {
    configured: all.filter((p) => p.state === "CONFIGURED").map((p) => p.id),
    optional: all.filter((p) => p.state === "OPTIONAL").map((p) => p.id),
    configurationRequired: all.filter((p) => p.state === "CONFIGURATION_REQUIRED").map((p) => p.id),
    invalid: all.filter((p) => p.state === "INVALID").map((p) => p.id),
  };
}
