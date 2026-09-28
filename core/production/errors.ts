// core/production/errors.ts - Phase 12 (item 7): a small, honest error
// classification scheme used by the API's generic error handler and
// available to any caller that wants to decide "is this worth retrying /
// paging someone / just a client mistake". This does NOT replace or wrap
// core/decision_engine's policy classification (BLOCKED/ALLOWED/NOTIFY) -
// that is about WHETHER an action is permitted; this is about WHAT KIND of
// failure a caught error represents, for logging/alerting/retry purposes
// only. It never overrides a policy decision and is never consulted by
// core/enforcement.
export type ErrorClass =
  | "CLIENT_ERROR" // bad input - retrying unchanged will never succeed
  | "CONFIGURATION_REQUIRED" // a provider/integration isn't configured - not a bug
  | "TRANSIENT" // network/timeout/DB-lock-shaped - a bounded retry MAY help
  | "POLICY_BLOCKED" // enforcement denied the action - MUST NEVER be retried automatically
  | "AUTH_FAILURE" // authentication/authorization failed - MUST NEVER be retried automatically
  | "INTERNAL"; // unexpected/unclassified - treat as a bug to investigate

export interface ClassifiedError {
  errorClass: ErrorClass;
  retryable: boolean;
  message: string;
}

const TRANSIENT_PATTERNS = [
  /ETIMEDOUT/i,
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /timeout/i,
  /SQLITE_BUSY/i,
  /database is locked/i,
  /socket hang up/i,
  /ENOTFOUND/i,
];

/**
 * Best-effort classification of a caught error/message. Deliberately
 * conservative: only TRANSIENT is ever retryable, and only by matching a
 * known transient-shaped pattern - everything else (including anything
 * unrecognized) is `retryable: false` by default, per Phase 12's explicit
 * requirement that nothing ever auto-retries a policy block, an auth
 * failure, an approval-required state, or the financial hard-block. Callers
 * that already have a typed signal (e.g. a ToolResult.status of "BLOCKED")
 * should classify from THAT, not from a stringified message - see
 * classifyToolResultStatus below, which is the one actually used by the
 * retry-policy audit tests.
 */
export function classifyError(err: unknown): ClassifiedError {
  const message = err instanceof Error ? err.message : String(err);

  if (/CONFIGURATION REQUIRED/i.test(message)) {
    return { errorClass: "CONFIGURATION_REQUIRED", retryable: false, message };
  }
  if (/unauthorized|forbidden|invalid session|not authenticated/i.test(message)) {
    return { errorClass: "AUTH_FAILURE", retryable: false, message };
  }
  if (/blocked:/i.test(message) || /EMERGENCY_STOP|globally PAUSED|is paused\.|is disabled\./i.test(message)) {
    return { errorClass: "POLICY_BLOCKED", retryable: false, message };
  }
  if (TRANSIENT_PATTERNS.some((p) => p.test(message))) {
    return { errorClass: "TRANSIENT", retryable: true, message };
  }
  return { errorClass: "INTERNAL", retryable: false, message };
}

/**
 * The typed counterpart used by the worker/retry-policy audit: given a
 * `ToolResult.status` (or an agent's `AgentRunResult.status`), says whether
 * this outcome should EVER be auto-retried. This mirrors - and is proven
 * against, in core/production/retryPolicy.test.ts - core/worker/index.ts's
 * ACTUAL behavior (markTerminal only calls retryOrFailTask for "FAILED";
 * "BLOCKED"/"WAITING" never retry), so this function is documentation-as-code
 * for that existing, unweakened behavior, not a new enforcement layer.
 */
export function isRetryableOutcomeStatus(status: string): boolean {
  return status === "FAILED";
}
