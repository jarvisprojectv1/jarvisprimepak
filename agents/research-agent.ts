// agents/research-agent.ts - a real stub agent. It genuinely does a trivial,
// real thing (search JARVIS's own `knowledge` table), and explicitly returns
// NOT_IMPLEMENTED for open-web research, which requires an unavailable
// third-party search integration in Phase 1.
import type { AgentInterface, AgentRunResult, AgentStatus } from "./types";
import { prisma } from "../database/client";
import { log } from "../security/logger";

export class ResearchAgent implements AgentInterface {
  name = "research";
  objective = "Answer research questions using internal knowledge, and flag when external research is needed.";
  status: AgentStatus = "IDLE";

  async run(input: Record<string, unknown> = {}): Promise<AgentRunResult> {
    this.status = "RUNNING";
    const agentRow = await prisma.agent.upsert({
      where: { name: this.name },
      update: { status: "RUNNING", objective: this.objective },
      create: { name: this.name, objective: this.objective, status: "RUNNING" },
    });
    const run = await prisma.agentRun.create({
      data: { agentId: agentRow.id, status: "RUNNING", input: JSON.stringify(input) },
    });

    try {
      const topic = typeof input.topic === "string" ? input.topic : undefined;

      if (!topic) {
        const result: AgentRunResult = {
          status: "FAILED",
          summary: "A 'topic' input is required to research.",
        };
        this.status = result.status;
        await prisma.agentRun.update({
          where: { id: run.id },
          data: { status: result.status, output: JSON.stringify(result), endedAt: new Date() },
        });
        return result;
      }

      const matches = await prisma.knowledge.findMany({
        where: { topic: { contains: topic } },
        take: 10,
      });

      const needsExternalResearch = matches.length === 0;
      const result: AgentRunResult = needsExternalResearch
        ? {
            status: "NOT_IMPLEMENTED",
            summary:
              `No internal knowledge found for "${topic}". Open-web research requires a ` +
              `search provider that is not configured in Phase 1 (see tools/web.ts).`,
            nextAction: "Configure a web search provider (tools/web.ts) or supply the answer manually.",
          }
        : {
            status: "SUCCESS",
            summary: `Found ${matches.length} internal knowledge entr${matches.length === 1 ? "y" : "ies"} for "${topic}".`,
            data: { matches },
            result: { matches },
            evidence: { matchCount: matches.length, matchIds: matches.map((m) => m.id) },
          };

      this.status = result.status;
      await prisma.agent.update({ where: { id: agentRow.id }, data: { status: result.status } });
      await prisma.agentRun.update({
        where: { id: run.id },
        data: { status: result.status, output: JSON.stringify(result), endedAt: new Date() },
      });
      log("AGENT", "research-agent.run", { status: result.status, topic });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.status = "FAILED";
      await prisma.agent.update({ where: { id: agentRow.id }, data: { status: "FAILED" } });
      await prisma.agentRun.update({
        where: { id: run.id },
        data: { status: "FAILED", output: message, endedAt: new Date() },
      });
      log("ERROR", "research-agent.error", { error: message });
      return { status: "FAILED", summary: message };
    }
  }
}
