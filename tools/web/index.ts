// tools/web/index.ts - Phase 6 web tool barrel. Registers WebSearchTool and
// WebFetchTool into the shared tool registry (tools/index.ts imports this).
export { webSearchTool, createWebSearchTool } from "./searchTool";
export { webFetchTool } from "./fetchTool";
export { BraveSearchProvider, createDefaultSearchProvider } from "./searchProvider";
export { validateUrl, canonicalizeUrl, domainOf } from "./sourceResolver";
export { extractHtml } from "./htmlExtract";
export type { SearchProvider, SearchResult, ProviderError, SearchOptions, FetchedPage } from "./types";
export { isProviderError } from "./types";
