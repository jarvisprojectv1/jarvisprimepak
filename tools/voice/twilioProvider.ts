// tools/voice/twilioProvider.ts - a real, credential-backed VoiceProvider
// implementation against Twilio Programmable Voice (the documented,
// TwiML/REST-API-based, ToS-compliant telephony API). NOT an unofficial
// telephony bypass, NOT caller-ID spoofing.
//
// HONESTY NOTE (same pattern as MetaCloudWhatsAppProvider/GmailProvider):
// this sandbox has no Twilio credentials, so this implementation is
// genuinely exercised only via MockVoiceProvider in tests - it is
// implemented carefully against Twilio's documented REST API v2010 request/
// response shape (createCall via POST .../Calls.json), but UNTESTED AGAINST
// THE LIVE API. Every method independently, honestly reports
// CONFIGURATION_REQUIRED with no credentials, or NOT_IMPLEMENTED for an
// operation this phase genuinely does not implement (a live warm transfer,
// live media-stream transcription) - never a fabricated success.
//
// Credentials (documented in .env.example): TWILIO_ACCOUNT_SID,
// TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER. TWILIO_AUTH_TOKEN is ALSO the key
// used by core/voice/webhook.ts's verifyTwilioSignature() for inbound
// webhook verification - never logged, read once from env.
import { verifyTwilioSignature } from "../../core/voice/webhook";
import { log } from "../../security/logger";
import type { CallRecord, CreateCallInput, RecordingMetadata, VoiceProvider, VoiceProviderError } from "./types";

const TWILIO_API_BASE = "https://api.twilio.com/2010-04-01";
const REQUEST_TIMEOUT_MS = 15_000;

function accountSid(): string | undefined {
  return process.env.TWILIO_ACCOUNT_SID;
}
function authToken(): string | undefined {
  return process.env.TWILIO_AUTH_TOKEN;
}
function fromNumber(): string | undefined {
  return process.env.TWILIO_PHONE_NUMBER;
}

function configRequired(): VoiceProviderError {
  return {
    code: "CONFIGURATION_REQUIRED",
    message: "CONFIGURATION_REQUIRED: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER must be set (see .env.example) to use the Twilio Programmable Voice provider.",
  };
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("TIMEOUT")), ms)),
  ]);
}

export class TwilioVoiceProvider implements VoiceProvider {
  readonly name = "twilio";

  isConfigured(): boolean {
    return Boolean(accountSid() && authToken() && fromNumber());
  }

  /**
   * REAL: Twilio's documented "Make a call" REST call
   * (POST /Accounts/{Sid}/Calls.json, Basic-auth'd with SID:AuthToken,
   * `To`/`From`/`Url` form params). This is the ONLY method in this provider
   * that genuinely creates a live call side-effect - everything downstream
   * of it in this phase is honestly NOT_IMPLEMENTED where it isn't real.
   */
  async createCall(input: CreateCallInput): Promise<CallRecord | VoiceProviderError> {
    if (!this.isConfigured()) return configRequired();
    if (!input.statusCallbackUrl) {
      return { code: "CONFIGURATION_REQUIRED", message: "createCall requires a statusCallbackUrl (a public webhook URL) - none was provided." };
    }
    const sid = accountSid()!;
    const token = authToken()!;
    const body = new URLSearchParams({
      To: input.to,
      From: input.from ?? fromNumber()!,
      Url: input.statusCallbackUrl,
      StatusCallback: input.statusCallbackUrl,
    });
    try {
      const res = await withTimeout(
        fetch(`${TWILIO_API_BASE}/Accounts/${sid}/Calls.json`, {
          method: "POST",
          headers: {
            Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: body.toString(),
        }),
        REQUEST_TIMEOUT_MS
      );
      if (!res.ok) {
        const status = res.status;
        if (status === 400) return { code: "INVALID_RECIPIENT", message: `Twilio rejected the call request (HTTP ${status}).` };
        if (status === 429) return { code: "RATE_LIMITED", message: "Twilio rate limit hit." };
        return { code: "PROVIDER_ERROR", message: `Twilio API error (HTTP ${status}).` };
      }
      const data = (await res.json()) as { sid: string; status: string; to: string; from: string; direction: string; date_created: string };
      return {
        providerCallId: data.sid,
        status: data.status,
        to: data.to,
        from: data.from,
        direction: "outbound",
        durationSeconds: null,
        startedAt: data.date_created ?? new Date().toISOString(),
        endedAt: null,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log("ERROR", "voice.twilio_create_call_failed", { error: message });
      if (message === "TIMEOUT") return { code: "TIMEOUT", message: "Twilio createCall request timed out." };
      return { code: "PROVIDER_ERROR", message: "Twilio createCall request failed." };
    }
  }

  async answerCall(): Promise<CallRecord | VoiceProviderError> {
    // Twilio answers inbound calls via TwiML returned from the webhook
    // response, not a separate REST "answer" call - there is no distinct
    // "answer" API operation to implement here honestly.
    return { code: "NOT_IMPLEMENTED", message: "Twilio answers calls via TwiML webhook response, not a separate answerCall API - see apps/api/src/routes/webhooks.ts." };
  }

  async endCall(providerCallId: string): Promise<CallRecord | VoiceProviderError> {
    if (!this.isConfigured()) return configRequired();
    const sid = accountSid()!;
    const token = authToken()!;
    try {
      const res = await withTimeout(
        fetch(`${TWILIO_API_BASE}/Accounts/${sid}/Calls/${providerCallId}.json`, {
          method: "POST",
          headers: {
            Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ Status: "completed" }).toString(),
        }),
        REQUEST_TIMEOUT_MS
      );
      if (!res.ok) return { code: "PROVIDER_ERROR", message: `Twilio API error (HTTP ${res.status}).` };
      const data = (await res.json()) as { sid: string; status: string; to: string; from: string };
      return { providerCallId: data.sid, status: data.status, to: data.to, from: data.from, direction: "outbound", durationSeconds: null, startedAt: null, endedAt: new Date().toISOString() };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === "TIMEOUT") return { code: "TIMEOUT", message: "Twilio endCall request timed out." };
      return { code: "PROVIDER_ERROR", message: "Twilio endCall request failed." };
    }
  }

