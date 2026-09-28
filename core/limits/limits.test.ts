import { describe, it, expect, beforeEach } from "vitest";
import {
  checkToolRate,
  checkAgentRate,
  acquireAgentSlot,
  releaseAgentSlot,
  setLimitsConfig,
  DEFAULT_LIMITS,
  __resetLimitsForTests,
} from "./index";

describe("core/limits", () => {
  beforeEach(async () => {
    __resetLimitsForTests();
    await setLimitsConfig({ ...DEFAULT_LIMITS });
  });

  it("allows calls under the tool rate limit", async () => {
    await setLimitsConfig({ toolRateLimitPerMinute: 3 });
    for (let i = 0; i < 3; i++) {
      const result = await checkToolRate("files");
      expect(result.allowed).toBe(true);
    }
  });

  it("blocks a tool once its rate limit is exceeded", async () => {
    await setLimitsConfig({ toolRateLimitPerMinute: 2 });
    expect((await checkToolRate("files")).allowed).toBe(true);
    expect((await checkToolRate("files")).allowed).toBe(true);
    const third = await checkToolRate("files");
    expect(third.allowed).toBe(false);
    expect(third.reason).toContain("files");
  });

  it("keeps per-tool rate limits independent", async () => {
    await setLimitsConfig({ toolRateLimitPerMinute: 1 });
    expect((await checkToolRate("files")).allowed).toBe(true);
    expect((await checkToolRate("files")).allowed).toBe(false);
    expect((await checkToolRate("email")).allowed).toBe(true); // different tool, own bucket
  });

  it("blocks an agent once its rate limit is exceeded", async () => {
    await setLimitsConfig({ agentRateLimitPerMinute: 1 });
    expect((await checkAgentRate("research")).allowed).toBe(true);
    expect((await checkAgentRate("research")).allowed).toBe(false);
  });

  it("allows concurrent agents up to the limit and rejects the next", async () => {
    await setLimitsConfig({ concurrentAgentLimit: 2 });
    const first = await acquireAgentSlot("research");
    const second = await acquireAgentSlot("crm");
    const third = await acquireAgentSlot("research");

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    expect(third.allowed).toBe(false);

    releaseAgentSlot(first.token);
    const fourth = await acquireAgentSlot("research");
    expect(fourth.allowed).toBe(true);
  });
});
