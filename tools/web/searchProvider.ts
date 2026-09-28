// tools/web/searchProvider.ts - SearchProvider implementations (Phase 6,
// item 2).
//
// BraveSearchProvider is a REAL, HTTP-backed implementation targeting the
// Brave Search API (https://api.search.brave.com/res/v1/web/search), chosen
// for its simple REST/API-key shape (a single GET with an
// `X-Subscription-Token` header), matching the request shape documented in
// Brave's public API reference as of this writing. IMPORTANT HONESTY NOTE
// (see docs/PHASE6_WEB_RESEARCH.md and the phase report): this sandbox has
// no BRAVE_SEARCH_API_KEY credential available, so this implementation has
// NOT been exercised against the live API - it is implemented carefully from
// the documented request/response shape, but is UNTESTED against a real
// response. All automated tests use a fake SearchProvider
// (tools/web/searchProvider.test.ts / mockSearchProvider.ts) instead of this
// class, per the task's own instruction to avoid live-network tests.
//
// Exactly like core/ai/provider.ts's AnthropicProvider: if the API key env
// var is missing, `search()` returns a typed CONFIGURATION_REQUIRED error
// instead of throwing or fabricating results.
import { ConfigurationRequiredError, requireEnv, optionalEnv } from "../../config/env";
import { log } from "../../security/logger";
import { domainOf } from "./sourceResolver";
import type { SearchProvider, SearchOptions, SearchResult, ProviderError } from "./types";

const DEFAULT_TIMEOUT_MS = parseInt(optionalEnv("WEB_SEARCH_TIMEOUT_MS", "10000"), 10);
const MAX_RETRIES = parseInt(optionalEnv("WEB_SEARCH_MAX_RETRIES", "2"), 10);
const BASE_BACKOFF_MS = 300;
const DEFAULT_COUNT = parseInt(optionalEnv("WEB_SEARCH_DEFAULT_COUNT", "10"), 10);
const MAX_COUNT = 20;

function isTransientHttpStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface BraveWebResultItem {
  title?: string;
  url?: string;
  description?: string;
  age?: string; // Brave's loosely-formatted "published" hint, if present
}

interface BraveSearchResponse {
  web?: { results?: BraveWebResultItem[] };
}

export class BraveSearchProvider implements SearchProvider {
  public readonly name = "brave";

  private getApiKey(): string {
    return requireEnv(
      "BRAVE_SEARCH_API_KEY",
      "Set it in .env to enable real web search. See .env.example. Get a key at https://brave.com/search/api/."
    );
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[] | ProviderError> {
    let apiKey: string;
    try {
      apiKey = this.getApiKey();
    } catch (err) {
      if (err instanceof ConfigurationRequiredError) {
        return { code: "CONFIGURATION_REQUIRED", message: err.message };
      }
      throw err;
    }

    const count = Math.min(options.count ?? DEFAULT_COUNT, MAX_COUNT);
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(count));

    let lastError: { status?: number; message: string } | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url.toString(), {
          method: "GET",
          headers: {
            Accept: "application/json",
            "X-Subscription-Token": apiKey,
          },
          signal: controller.signal,
        });
        clearTimeout(timer);

        if (!response.ok) {
          lastError = { status: response.status, message: `Brave Search API returned HTTP ${response.status}.` };
          if (attempt < MAX_RETRIES && isTransientHttpStatus(response.status)) {
            await delay(BASE_BACKOFF_MS * 2 ** attempt);
            continue;
          }
          return { code: "PROVIDER_ERROR", message: lastError.message };
        }

        const body = (await response.json()) as BraveSearchResponse;
        const items = body.web?.results ?? [];
        return items
          .filter((item): item is Required<Pick<BraveWebResultItem, "title" | "url">> & BraveWebResultItem =>
            Boolean(item.title && item.url)
          )
          .map((item) => ({
            title: item.title as string,
            url: item.url as string,
            snippet: item.description ?? "",
            domain: domainOf(item.url as string),
            publishedAt: item.age,
            providerMetadata: { provider: "brave" },
          }));
      } catch (err) {
        clearTimeout(timer);
        const aborted = err instanceof Error && err.name === "AbortError";
        lastError = { message: aborted ? "Brave Search API request timed out." : err instanceof Error ? err.message : String(err) };
        if (attempt < MAX_RETRIES) {
          log("WARNING", "web.search_retry", { attempt: attempt + 1, message: lastError.message });
          await delay(BASE_BACKOFF_MS * 2 ** attempt);
          continue;
        }
        return { code: aborted ? "TIMEOUT" : "PROVIDER_ERROR", message: lastError.message };
      }
    }

    return { code: "PROVIDER_ERROR", message: lastError?.message ?? "Search failed after retries." };
  }
}

export function createDefaultSearchProvider(): SearchProvider {
  return new BraveSearchProvider();
}
