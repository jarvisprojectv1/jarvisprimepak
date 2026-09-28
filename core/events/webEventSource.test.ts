import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { prisma } from "../../database/client";
import { webEventSource } from "./webEventSource";
import { toolRegistry } from "../../tools/registry";
import { createWebSearchTool } from "../../tools/web/searchTool";
import { MockSearchProvider } from "../../tools/web/mockSearchProvider";
import { seedExampleConditionRules } from "../conditions/rules";

// Each test uses a URL unique to this run (embeds Date.now()) rather than a
// fixed literal, since dev.db persists ResearchSource rows across separate
// `npm test` invocations in this environment - a fixed URL would look
// "already known" on a second run and make the dedup assertions flaky.
function freshUrl(label: string): string {
  return `https://news.example.com/${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

describe("core/events/webEventSource - bounded, configured polling (item 7)", () => {
  let provider: MockSearchProvider;

  beforeAll(async () => {
    provider = new MockSearchProvider({ kind: "results", results: [] });
    if (!toolRegistry.get("web_search")) {
      toolRegistry.register(createWebSearchTool(provider));
    }
    await seedExampleConditionRules();
    // Clean up any leftover test-* topics from earlier runs of this suite
    // (dev.db persists across `npm test` invocations in this environment) so
    // each run's assertions aren't diluted by an ever-growing topic list.
    await prisma.researchTopic.deleteMany({ where: { name: { startsWith: "test-topic-" } } });
  });

  afterEach(async () => {
    await prisma.researchTopic.deleteMany({ where: { name: { startsWith: "test-topic-" } } });
  });

  it("O: a genuinely new result for a tracked topic publishes a WEB event that creates a task via the existing condition-rule path", async () => {
    const url = freshUrl("brand-new-article");
    provider.behavior = { kind: "results", results: [{ title: "New Result", url, snippet: "x", domain: "news.example.com" }] };

    const topicName = `test-topic-${Date.now()}`;
    await prisma.researchTopic.create({ data: { name: topicName, query: "anything", enabled: true, pollIntervalMinutes: 0 } });

    const before = await prisma.task.count({ where: { title: "Research new web result" } });
    const { polled, newResults } = await webEventSource.pollDueTopics();
    expect(polled).toBeGreaterThanOrEqual(1);
    expect(newResults).toBeGreaterThanOrEqual(1);

    const after = await prisma.task.count({ where: { title: "Research new web result" } });
    expect(after).toBeGreaterThan(before);

    const event = await prisma.event.findFirst({ where: { type: "WEB.new_research_result" }, orderBy: { createdAt: "desc" } });
    expect(event).not.toBeNull();
  });

  it("R: does not re-report the same canonical URL as new on a second poll", async () => {
    const url = freshUrl("repeat-article");
    provider.behavior = { kind: "results", results: [{ title: "Repeat", url, snippet: "x", domain: "news.example.com" }] };

    const topicName = `test-topic-repeat-${Date.now()}`;
    await prisma.researchTopic.create({ data: { name: topicName, query: "anything", enabled: true, pollIntervalMinutes: 0 } });

    // Simulate the URL already being known (as if a fetch recorded it), then poll - it must not be reported as new.
    await prisma.researchSource.create({
      data: {
        researchRunId: (await prisma.researchRun.create({ data: { query: "seed", createdBy: "test" } })).id,
        url,
        canonicalUrl: url,
        domain: "news.example.com",
        sourceType: "search_result",
      },
    });
    const { newResults } = await webEventSource.pollDueTopics();
    expect(newResults).toBe(0);
  });

  it("respects the minimum poll interval - does not poll a topic again before its interval elapses", async () => {
    const topicName = `test-topic-interval-${Date.now()}`;
    const justPolled = new Date(Date.now() - 60_000); // "polled a minute ago"
    await prisma.researchTopic.create({
      data: { name: topicName, query: "anything", enabled: true, pollIntervalMinutes: 1440, lastPolledAt: justPolled },
    });
    await webEventSource.pollDueTopics();
    const topic = await prisma.researchTopic.findUnique({ where: { name: topicName } });
    // lastPolledAt must be unchanged - it was not due (1440-minute interval, only 1 minute elapsed).
    expect(topic?.lastPolledAt?.getTime()).toBe(justPolled.getTime());
  });
});
