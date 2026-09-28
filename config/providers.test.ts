import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getAllProviderStatuses, getProviderStatus, summarizeProviders } from "./providers";

const PROVIDER_VARS = [
  "ANTHROPIC_API_KEY",
  "GMAIL_ACCESS_TOKEN",
  "GMAIL_USER_EMAIL",
  "WHATSAPP_ACCESS_TOKEN",
  "WHATSAPP_PHONE_NUMBER_ID",
  "WHATSAPP_APP_SECRET",
  "WHATSAPP_WEBHOOK_VERIFY_TOKEN",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_PHONE_NUMBER",
  "VOICE_PUBLIC_WEBHOOK_URL",
  "BRAVE_SEARCH_API_KEY",
];

describe("config/providers - honest, evidence-based classification", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const v of PROVIDER_VARS) {
      saved[v] = process.env[v];
      delete process.env[v];
    }
  });

  afterEach(() => {
    for (const v of PROVIDER_VARS) {
      if (saved[v] === undefined) delete process.env[v];
      else process.env[v] = saved[v];
    }
  });

  it("never reports CONFIGURED for a provider whose required vars are all absent", () => {
    const statuses = getAllProviderStatuses();
    for (const s of statuses) {
      if (s.requiredVars.length > 0) {
        expect(s.state).not.toBe("CONFIGURED");
      }
    }
  });

  it("web research is OPTIONAL (not CONFIGURATION_REQUIRED) when absent - nothing else depends on it", () => {
    const status = getProviderStatus("web_research")!;
    expect(status.state).toBe("OPTIONAL");
  });

  it("browser automation needs no credential var and is always reported, never fabricated REAL", () => {
    const status = getProviderStatus("browser_automation")!;
    expect(status.requiredVars).toEqual([]);
    expect(status.state).toBe("OPTIONAL");
  });

  it("email becomes CONFIGURED only once BOTH required vars are present", () => {
    process.env.GMAIL_ACCESS_TOKEN = "test-token-value-not-a-real-secret";
    expect(getProviderStatus("email")!.state).toBe("CONFIGURATION_REQUIRED");
    process.env.GMAIL_USER_EMAIL = "test@example.com";
    expect(getProviderStatus("email")!.state).toBe("CONFIGURED");
  });

  it("whatsapp requires the webhook verify token in addition to send credentials to be fully CONFIGURED", () => {
    process.env.WHATSAPP_ACCESS_TOKEN = "test-token-value-not-a-real-secret-000000";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "123456";
    process.env.WHATSAPP_APP_SECRET = "test-app-secret-value-not-real-000000";
    expect(getProviderStatus("whatsapp")!.state).toBe("CONFIGURATION_REQUIRED");
    process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = "test-verify-token";
    expect(getProviderStatus("whatsapp")!.state).toBe("CONFIGURED");
  });

  it("voice requires a reachable status-callback URL in addition to Twilio credentials to be fully CONFIGURED", () => {
    process.env.TWILIO_ACCOUNT_SID = "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
    process.env.TWILIO_AUTH_TOKEN = "test-auth-token-not-real-0000000000";
    process.env.TWILIO_PHONE_NUMBER = "+10000000000";
    expect(getProviderStatus("voice")!.state).toBe("CONFIGURATION_REQUIRED");
    process.env.VOICE_PUBLIC_WEBHOOK_URL = "https://example.test/webhooks/voice";
    expect(getProviderStatus("voice")!.state).toBe("CONFIGURED");
  });

  it("flags an obvious placeholder value as INVALID, not CONFIGURED", () => {
    process.env.ANTHROPIC_API_KEY = "changeme";
    expect(getProviderStatus("anthropic")!.state).toBe("INVALID");
  });

  it("summarizeProviders buckets every provider into exactly one state", () => {
    const summary = summarizeProviders();
    const total =
      summary.configured.length + summary.optional.length + summary.configurationRequired.length + summary.invalid.length;
    expect(total).toBe(getAllProviderStatuses().length);
  });
});
