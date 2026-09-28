// core/browser/mfaDetect.ts - MFA/CAPTCHA best-effort detection (Phase 10,
// sections 8-10).
//
// HONESTY NOTE (documented per the brief's explicit instruction): this is a
// best-effort heuristic scan for known CAPTCHA widget markers and
// MFA/verification-code language, NOT a guaranteed detector. A page that
// hides its challenge behind unusual markup, or phrases a verification
// prompt unusually, will not be caught. When triggered, the browser tool
// pauses the task and returns an explicit MFA_REQUIRED/CAPTCHA_DETECTED
// state (mirroring the REQUIRES_INFORMATION/WAITING states already
// established in core/brain/types.ts's BrainResultStatus) rather than ever
// attempting to solve or bypass it - JARVIS has no CAPTCHA-solving or
// MFA-bypass capability anywhere in this codebase, by construction.
export type MfaCaptchaFinding = "MFA_REQUIRED" | "CAPTCHA_DETECTED" | null;

const CAPTCHA_MARKERS = [
  /recaptcha/i,
  /hcaptcha/i,
  /cf-turnstile/i,
  /captcha/i,
  /are you a robot/i,
  /prove you.?re human/i,
];

const MFA_MARKERS = [
  /two-factor/i,
  /two factor/i,
  /\b2fa\b/i,
  /verification code/i,
  /enter the code/i,
  /one-time (passcode|code)/i,
  /\botp\b/i,
  /authenticator app/i,
  /security code/i,
];

export function detectMfaOrCaptcha(pageText: string): MfaCaptchaFinding {
  const text = pageText.slice(0, 20000); // bounded scan, same discipline as the observation model
  if (CAPTCHA_MARKERS.some((re) => re.test(text))) return "CAPTCHA_DETECTED";
  if (MFA_MARKERS.some((re) => re.test(text))) return "MFA_REQUIRED";
  return null;
}
