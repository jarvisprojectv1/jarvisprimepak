// tools/web/types.ts - shared types for the Phase 6 web tool architecture.
// Kept in a dedicated file so searchProvider.ts, searchTool.ts, fetchTool.ts
// and the research agent can all import the same shapes without a circular
// dependency on any one of them.

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  domain: string;
  publishedAt?: string;
  relevanceScore?: number;
  providerMetadata?: Record<string, unknown>;
}

export interface ProviderError {
  code: "CONFIGURATION_REQUIRED" | "TIMEOUT" | "PROVIDER_ERROR" | "BLOCKED";
  message: string;
}

export function isProviderError(value: SearchResult[] | ProviderError): value is ProviderError {
  return !Array.isArray(value);
}

export interface SearchOptions {
  /** Max results requested. Providers may return fewer. */
  count?: number;
  /** Request timeout in ms. */
  timeoutMs?: number;
}

/**
 * A search provider abstraction. A real implementation calls an external
 * search API; a fake/mock implementation (used in tests, see
 * tools/web/searchProvider.test.ts) returns canned results with no network
 * access at all. Both honor the same contract: never fabricate results,
 * return a typed ProviderError instead.
 */
export interface SearchProvider {
  readonly name: string;
  search(query: string, options?: SearchOptions): Promise<SearchResult[] | ProviderError>;
}

export interface FetchedPage {
  url: string;
  canonicalUrl: string;
  domain: string;
  title: string | null;
  text: string;
  contentType: string;
  statusCode: number;
  fetchedAt: string; // ISO timestamp
  truncated: boolean;
  redirectCount: number;
}
