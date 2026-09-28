// Strips likely secrets (API keys, tokens, passwords) out of arbitrary values
// before they are logged or persisted. Used by the logger and the audit log
// writer. This is a best-effort heuristic, not a guarantee - never log raw
// secrets on purpose.

const SECRET_KEY_PATTERN =
  /(api[_-]?key|token|secret|password|authorization|bearer|access[_-]?key)/i;

const SECRET_VALUE_PATTERNS = [
  /sk-[a-zA-Z0-9]{10,}/g, // Anthropic/OpenAI-style keys
  /Bearer\s+[a-zA-Z0-9._-]+/gi,
  /[a-zA-Z0-9]{32,}/g, // long opaque tokens (best-effort, may over-redact)
];

const REDACTED = "[REDACTED]";

function redactString(value: string): string {
  let result = value;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    result = result.replace(pattern, REDACTED);
  }
  return result;
}

/**
 * Deep-clones `input`, replacing any string value whose *key* looks secret,
 * or whose *content* matches a known secret shape, with "[REDACTED]".
 */
export function redact<T>(input: T): T {
  return redactValue(input, "") as T;
}

function redactValue(value: unknown, keyHint: string): unknown {
  if (typeof value === "string") {
    if (SECRET_KEY_PATTERN.test(keyHint)) return REDACTED;
    return redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactValue(v, keyHint));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_PATTERN.test(k) ? REDACTED : redactValue(v, k);
    }
    return out;
  }
  return value;
}