  async getCall(providerCallId: string): Promise<CallRecord | VoiceProviderError | null> {
    if (!this.isConfigured()) return configRequired();
    const sid = accountSid()!;
    const token = authToken()!;
    try {
      const res = await withTimeout(
        fetch(`${TWILIO_API_BASE}/Accounts/${sid}/Calls/${providerCallId}.json`, {
          headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}` },
        }),
        REQUEST_TIMEOUT_MS
      );
      if (res.status === 404) return null;
      if (!res.ok) return { code: "PROVIDER_ERROR", message: `Twilio API error (HTTP ${res.status}).` };
      const data = (await res.json()) as { sid: string; status: string; to: string; from: string; duration: string | null; start_time: string | null; end_time: string | null };
      return {
        providerCallId: data.sid,
        status: data.status,
        to: data.to,
        from: data.from,
        direction: "outbound",
        durationSeconds: data.duration ? Number(data.duration) : null,
        startedAt: data.start_time,
        endedAt: data.end_time,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === "TIMEOUT") return { code: "TIMEOUT", message: "Twilio getCall request timed out." };
      return { code: "PROVIDER_ERROR", message: "Twilio getCall request failed." };
    }
  }

  async transferCall(): Promise<CallRecord | VoiceProviderError> {
    // Honest per docs/PHASE9_VOICE.md: "transfer" in this phase means
    // creating a human-follow-up task, never a real live telephony transfer -
    // see tools/voice/voiceTool.ts's human-handoff path. A real Twilio
    // <Dial> warm-transfer requires an active TwiML call-control session
    // this phase's webhook-only architecture does not maintain.
    return { code: "NOT_IMPLEMENTED", message: "Live call transfer is NOT_IMPLEMENTED this phase - see the human-handoff callback task path in tools/voice/voiceTool.ts." };
  }

  async playAudio(): Promise<{ ok: true } | VoiceProviderError> {
    return { code: "NOT_IMPLEMENTED", message: "Mid-call audio playback requires an active TwiML call-control session this phase's webhook-only architecture does not maintain." };
  }

  async synthesizeSpeech(): Promise<{ audioUrl: string } | VoiceProviderError> {
    return { code: "NOT_IMPLEMENTED", message: "Use a dedicated TextToSpeechProvider (tools/voice/speechProvider.ts) - Twilio's <Say> TwiML verb is used declaratively in webhook TwiML responses, not as a separate synthesize API call." };
  }

  async startRecognition(): Promise<{ ok: true } | VoiceProviderError> {
    return { code: "NOT_IMPLEMENTED", message: "Twilio speech recognition is declared in TwiML <Gather input=\"speech\">, not a separate startRecognition API call." };
  }

  async stopRecognition(): Promise<{ ok: true } | VoiceProviderError> {
    return { code: "NOT_IMPLEMENTED", message: "See startRecognition() - not a separate API call for this provider." };
  }

  receiveWebhook(rawParams: Record<string, unknown>): { providerCallId: string; status: string } | null {
    const id = typeof rawParams.CallSid === "string" ? rawParams.CallSid : null;
    const status = typeof rawParams.CallStatus === "string" ? rawParams.CallStatus : null;
    if (!id || !status) return null;
    return { providerCallId: id, status };
  }

  validateWebhook(fullUrl: string, params: Record<string, string>, signatureHeader: string | undefined): boolean {
    return verifyTwilioSignature(fullUrl, params, signatureHeader, authToken());
  }

  async getRecordingMetadata(recordingSid: string): Promise<RecordingMetadata | VoiceProviderError> {
    if (!this.isConfigured()) return configRequired();
    if (process.env.VOICE_RECORDING_ENABLED !== "true") {
      return { code: "CONFIGURATION_REQUIRED", message: "VOICE_RECORDING_ENABLED is not 'true' - recording is off by default (item 21); no recording metadata is fetched." };
    }
    const sid = accountSid()!;
    const token = authToken()!;
    try {
      const res = await withTimeout(
        fetch(`${TWILIO_API_BASE}/Accounts/${sid}/Recordings/${recordingSid}.json`, {
          headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}` },
        }),
        REQUEST_TIMEOUT_MS
      );
      if (!res.ok) return { code: "PROVIDER_ERROR", message: `Twilio API error (HTTP ${res.status}).` };
      const data = (await res.json()) as { sid: string; duration: string | null; channels: number | null; status: string };
      return { recordingSid: data.sid, durationSeconds: data.duration ? Number(data.duration) : null, channels: data.channels ?? null, status: data.status };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === "TIMEOUT") return { code: "TIMEOUT", message: "Twilio getRecordingMetadata request timed out." };
      return { code: "PROVIDER_ERROR", message: "Twilio getRecordingMetadata request failed." };
    }
  }
}

export function createDefaultVoiceProvider(): VoiceProvider {
  return new TwilioVoiceProvider();
}
