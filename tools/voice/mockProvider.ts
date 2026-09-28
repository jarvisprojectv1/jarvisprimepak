// tools/voice/mockProvider.ts - pure in-memory VoiceProvider/
// SpeechRecognitionProvider/TextToSpeechProvider test doubles. NEVER imported
// by production wiring (tools/index.ts) - only by tests and anything
// explicitly constructed with `new Mock...Provider()`. This is the ONLY set
// of providers the automated test suite ever exercises a call/transcription
// against - there is no live telephony/speech network call anywhere in
// `npm test`.
import type {
  CallRecord,
  CreateCallInput,
  RecordingMetadata,
  SpeechRecognitionProvider,
  TextToSpeechProvider,
  TranscriptResult,
  VoiceProvider,
  VoiceProviderError,
} from "./types";

let counter = 0;

export class MockVoiceProvider implements VoiceProvider {
  readonly name = "mock";
  private configured = true;
  private calls = new Map<string, CallRecord>();
  private created: Array<CreateCallInput & { providerCallId: string }> = [];
  private failNextCreate = false;
  private invalidRecipients = new Set<string>();

  isConfigured(): boolean {
    return this.configured;
  }

  setConfigured(value: boolean): void {
    this.configured = value;
  }

  simulateCreateFailure(): void {
    this.failNextCreate = true;
  }

  markInvalidRecipient(to: string): void {
    this.invalidRecipients.add(to);
  }

  async createCall(input: CreateCallInput): Promise<CallRecord | VoiceProviderError> {
    if (!this.configured) return this.configRequired();
    if (this.invalidRecipients.has(input.to)) {
      this.invalidRecipients.delete(input.to);
      return { code: "INVALID_RECIPIENT", message: `Simulated invalid recipient: ${input.to}` };
    }
    if (this.failNextCreate) {
      this.failNextCreate = false;
      return { code: "PROVIDER_ERROR", message: "Simulated transient provider failure." };
    }
    const providerCallId = `mock-call-${++counter}`;
    const record: CallRecord = {
      providerCallId,
      status: "queued",
      to: input.to,
      from: input.from ?? "+920000000000",
      direction: "outbound",
      durationSeconds: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
    };
    this.calls.set(providerCallId, record);
    this.created.push({ ...input, providerCallId });
    return record;
  }

  async answerCall(providerCallId: string): Promise<CallRecord | VoiceProviderError> {
    const existing = this.calls.get(providerCallId);
    if (!existing) return { code: "PROVIDER_ERROR", message: "No such call." };
    const updated = { ...existing, status: "in-progress" };
    this.calls.set(providerCallId, updated);
    return updated;
  }

  async endCall(providerCallId: string): Promise<CallRecord | VoiceProviderError> {
    const existing = this.calls.get(providerCallId);
    if (!existing) return { code: "PROVIDER_ERROR", message: "No such call." };
    const updated = { ...existing, status: "completed", endedAt: new Date().toISOString(), durationSeconds: 30 };
    this.calls.set(providerCallId, updated);
    return updated;
  }

  async getCall(providerCallId: string): Promise<CallRecord | VoiceProviderError | null> {
    if (!this.configured) return this.configRequired();
    return this.calls.get(providerCallId) ?? null;
  }

  async transferCall(_providerCallId: string, _toNumber: string): Promise<CallRecord | VoiceProviderError> {
    // Honest per this phase's design: a real live transfer is NOT_IMPLEMENTED
    // even for the mock (see tools/voice/voiceTool.ts's human-handoff path,
    // which creates a callback task/notification instead).
    return { code: "NOT_IMPLEMENTED", message: "Live call transfer is NOT_IMPLEMENTED this phase; use the human-handoff callback task path instead." };
  }

  async playAudio(providerCallId: string): Promise<{ ok: true } | VoiceProviderError> {
    if (!this.calls.has(providerCallId)) return { code: "PROVIDER_ERROR", message: "No such call." };
    return { ok: true };
  }

  async synthesizeSpeech(text: string): Promise<{ audioUrl: string } | VoiceProviderError> {
    return { audioUrl: `mock://tts/${encodeURIComponent(text.slice(0, 24))}` };
  }

  async startRecognition(providerCallId: string): Promise<{ ok: true } | VoiceProviderError> {
    if (!this.calls.has(providerCallId)) return { code: "PROVIDER_ERROR", message: "No such call." };
    return { ok: true };
  }

