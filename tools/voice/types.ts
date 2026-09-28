// tools/voice/types.ts - the Voice Provider abstraction (Phase 9, items 2-4,
// 12-13). Same shape/philosophy as tools/whatsapp/types.ts's WhatsAppProvider:
// a real implementation (twilioProvider.ts) calls the official Twilio
// Programmable Voice API from real credentials, honestly per-operation
// CONFIGURATION_REQUIRED/NOT_IMPLEMENTED (not a monolithic all-or-nothing
// status - a provider can genuinely support createCall but not, say,
// transferCall, and each says so independently). MockVoiceProvider (see
// mockProvider.ts) is the ONLY provider any automated test exercises.
//
// Kept deliberately narrow to what a real Twilio-style webhook-based voice
// provider genuinely supports: createCall/answerCall/endCall/getCall/
// transferCall/playAudio/synthesizeSpeech/startRecognition/stopRecognition/
// receiveWebhook/validateWebhook/getRecordingMetadata.

export interface VoiceProviderError {
  code: "CONFIGURATION_REQUIRED" | "NOT_IMPLEMENTED" | "TIMEOUT" | "PROVIDER_ERROR" | "RATE_LIMITED" | "INVALID_RECIPIENT";
  message: string;
}

export function isVoiceProviderError<T>(value: T | VoiceProviderError): value is VoiceProviderError {
  return Boolean(value) && typeof value === "object" && "code" in (value as Record<string, unknown>);
}

export interface CreateCallInput {
  to: string;
  from?: string;
  /** The public webhook URL the provider will POST call-status/TwiML requests to for this call. */
  statusCallbackUrl?: string;
  /** A short, non-business script/summary of what this call is for - never business content invented by the provider itself. */
  purposeSummary?: string;
  idempotencyKey?: string;
}

export interface CallRecord {
  providerCallId: string;
  status: string; // queued | ringing | in-progress | completed | busy | failed | no-answer | canceled
  to: string;
  from: string;
  direction: "inbound" | "outbound";
  durationSeconds: number | null;
  startedAt: string | null;
  endedAt: string | null;
}

export interface RecordingMetadata {
  recordingSid: string;
  durationSeconds: number | null;
  channels: number | null;
  /** Never a raw audio URL fetched/exposed by default - see item 21 (recording is off by default). */
  status: string;
}

/**
 * A voice/telephony provider. Every method may independently return
 * CONFIGURATION_REQUIRED (credentials missing) or NOT_IMPLEMENTED (this
 * operation genuinely isn't wired up for this provider) - never a fabricated
 * success. Real implementations read credentials from env; see
 * twilioProvider.ts.
 */
export interface VoiceProvider {
  readonly name: string;
  isConfigured(): boolean;
  createCall(input: CreateCallInput): Promise<CallRecord | VoiceProviderError>;
  answerCall(providerCallId: string): Promise<CallRecord | VoiceProviderError>;
  endCall(providerCallId: string): Promise<CallRecord | VoiceProviderError>;
  getCall(providerCallId: string): Promise<CallRecord | VoiceProviderError | null>;
  /** "Transfer" in this phase means creating a human-follow-up task, never a real live telephony transfer - see tools/voice/voiceTool.ts. Providers that don't support a real warm transfer honestly return NOT_IMPLEMENTED. */
  transferCall(providerCallId: string, toNumber: string): Promise<CallRecord | VoiceProviderError>;
  playAudio(providerCallId: string, text: string): Promise<{ ok: true } | VoiceProviderError>;
  synthesizeSpeech(text: string, voice?: string): Promise<{ audioUrl: string } | VoiceProviderError>;
  startRecognition(providerCallId: string): Promise<{ ok: true } | VoiceProviderError>;
  stopRecognition(providerCallId: string): Promise<{ ok: true } | VoiceProviderError>;
  /** Parses a raw provider webhook body into this system's normalized shape - local-only, never a network call. */
  receiveWebhook(rawParams: Record<string, unknown>): { providerCallId: string; status: string } | null;
  /** Verifies a raw webhook request's authenticity - see core/voice/webhook.ts's verifyTwilioSignature() for the real implementation this delegates to. */
  validateWebhook(fullUrl: string, params: Record<string, string>, signatureHeader: string | undefined): boolean;
  getRecordingMetadata(recordingSid: string): Promise<RecordingMetadata | VoiceProviderError>;
}

// ---------------------------------------------------------------------------
// Speech providers (item 12): small, focused interfaces, kept SEPARATE from
// VoiceProvider (telephony) - a real deployment might use Twilio for calls
// and a different vendor for STT/TTS, so these must not be conflated into
// one monolithic interface.
// ---------------------------------------------------------------------------

export interface TranscriptResult {
  text: string;
  language: string | null;
  confidence: number | null;
}

export interface SpeechRecognitionProvider {
  readonly name: string;
  isConfigured(): boolean;
  transcribeAudio(audioUrl: string): Promise<TranscriptResult | VoiceProviderError>;
  /** NOT_IMPLEMENTED in this phase for any real provider - live media-stream transcription needs a persistent socket, out of scope. */
  transcribeStream(streamId: string): Promise<TranscriptResult | VoiceProviderError>;
  detectLanguage(text: string): Promise<{ language: string; confidence: number } | VoiceProviderError>;
  getTranscriptMetadata(transcriptId: string): Promise<{ status: string; durationSeconds: number | null } | VoiceProviderError>;
}

export interface TextToSpeechProvider {
  readonly name: string;
  isConfigured(): boolean;
  /** `voice`/`language` are CONFIGURATION, never a hardcoded literal - see getSettings-backed defaults in tools/voice/speechProvider.ts. */
  synthesize(text: string, options?: { voice?: string; language?: string }): Promise<{ audioUrl: string } | VoiceProviderError>;
  getAudioMetadata(audioUrl: string): Promise<{ durationSeconds: number | null; format: string | null } | VoiceProviderError>;
  supportedVoices(): Promise<string[] | VoiceProviderError>;
  supportedLanguages(): Promise<string[] | VoiceProviderError>;
}
