// tools/web/fetchTool.ts - WebFetchTool (Phase 6, item 3).
//
// Controls enforced: protocol allowlist (http/https only, via
// sourceResolver.validateUrl), timeout, maximum response size (streamed,
// aborted once exceeded), a manual redirect loop with a hard limit,
// content-type allowlist, structured HTML extraction (title + text,
// scripts/styles stripped, canonical link resolution), and honest
// BLOCKED/ERROR failure states - never a fake success. Explicitly does NOT
// attempt to bypass CAPTCHA/login walls/paywalls/anti-bot challenges: a
// 401/403/407/429, or a response that looks like a bot-challenge page, is
// reported as BLOCKED.
import type { Tool, ToolResult } from "../registry";
import { validateUrl, canonicalizeUrl, domainOf } from "./sourceResolver";
import { extractHtml } from "./htmlExtract";
import type { FetchedPage } from "./types";
import { checkResearchOpBudget, isBackedOff, recordFetchFailure, recordFetchSuccess } from "../../core/research/limits";
import { optionalEnv } from "../../config/env";
import { log } from "../../security/logger";

// Read lazily (not as module-level constants) so tests can override these via
// process.env per-case without needing to re-import the module.
function config() {
  return {
    timeoutMs: parseInt(optionalEnv("WEB_FETCH_TIMEOUT_MS", "10000"), 10),
    maxRedirects: parseInt(optionalEnv("WEB_FETCH_MAX_REDIRECTS", "5"), 10),
    maxResponseBytes: parseInt(optionalEnv("WEB_FETCH_MAX_BYTES", String(2 * 1024 * 1024)), 10), // 2MB default
    maxTextChars: parseInt(optionalEnv("WEB_FETCH_MAX_TEXT_CHARS", "50000"), 10),
  };
}

const ALLOWED_CONTENT_TYPES = [/^text\/html/i, /^application\/json/i, /^text\/plain/i, /^application\/xhtml\+xml/i];

const BLOCKED_STATUS_CODES = new Set([401, 403, 407, 429]);
const CHALLENGE_MARKERS = [/captcha/i, /cloudflare.*checking your browser/i, /access denied/i, /are you a robot/i];

interface FetchOutcome {
  ok: true;
  page: FetchedPage;
}
interface FetchFailure {
  ok: false;
  status: "BLOCKED" | "ERROR";
  message: string;
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    return { text: text.slice(0, maxBytes), truncated: text.length > maxBytes };
  }
  const decoder = new TextDecoder();
  let received = 0;
  let out = "";
  let truncated = false;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      const remainingAllowed = Math.max(0, maxBytes - (received - value.byteLength));
      out += decoder.decode(value.slice(0, remainingAllowed));
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    out += decoder.decode(value, { stream: true });
  }
  return { text: out, truncated };
}

