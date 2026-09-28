import { describe, it, expect } from "vitest";
import { prisma } from "../../database/client";
import { hashContent, shouldRefetch, isUnchanged, isDuplicateContent } from "./dedup";
import { startResearchRun, recordResearchSource } from "./provenance";

describe("core/research/dedup", () => {
  it("hashContent is stable and case/whitespace-insensitive", () => {
    const a = hashContent("Hello   World");
    const b = hashContent("hello world");
    expect(a).toBe(b);
  });

  it("I: detects duplicate content across two different URLs via content hash", async () => {
    const run = await startResearchRun({ query: "dedup-test", createdBy: "test" });
    const hash = hashContent("This is the same article text.");
    await recordResearchSource({
      researchRunId: run.id,
      url: "https://a.example.com/article",
      canonicalUrl: "https://a.example.com/article",
      domain: "a.example.com",
      contentHash: hash,
      sourceType: "fetched_page",
    });
    expect(await isDuplicateContent(hash)).toBe(true);
    expect(await isDuplicateContent(hashContent("totally different text"))).toBe(false);
  });

  it("R: shouldRefetch says no within the refresh window, yes once it has elapsed", async () => {
    const run = await startResearchRun({ query: "refresh-test", createdBy: "test" });
    const url = `https://refresh.example.com/${Date.now()}`;
    const before = await shouldRefetch(url);
    expect(before.shouldFetch).toBe(true); // nothing recorded yet

    await recordResearchSource({
      researchRunId: run.id,
      url,
      canonicalUrl: url,
      domain: "refresh.example.com",
      contentHash: hashContent("v1"),
      sourceType: "fetched_page",
    });

    const withinWindow = await shouldRefetch(url, 60);
    expect(withinWindow.shouldFetch).toBe(false);

    const pastWindow = await shouldRefetch(url, 0);
    expect(pastWindow.shouldFetch).toBe(true);
  });

  it("isUnchanged compares against the most recent stored hash for a canonical URL", async () => {
    const run = await startResearchRun({ query: "unchanged-test", createdBy: "test" });
    const url = `https://unchanged.example.com/${Date.now()}`;
    const hash = hashContent("stable content");
    await recordResearchSource({
      researchRunId: run.id,
      url,
      canonicalUrl: url,
      domain: "unchanged.example.com",
      contentHash: hash,
      sourceType: "fetched_page",
    });
    expect(await isUnchanged(url, hash)).toBe(true);
    expect(await isUnchanged(url, hashContent("different content"))).toBe(false);
  });
});
