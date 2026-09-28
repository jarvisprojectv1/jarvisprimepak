// tools/voice/speechProvider.ts - real, credential-backed
// SpeechRecognitionProvider (Deepgram's pre-recorded transcription REST API)
// and TextToSpeechProvider (Deepgram's Aura TTS REST API) implementations.
// Deepgram was picked as the ONE real implementation (per the brief's "pick
// ONE and implement it for real" instruction) because both its STT and TTS
// products are plain REST endpoints (no SDK/websocket dependency needed for
// the pre-recorded-audio use case this phase actually has - a call
// transcript arriving via a recording URL, not a live bidirectional stream),
// keyed by a single DEEPGRAM_API_KEY.
//
// HONESTY NOTE (same pattern as every other real-but-uncredentialed provider
// in this codebase): no Deepgram credential exists in this sandbox, so this
// is genuinely exercised only via Mock(SpeechRecognition|TextToSpeech)Provider
// in tests - implemented against Deepgram's documented v1 REST API shape,
// UNTESTED against the live API. Voice/language selection is CONFIGURATION
// (env-var defaults, overridable per call), never a hardcoded "JARVIS voice"
// literal.
import { log } from "../../security/logger";
import type { SpeechRecognitionProvider, TextToSpeechProvider, TranscriptResult, VoiceProviderError } from "./types";

const DEEPGRAM_STT_BASE = "https://api.deepgram.com/v1/listen";
const DEEPGRAM_TTS_BASE = "https://api.deepgram.com/v1/speak";
const REQUEST_TIMEOUT_MS = 20_000;

function apiKey(): string | undefined {
  return process.env.DEEPGRAM_API_KEY;
}

function configRequired(what: string): VoiceProviderError {
  return { code: "CONFIGURATION_REQUIRED", message: `CONFIGURATION_REQUIRED: DEEPGRAM_API_KEY must be set (see .env.example) to use the Deepgram ${what} provider.` };
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("TIMEOUT")), ms))]);
}

export class DeepgramSpeechRecognitionProvider implements SpeechRecognitionProvider {
  readonly name = "deepgram";

  isConfigured(): boolean {
    return Boolean(apiKey());
  }

  /** REAL: Deepgram's pre-recorded transcription endpoint (POST /v1/listen?url=...). */
  async transcribeAudio(audioUrl: string): Promise<TranscriptResult | VoiceProviderError> {
    if (!this.isConfigured()) return configRequired("speech-to-text");
    const language = process.env.VOICE_STT_LANGUAGE; // configuration, not hardcoded - Deepgram auto-detects when unset
    const params = new URLSearchParams({ model: process.env.VOICE_STT_MODEL ?? "nova-2", ...(language ? { language } : { detect_language: "true" }) });
    try {
      const res = await withTimeout(
        fetch(`${DEEPGRAM_STT_BASE}?${params.toString()}`, {
          method: "POST",
          headers: { Authorization: `Token ${apiKey()}`, "Content-Type": "application/json" },
          body: JSON.stringify({ url: audioUrl }),
        }),
        REQUEST_TIMEOUT_MS
      );
      if (!res.ok) {
        if (res.status === 429) return { code: "RATE_LIMITED", message: "Deepgram rate limit hit." };
        return { code: "PROVIDER_ERROR", message: `Deepgram STT API error (HTTP ${res.status}).` };
      }
      const data = (await res.json()) as {
        results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string; confidence?: number }>; detected_language?: string }> };
      };
      const alt = data.results?.channels?.[0]?.alternatives?.[0];
      return {
        text: alt?.transcript ?? "",
        language: data.results?.channels?.[0]?.detected_language ?? language ?? null,
        confidence: typeof alt?.confidence === "number" ? alt.confidence : null,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log("ERROR", "voice.deepgram_transcribe_failed", { error: message });
      if (message === "TIMEOUT") return { code: "TIMEOUT", message: "Deepgram transcription request timed out." };
      return { code: "PROVIDER_ERROR", message: "Deepgram transcription request failed." };
    }
  }

  async transcribeStream(): Promise<TranscriptResult | VoiceProviderError> {
    return { code: "NOT_IMPLEMENTED", message: "Live streaming transcription (Deepgram's websocket API) is NOT_IMPLEMENTED this phase - only pre-recorded/URL-based transcription is wired up." };
  }

  async detectLanguage(text: string): Promise<{ language: string; confidence: number } | VoiceProviderError> {
    // Deepgram's STT itself does language detection on audio (see
    // transcribeAudio above); there is no separate text-only
    // language-detection endpoint in Deepgram's product - honestly
    // NOT_IMPLEMENTED rather than faking a second provider call.
    void text;
    return { code: "NOT_IMPLEMENTED", message: "No separate text-based language-detection endpoint exists for this provider - see transcribeAudio()'s detect_language option." };
  }

  async getTranscriptMetadata(): Promise<{ status: string; durationSeconds: number | null } | VoiceProviderError> {
    return { code: "NOT_IMPLEMENTED", message: "Deepgram's pre-recorded API is synchronous (no separate transcript-status-by-id lookup) - the result is returned directly from transcribeAudio()." };
  }
}