  async stopRecognition(providerCallId: string): Promise<{ ok: true } | VoiceProviderError> {
    if (!this.calls.has(providerCallId)) return { code: "PROVIDER_ERROR", message: "No such call." };
    return { ok: true };
  }

  receiveWebhook(rawParams: Record<string, unknown>): { providerCallId: string; status: string } | null {
    const id = typeof rawParams.CallSid === "string" ? rawParams.CallSid : null;
    const status = typeof rawParams.CallStatus === "string" ? rawParams.CallStatus : null;
    if (!id || !status) return null;
    return { providerCallId: id, status };
  }

  validateWebhook(): boolean {
    // Test-only shortcut: always true for the mock provider itself (real
    // signature verification is exercised directly against
    // core/voice/webhook.ts's verifyTwilioSignature(), not through here).
    return true;
  }

  async getRecordingMetadata(recordingSid: string): Promise<RecordingMetadata | VoiceProviderError> {
    return { recordingSid, durationSeconds: 12, channels: 1, status: "completed" };
  }

  getCreatedCalls(): Array<CreateCallInput & { providerCallId: string }> {
    return [...this.created];
  }
  private configRequired(): VoiceProviderError {
    return { code: "CONFIGURATION_REQUIRED", message: "Mock provider explicitly unconfigured for this test." };
  }
}

export class MockSpeechRecognitionProvider implements SpeechRecognitionProvider {
  readonly name = "mock";
  private configured = true;
  private transcripts = new Map<string, TranscriptResult>();

  isConfigured(): boolean {
    return this.configured;
  }
  setConfigured(value: boolean): void {
    this.configured = value;
  }
  seedTranscript(audioUrl: string, result: TranscriptResult): void {
    this.transcripts.set(audioUrl, result);
  }

  async transcribeAudio(audioUrl: string): Promise<TranscriptResult | VoiceProviderError> {
    if (!this.configured) return { code: "CONFIGURATION_REQUIRED", message: "Mock STT provider explicitly unconfigured for this test." };
    return this.transcripts.get(audioUrl) ?? { text: "", language: null, confidence: null };
  }
  async transcribeStream(): Promise<TranscriptResult | VoiceProviderError> {
    return { code: "NOT_IMPLEMENTED", message: "Live media-stream transcription is NOT_IMPLEMENTED this phase." };
  }
  async detectLanguage(): Promise<{ language: string; confidence: number } | VoiceProviderError> {
    if (!this.configured) return { code: "CONFIGURATION_REQUIRED", message: "Mock STT provider explicitly unconfigured for this test." };
    return { language: "en", confidence: 0.9 };
  }
  async getTranscriptMetadata(): Promise<{ status: string; durationSeconds: number | null } | VoiceProviderError> {
    if (!this.configured) return { code: "CONFIGURATION_REQUIRED", message: "Mock STT provider explicitly unconfigured for this test." };
    return { status: "COMPLETE", durationSeconds: 12 };
  }
}

export class MockTextToSpeechProvider implements TextToSpeechProvider {
  readonly name = "mock";
  private configured = true;

  isConfigured(): boolean {
    return this.configured;
  }
  setConfigured(value: boolean): void {
    this.configured = value;
  }

  async synthesize(text: string): Promise<{ audioUrl: string } | VoiceProviderError> {
    if (!this.configured) return { code: "CONFIGURATION_REQUIRED", message: "Mock TTS provider explicitly unconfigured for this test." };
    return { audioUrl: `mock://tts/${encodeURIComponent(text.slice(0, 24))}` };
  }
  async getAudioMetadata(): Promise<{ durationSeconds: number | null; format: string | null } | VoiceProviderError> {
    if (!this.configured) return { code: "CONFIGURATION_REQUIRED", message: "Mock TTS provider explicitly unconfigured for this test." };
    return { durationSeconds: 5, format: "mp3" };
  }
  async supportedVoices(): Promise<string[] | VoiceProviderError> {
    if (!this.configured) return { code: "CONFIGURATION_REQUIRED", message: "Mock TTS provider explicitly unconfigured for this test." };
    return ["mock-voice-en-1"];
  }
  async supportedLanguages(): Promise<string[] | VoiceProviderError> {
    if (!this.configured) return { code: "CONFIGURATION_REQUIRED", message: "Mock TTS provider explicitly unconfigured for this test." };
    return ["en"];
  }
}
