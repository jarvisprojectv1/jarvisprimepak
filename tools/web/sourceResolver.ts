// tools/web/sourceResolver.ts - small, composable URL helpers (Phase 6,
// item 3). Not a Tool itself - used by WebFetchTool, the dedup module, and
// the research agent.

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

// Common tracking params to strip during canonicalization (best-effort, not
// exhaustive - documented as such).
const TRACKING_PARAM_PREFIXES = ["utm_", "fbclid", "gclid", "msclkid", "mc_eid", "mc_cid", "ref", "ref_src"];

export interface UrlValidationResult {
  valid: boolean;
  reason?: string;
  url?: URL;
}

/** Validates a URL string is well-formed and uses an allowed protocol (http/https only). */
export function validateUrl(input: string): UrlValidationResult {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return { valid: false, reason: `"${input}" is not a well-formed URL.` };
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return { valid: false, reason: `Protocol "${parsed.protocol}" is not allowed. Only http/https URLs may be fetched.` };
  }
  return { valid: true, url: parsed };
}

/**
 * Canonicalizes a URL for deduplication: lowercases scheme/host, strips
 * known tracking params, sorts remaining query params, strips a trailing
 * slash and the fragment. Best-effort, not a full canonicalization spec.
 */
export function canonicalizeUrl(input: string): string {
  const { valid, url } = validateUrl(input);
  if (!valid || !url) return input;

  const proto = url.protocol.toLowerCase();
  const host = url.hostname.toLowerCase();
  const port = url.port && !((proto === "https:" && url.port === "443") || (proto === "http:" && url.port === "80"))
    ? `:${url.port}`
    : "";

  const params = Array.from(url.searchParams.entries()).filter(
    ([key]) => !TRACKING_PARAM_PREFIXES.some((p) => key.toLowerCase().startsWith(p))
  );
  params.sort(([a], [b]) => a.localeCompare(b));
  const query = params.length > 0 ? `?${params.map(([k, v]) => `${k}=${v}`).join("&")}` : "";

  let pathname = url.pathname;
  if (pathname.length > 1 && pathname.endsWith("/")) {
    pathname = pathname.slice(0, -1);
  }

  return `${proto}//${host}${port}${pathname}${query}`;
}

export function domainOf(input: string): string {
  const { valid, url } = validateUrl(input);
  return valid && url ? url.hostname.toLowerCase() : "";
}
