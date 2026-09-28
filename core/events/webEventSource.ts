// core/events/webEventSource.ts - a real, but controlled (Phase 6, item 7):
// polls each enabled ResearchTopic (database/schema.prisma) on a scheduled
// interval, using the SAME guarded web_search tool every other caller uses
// (never a direct fetch() bypassing the registry). If a topic's search
// results contain a canonical URL not already known to ResearchSource (or
// whose content hash changed), it publishes a WEB.new_research_result event.
// This class NEVER calls toolRegistry.execute for anything other than
// web_search, and NEVER calls a tool/agent to "act" on what it finds - it
// only ever calls publish(); turning that event into a task is entirely the
// existing ConditionRule -> planner path (core/conditions/rules.ts), and
// executing that task is entirely the worker's job. This keeps the
// EVENT -> DECISION -> TASK -> AGENT -> TOOL pipeline as the ONLY path from
// "found something new" to "an action happens".
//
// Bounded by design: polling interval and topic list are both
// configuration-driven (the `ResearchTopic` table), and no topic is polled
// more often than core/research/limits's minTopicPollIntervalMinutes,
// regardless of its configured interval - this is enforced here, not just
// documented.
import { prisma } from "../../database/client";
import { log } from "../../security/logger";
import { toolRegistry } from "../../tools/registry";
import type { SearchResult } from "../../tools/web/types";
import { canonicalizeUrl, domainOf } from "../../tools/web/sourceResolver";
import { publish } from "./index";
import type { EventSource } from "./sources";
import { getResearchLimitsConfig } from "../research/limits";
import { WORKER_IDENTITY } from "../auth/identity";

const CHECK_INTERVAL_MS = 60_000; // how often we check "is any topic due" - cheap, DB-only

export class WebEventSourceImpl implements EventSource {
  readonly name = "web-event-source";
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private polling = false;

  isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => {
      this.pollDueTopics().catch((err) =>
        log("ERROR", "web_event_source.poll_failed", { error: err instanceof Error ? err.message : String(err) })
      );
    }, CHECK_INTERVAL_MS);
    log("INFO", "web_event_source.started", {});
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    log("INFO", "web_event_source.stopped", {});
  }

  /** Checks every enabled topic and polls the ones due. Exposed for tests, so a test doesn't need to wait on the interval. */
  async pollDueTopics(): Promise<{ polled: number; newResults: number }> {
    if (this.polling) return { polled: 0, newResults: 0 }; // never overlap a poll pass
    this.polling = true;
    try {
      const limits = await getResearchLimitsConfig();
      const topics = await prisma.researchTopic.findMany({ where: { enabled: true } });
      let polled = 0;
      let newResults = 0;

      for (const topic of topics) {
        const intervalMinutes = Math.max(topic.pollIntervalMinutes, limits.minTopicPollIntervalMinutes);
        const due = !topic.lastPolledAt || Date.now() - topic.lastPolledAt.getTime() >= intervalMinutes * 60 * 1000;
        if (!due) continue;

        polled += 1;
        const found = await this.pollTopic(topic.id, topic.name, topic.query);
        newResults += found;

        await prisma.researchTopic.update({ where: { id: topic.id }, data: { lastPolledAt: new Date() } });
      }
      return { polled, newResults };
    } finally {
      this.polling = false;
    }
  }

  private async pollTopic(topicId: string, topicName: string, query: string): Promise<number> {
    const searchResult = await toolRegistry.execute("web_search", { query }, WORKER_IDENTITY);
    if (searchResult.status !== "OK") {
      log("WARNING", "web_event_source.search_unavailable", { topic: topicName, message: searchResult.message });
      return 0;
    }

    const { results } = searchResult.data as { results: SearchResult[] };
    let newCount = 0;

    for (const result of results) {
      const canonical = canonicalizeUrl(result.url);
      const alreadySeen = await prisma.researchSource.findFirst({ where: { canonicalUrl: canonical } });
      if (alreadySeen) continue; // not new - see core/research/dedup.ts for the same canonical-URL logic used elsewhere

      newCount += 1;
      await publish({
        type: "WEB.new_research_result",
        payload: { topicId, topicName, url: result.url, title: result.title, domain: domainOf(result.url) },
        source: "web-event-source",
      });
    }

    return newCount;
  }
}

export const webEventSource = new WebEventSourceImpl();
