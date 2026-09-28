// tools/web/mockSearchProvider.ts - a fake SearchProvider for tests (never
// used in production code). Lets tests exercise WebSearchTool / the research
// agent's success/timeout/failure paths without any live network access, per
// the task's own instruction to use a "mocked provider implementation".
import type { SearchProvider, SearchOptions, SearchResult, ProviderError } from "./types";

export class MockSearchProvider implements SearchProvider {
  public readonly name = "mock";
  public calls: string[] = [];

  constructor(
    public behavior:
      | { kind: "results"; results: SearchResult[] }
      | { kind: "error"; error: ProviderError }
      | { kind: "timeout" } = { kind: "results", results: [] }
  ) {}

  async search(query: string, _options?: SearchOptions): Promise<SearchResult[] | ProviderError> {
    this.calls.push(query);
    if (this.behavior.kind === "timeout") {
      return { code: "TIMEOUT", message: `Mock search for "${query}" timed out.` };
    }
    if (this.behavior.kind === "error") {
      return this.behavior.error;
    }
    return this.behavior.results;
  }
}

export class ConfigurationRequiredMockProvider implements SearchProvider {
  public readonly name = "mock-unconfigured";
  async search(): Promise<SearchResult[] | ProviderError> {
    return { code: "CONFIGURATION_REQUIRED", message: "CONFIGURATION REQUIRED: MOCK_SEARCH_API_KEY is not set." };
  }
}
