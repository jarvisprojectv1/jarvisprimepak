// core/business/voiceLimits.ts - hard, configurable duration/size limits for
// voice sessions (Phase 9, item 23). Setting-backed, same pattern as
// core/business/antiSpam.ts's AntiSpamConfig - not a new, parallel
// configuration mechanism.
//
// HONESTY NOTE: this phase's webhook-only (no persistent TwiML call-control
// session) architecture means these limits cannot be enforced as a live
// mid-call cutoff (there is no open socket to end mid-call the instant a
// limit is crossed) - `isCallDurationExceeded()` is checked when a
// terminal/status webhook event carries a duration (core/voice/ingest.ts),
// which flags/logs an over-limit call for review rather than silently
// accepting it as normal. A true live cutoff would need Twilio Media
// Streams/a persistent call-control session, out of scope this phase - see
// docs/PHASE9_VOICE.md's limitations section.
import { prisma } from "../../database/client";

export interface VoiceLimitsConfig {
  maxCallDurationSeconds: number;
  maxTranscriptChars: number;
}

export const DEFAULT_VOICE_LIMITS: VoiceLimitsConfig = {
  maxCallDurationSeconds: 600, // 10 minutes
  maxTranscriptChars: 20_000,
};

const SETTINGS_KEY = "business.voice_limits";

export async function getVoiceLimitsConfig(): Promise<VoiceLimitsConfig> {
  const envOverride = process.env.VOICE_MAX_CALL_DURATION_SECONDS ? Number(process.env.VOICE_MAX_CALL_DURATION_SECONDS) : undefined;
  const row = await prisma.setting.findUnique({ where: { key: SETTINGS_KEY } });
  let stored: Partial<VoiceLimitsConfig> = {};
  if (row) {
    try {
      stored = JSON.parse(row.value) as Partial<VoiceLimitsConfig>;
    } catch {
      stored = {};
    }
  }
  return { ...DEFAULT_VOICE_LIMITS, ...stored, ...(envOverride ? { maxCallDurationSeconds: envOverride } : {}) };
}

export async function setVoiceLimitsConfig(partial: Partial<VoiceLimitsConfig>): Promise<VoiceLimitsConfig> {
  const current = await getVoiceLimitsConfig();
  const next = { ...current, ...partial };
  await prisma.setting.upsert({ where: { key: SETTINGS_KEY }, update: { value: JSON.stringify(next) }, create: { key: SETTINGS_KEY, value: JSON.stringify(next) } });
  return next;
}

export async function isCallDurationExceeded(durationSeconds: number | null | undefined): Promise<boolean> {
  if (typeof durationSeconds !== "number") return false;
  const config = await getVoiceLimitsConfig();
  return durationSeconds > config.maxCallDurationSeconds;
}

export async function isTranscriptOversized(transcript: string | null | undefined): Promise<boolean> {
  if (!transcript) return false;
  const config = await getVoiceLimitsConfig();
  return transcript.length > config.maxTranscriptChars;
}