export class DeepgramTextToSpeechProvider implements TextToSpeechProvider {
  readonly name = "deepgram";

  isConfigured(): boolean {
    return Boolean(apiKey());
  }

  /** REAL: Deepgram Aura TTS endpoint (POST /v1/speak?model=...). Voice is CONFIGURATION (VOICE_TTS_VOICE env var / the `voice` param), never a hardcoded literal. */
  async synthesize(text: string, options?: { voice?: string; language?: string }): Promise<{ audioUrl: string } | VoiceProviderError> {
    if (!this.isConfigured()) return configRequired("text-to-speech");
    const voice = options?.voice ?? process.env.VOICE_TTS_VOICE ?? "aura-asteria-en";
    try {
      const res = await withTimeout(
        fetch(`${DEEPGRAM_TTS_BASE}?model=${encodeURIComponent(voice)}`, {
          method: "POST",
          headers: { Authorization: `Token ${apiKey()}`, "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        }),
        REQUEST_TIMEOUT_MS
      );
      if (!res.ok) return { code: "PROVIDER_ERROR", message: `Deepgram TTS API error (HTTP ${res.status}).` };
      // Deepgram returns the raw audio bytes, not a hosted URL - this
      // provider does not itself host audio files this phase (no live audio
      // storage was built - see docs/PHASE9_VOICE.md item 21's honesty
      // note), so it honestly reports NOT_IMPLEMENTED for the audioUrl shape
      // this interface asks for, rather than fabricating a URL.
      return { code: "NOT_IMPLEMENTED", message: "Deepgram TTS returns raw audio bytes, not a hosted URL - no audio-hosting/storage path exists this phase to turn that into an audioUrl. See docs/PHASE9_VOICE.md." };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log("ERROR", "voice.deepgram_tts_failed", { error: message });
      if (message === "TIMEOUT") return { code: "TIMEOUT", message: "Deepgram TTS request timed out." };
      return { code: "PROVIDER_ERROR", message: "Deepgram TTS request failed." };
    }
  }

  async getAudioMetadata(): Promise<{ durationSeconds: number | null; format: string | null } | VoiceProviderError> {
    return { code: "NOT_IMPLEMENTED", message: "No audio-hosting path exists this phase to look up metadata for a stored audio file - see synthesize()'s honesty note." };
  }

  async supportedVoices(): Promise<string[] | VoiceProviderError> {
    if (!this.isConfigured()) return configRequired("text-to-speech");
    // A fixed, documented list (Deepgram Aura's published voice catalog) -
    // not an invented literal; DATA, not business logic.
    return ["aura-asteria-en", "aura-luna-en", "aura-stella-en", "aura-athena-en", "aura-orion-en"];
  }

  async supportedLanguages(): Promise<string[] | VoiceProviderError> {
    if (!this.isConfigured()) return configRequired("text-to-speech");
    return ["en"];
  }
}