async function fetchWithControls(startUrl: string): Promise<FetchOutcome | FetchFailure> {
  const { timeoutMs, maxRedirects, maxResponseBytes, maxTextChars } = config();
  let currentUrl = startUrl;
  let redirectCount = 0;

  for (;;) {
    const validation = validateUrl(currentUrl);
    if (!validation.valid) {
      return { ok: false, status: "ERROR", message: validation.reason ?? "Invalid URL." };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(currentUrl, { redirect: "manual", signal: controller.signal });
    } catch (err) {
      clearTimeout(timer);
      const aborted = err instanceof Error && err.name === "AbortError";
      return {
        ok: false,
        status: "ERROR",
        message: aborted ? `Fetch of "${currentUrl}" timed out after ${timeoutMs}ms.` : `Fetch of "${currentUrl}" failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    clearTimeout(timer);

    // Manual redirect handling so we can enforce a hard redirect limit.
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      redirectCount += 1;
      if (redirectCount > maxRedirects) {
        return { ok: false, status: "ERROR", message: `Exceeded redirect limit (${maxRedirects}) fetching "${startUrl}".` };
      }
      currentUrl = new URL(response.headers.get("location") as string, currentUrl).toString();
      continue;
    }

    if (BLOCKED_STATUS_CODES.has(response.status)) {
      return {
        ok: false,
        status: "BLOCKED",
        message: `Fetch of "${currentUrl}" was blocked (HTTP ${response.status}). JARVIS does not attempt to bypass login walls, CAPTCHAs, or anti-bot protections.`,
      };
    }

    if (!response.ok) {
      return { ok: false, status: "ERROR", message: `Fetch of "${currentUrl}" returned HTTP ${response.status}.` };
    }

    const contentType = response.headers.get("content-type") ?? "";
    const contentTypeOk = ALLOWED_CONTENT_TYPES.some((re) => re.test(contentType));
    if (!contentTypeOk) {
      return { ok: false, status: "ERROR", message: `Fetch of "${currentUrl}" returned unsupported content-type "${contentType}".` };
    }

    const { text: rawBody, truncated } = await readBoundedBody(response, maxResponseBytes);

    if (CHALLENGE_MARKERS.some((re) => re.test(rawBody.slice(0, 5000)))) {
      return {
        ok: false,
        status: "BLOCKED",
        message: `Fetch of "${currentUrl}" returned what looks like a bot-challenge/CAPTCHA page. JARVIS does not attempt to bypass this.`,
      };
    }

    let title: string | null = null;
    let text = rawBody;
    let canonicalFromPage: string | null = null;
    if (/^text\/html/i.test(contentType) || /^application\/xhtml\+xml/i.test(contentType)) {
      const extracted = extractHtml(rawBody);
      title = extracted.title;
      text = extracted.text;
      canonicalFromPage = extracted.canonicalUrl;
    }

    const textTruncated = text.length > maxTextChars;
    if (textTruncated) text = text.slice(0, maxTextChars);

    const canonicalUrl = canonicalFromPage
      ? canonicalizeUrl(new URL(canonicalFromPage, currentUrl).toString())
      : canonicalizeUrl(currentUrl);

    return {
      ok: true,
      page: {
        url: startUrl,
        canonicalUrl,
        domain: domainOf(currentUrl),
        title,
        text,
        contentType,
        statusCode: response.status,
        fetchedAt: new Date().toISOString(),
        truncated: truncated || textTruncated,
        redirectCount,
      },
    };
  }
}

export const webFetchTool: Tool = {
  name: "web_fetch",
  description: "Fetch a single URL (http/https only) and extract its title + readable text. Never bypasses CAPTCHAs/login walls.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "The URL to fetch." },
      taskId: { type: "string", description: "Optional task id, for per-task fetch budget accounting." },
    },
    required: ["url"],
  },
  async execute(input): Promise<ToolResult> {
    const url = typeof input.url === "string" ? input.url.trim() : "";
    if (!url) return { status: "ERROR", message: "web_fetch requires a non-empty 'url'." };

    const validation = validateUrl(url);
    if (!validation.valid) return { status: "ERROR", message: validation.reason ?? "Invalid URL." };

    const canonical = canonicalizeUrl(url);
    if (isBackedOff(canonical)) {
      return { status: "BLOCKED", message: `"${url}" has failed repeatedly recently and is temporarily backed off.` };
    }

    const taskId = typeof input.taskId === "string" ? input.taskId : undefined;
    if (taskId) {
      const budget = await checkResearchOpBudget(taskId, "fetch");
      if (!budget.allowed) {
        return { status: "BLOCKED", message: budget.reason ?? "Fetch budget exceeded for this task." };
      }
    }

    const outcome = await fetchWithControls(url);
    if (!outcome.ok) {
      await recordFetchFailure(canonical);
      log("WARNING", "web.fetch_failed", { url, status: outcome.status, message: outcome.message });
      return { status: outcome.status, message: outcome.message };
    }

    recordFetchSuccess(canonical);
    return {
      status: "OK",
      message: `Fetched "${url}" (${outcome.page.text.length} chars extracted${outcome.page.truncated ? ", truncated" : ""}).`,
      data: outcome.page,
    };
  },
};
