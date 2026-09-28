// agents/crm-agent.ts - a real stub agent: it genuinely queries the `leads`
// table (a true, simple action), and explicitly reports NOT_IMPLEMENTED for
// anything that would require an unavailable integration (e.g. auto-scoring
// leads with external enrichment data).
import type { AgentInterface, AgentRunResult, AgentStatus } from "./types";
import { prisma } from "../database/client";
import { log } from "../security/logger";

export class CrmAgent implements AgentInterface {
  name = "crm";
  objective = "Monitor the CRM pipeline and surface leads that need attention.";
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
      const wantsEnrichment = Boolean(input.enrichLeads);

      const staleThresholdDays = 7;
      const cutoff = new Date(Date.now() - staleThresholdDays * 24 * 60 * 60 * 1000);
      const leads = await prisma.lead.findMany({
        where: { status: { in: ["NEW", "CONTACTED"] }, updatedAt: { lt: cutoff } },
        take: 25,
        orderBy: { updatedAt: "asc" },
      });

      const result: AgentRunResult = wantsEnrichment
        ? {
            status: "NOT_IMPLEMENTED",
            summary:
              `Found ${leads.length} stale lead(s) needing attention, but lead ` +
              `enrichment requires a third-party data provider that is not configured in Phase 1.`,
            data: { staleLeadIds: leads.map((l) => l.id) },
            nextAction: "Configure a lead enrichment provider.",
          }
        : {
            status: "SUCCESS",
            summary: `Found ${leads.length} stale lead(s) (no activity in ${staleThresholdDays}+ days).`,
            data: { staleLeadIds: leads.map((l) => l.id) },
            result: { staleLeadIds: leads.map((l) => l.id) },
            evidence: { leadCount: leads.length, staleLeadIds: leads.map((l) => l.id) },
          };

      this.status = result.status;
      await prisma.agent.update({ where: { id: agentRow.id }, data: { status: result.status } });
      await prisma.agentRun.update({
        where: { id: run.id },
        data: { status: result.status, output: JSON.stringify(result), endedAt: new Date() },
      });
      log("AGENT", "crm-agent.run", { status: result.status, leadCount: leads.length });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.status = "FAILED";
      await prisma.agent.update({ where: { id: agentRow.id }, data: { status: "FAILED" } });
      await prisma.agentRun.update({
        where: { id: run.id },
        data: { status: "FAILED", output: message, endedAt: new Date() },
      });
      log("ERROR", "crm-agent.error", { error: message });
      return { status: "FAILED", summary: message };
    }
  }
}
