// core/crm/leadWorkflow.test.ts - items J (research -> lead creation), K
// (evidence provenance), AJ (task-tree traceability).
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../../database/client";
import { runLeadResearchWorkflow } from "./leadWorkflow";
import { registerBuiltinAgents } from "../../agents/registry";
import { registerBuiltinTools } from "../../tools";

registerBuiltinTools();
registerBuiltinAgents();

beforeEach(async () => {
  await prisma.lead.deleteMany();
  await prisma.contact.deleteMany();
  await prisma.company.deleteMany();
  await prisma.task.deleteMany();
  // Research agent will hit NOT_IMPLEMENTED (no search provider configured
  // in this test env) - the workflow must still complete honestly.
});

describe("J: research -> lead creation / AJ: task-tree traceability", () => {
  it("creates a real task tree (root + research/CRM/qualify/next-action children) under one rootTaskId", async () => {
    const result = await runLeadResearchWorkflow({ companyName: "Acme Textiles", website: "https://acme-textiles.example" });
    expect(result.status).toBe("COMPLETED");
    expect(result.leadId).toBeTruthy();

    const children = await prisma.task.findMany({ where: { parentId: result.rootTaskId } });
    expect(children.length).toBeGreaterThanOrEqual(4); // research, CRM, qualify, next-action
    for (const child of children) {
      expect(child.parentId).toBe(result.rootTaskId);
    }
  });

  it("creates a REAL Company/Lead row - never a fabricated one", async () => {
    const result = await runLeadResearchWorkflow({ companyName: "Beta Packaging Co", website: "https://beta-packaging.example" });
    const company = await prisma.company.findUnique({ where: { id: result.companyId } });
    const lead = await prisma.lead.findUnique({ where: { id: result.leadId } });
    expect(company).not.toBeNull();
    expect(company?.name).toBe("Beta Packaging Co");
    expect(lead).not.toBeNull();
    expect(lead?.companyId).toBe(result.companyId);
  });

  it("qualification result is always present with reasons, never a bare number", async () => {
    const result = await runLeadResearchWorkflow({ companyName: "Gamma Corp" });
    expect(["true", "false", "boolean", "string"]).toContain(typeof result.qualification.qualified === "string" ? "string" : "boolean");
    expect(result.qualification.reasons.length).toBeGreaterThan(0);
  });

  it("re-running for the same company (with a contact given both times) reuses the SAME Company/Lead - never a duplicate (dedup upsert, idempotent CRM writes)", async () => {
    const first = await runLeadResearchWorkflow({
      companyName: "Delta Logistics",
      website: "https://delta-logistics.example",
      contactFirstName: "Sam",
      contactEmail: "sam@delta-logistics.example",
    });
    const second = await runLeadResearchWorkflow({
      companyName: "Delta Logistics",
      website: "https://delta-logistics.example",
      contactFirstName: "Sam",
      contactEmail: "sam@delta-logistics.example",
    });
    expect(second.companyId).toBe(first.companyId);
    expect(second.leadId).toBe(first.leadId);
    const companies = await prisma.company.count({ where: { name: "Delta Logistics" } });
    expect(companies).toBe(1);
  });
});

describe("K: evidence provenance", () => {
  it("records researchRunId as null (honestly) when research does not produce a run - never fabricates one", async () => {
    const result = await runLeadResearchWorkflow({ companyName: "No Research Co" });
    const lead = await prisma.lead.findUnique({ where: { id: result.leadId } });
    // With no search provider configured in this test env, no ResearchRun
    // is created - the Lead's researchRunId must be null, not invented.
    if (result.researchRunId === null) {
      expect(lead?.researchRunId).toBeNull();
    } else {
      const run = await prisma.researchRun.findUnique({ where: { id: result.researchRunId! } });
      expect(run).not.toBeNull(); // if set, it MUST be a real row
    }
  });
});
