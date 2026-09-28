// core/business/voiceIntent.ts - deterministic voice/call intent
// classification (Phase 9, items 16, 19).
//
// Deliberately NOT a third keyword-rule engine: this is a thin adapter over
// the SAME core/business/emailClassification.ts's classifyEmailDeterministic()
// that core/business/whatsappIntent.ts already adapts - generalizing, not
// forking. On top of that shared base, it adds the voice-specific categories
// the brief calls for (CALLBACK_REQUEST, HUMAN_AGENT_REQUEST, WRONG_NUMBER,
// DO_NOT_CALL, IDENTITY_UNCLEAR) via its own small, explicit, DATA-driven
// keyword table - never a fuzzy/LLM judgment call, same "deterministic
// first" precedent Phase 7/8 set for inbound classification.
import { classifyEmailDeterministic, type EmailCategory } from "./emailClassification";
import { isOptOutMessage } from "./antiSpam";

export type VoiceIntent =
  | Exclude<EmailCategory, "GENERAL_REPLY" | "UNSUBSCRIBE_REQUEST">
  | "CALLBACK_REQUEST"
  | "HUMAN_AGENT_REQUEST"
  | "WRONG_NUMBER"
  | "DO_NOT_CALL"
  | "IDENTITY_UNCLEAR"
  | "UNKNOWN";

export interface VoiceIntentResult {
  intent: VoiceIntent;
  reasons: string[];
  confidence: number;
}

const LOW_CONFIDENCE_THRESHOLD = 0.5;

// DATA-driven keyword rules, checked BEFORE falling back to the shared email
// classifier (these are checked first because they are voice-specific and
// would otherwise be missed entirely by emailClassification.ts's rule set,
// which has no concept of them).
const VOICE_RULES: Array<{ intent: VoiceIntent; keywords: string[] }> = [
  { intent: "WRONG_NUMBER", keywords: ["wrong number", "who is this", "you have the wrong", "not who you're looking for"] },
  { intent: "HUMAN_AGENT_REQUEST", keywords: ["speak to a person", "speak to someone", "human agent", "real person", "talk to a manager", "customer service representative", "let me talk to a human"] },
  { intent: "CALLBACK_REQUEST", keywords: ["call me back", "call me tomorrow", "call me later", "can you call back", "call again later", "not a good time"] },
  { intent: "DO_NOT_CALL", keywords: ["don't call", "do not call", "stop calling", "remove my number", "take me off your list", "never call this number"] },
];

/**
 * Classifies an inbound call transcript into a deterministic voice intent.
 * `transcript` should already have been passed through
 * core/research/trustBoundary.wrapExternalVoiceContent() before it is EVER
 * interpolated into an LLM prompt - this function itself does plain string
 * matching only, no LLM call, no prompt-injection surface.
 *
 * `identityConfidence` (item 19, PRIVACY): when the caller's identity could
 * not be resolved with confidence (see core/voice/privacy.ts), this function
 * returns IDENTITY_UNCLEAR regardless of what the transcript otherwise says -
 * an unresolved caller asking a CRM-data-bearing question must be routed to
 * a safe "someone will call you back" response, never answered as if their
 * identity were known.
 */
export function classifyVoiceIntentDeterministic(transcript: string, identityConfidence: "RESOLVED" | "UNRESOLVED" = "RESOLVED"): VoiceIntentResult {
  // DO_NOT_CALL is checked BEFORE the identity gate, deliberately: consent
  // (a caller asking never to be called again) must be honorable regardless
  // of whether we can confirm WHO is asking - the identity gate below exists
  // to protect CRM-DATA DISCLOSURE, never to gate the ability to opt out.
  // Withholding suppression from an unresolved caller would be the unsafe
  // direction (see docs/PHASE9_VOICE.md).
  if (isOptOutMessage(transcript)) {
    return { intent: "DO_NOT_CALL", reasons: ["Transcript exactly matches a known opt-out phrase (core/business/antiSpam.ts's isOptOutMessage())."], confidence: 0.9 };
  }
  const lowerFirst = transcript.toLowerCase();
  const doNotCallRule = VOICE_RULES.find((r) => r.intent === "DO_NOT_CALL");
  const doNotCallHit = doNotCallRule?.keywords.find((kw) => lowerFirst.includes(kw));
  if (doNotCallHit) {
    return { intent: "DO_NOT_CALL", reasons: [`Matched voice-specific keyword "${doNotCallHit}" for intent DO_NOT_CALL.`], confidence: 0.8 };
  }

  if (identityConfidence === "UNRESOLVED") {
    // Identity is checked next, before any OTHER content-based
    // classification - the CRM-data-disclosure privacy boundary must never
    // be bypassed by transcript content (e.g. a caller claiming "this is
    // [known customer]").
    return { intent: "IDENTITY_UNCLEAR", reasons: ["Caller identity could not be resolved with confidence - classified IDENTITY_UNCLEAR regardless of transcript content."], confidence: 1 };
  }

  for (const rule of VOICE_RULES) {
    if (rule.intent === "DO_NOT_CALL") continue; // already checked above, before the identity gate
    const lower = transcript.toLowerCase();
    const hit = rule.keywords.find((kw) => lower.includes(kw));
    if (hit) {
      return { intent: rule.intent, reasons: [`Matched voice-specific keyword "${hit}" for intent ${rule.intent}.`], confidence: 0.8 };
    }
  }

  const result = classifyEmailDeterministic("", transcript);
  if (result.category === "GENERAL_REPLY" || result.category === "UNSUBSCRIBE_REQUEST" || result.confidence < LOW_CONFIDENCE_THRESHOLD) {
    return { intent: "UNKNOWN", reasons: [...result.reasons, "Confidence below threshold for a specific intent - classified UNKNOWN rather than guessed."], confidence: result.confidence };
  }
  return { intent: result.category, reasons: result.reasons, confidence: result.confidence };
}
