// core/business/intelligence/recommendations.test.ts - Phase 11, sections 35-37.
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../../../database/client";
import { generateRecommendations } from "./recommendations";
import { resolveTimeWindow } from "./timeWindows";

beforeEach(async () => {
  await prisma.communication.deleteMany();
  await prisma.lead.deleteMany();
  await prisma.contact.deleteMany();
  await prisma.company.deleteMany();
});

describe("generateRecommendations", () => {
  it("returns no pipeline-risk recommendation when nothing is stale", async () => {
    const window = resolveTimeWindow("TODAY");
    const recs = await generateRecommendations(window);
    expect(recs.find((r) => r.id === "rec.pipeline_risk_review")).toBeUndefined();
  });

  it("every recommendation is structured with evidence/reason/risks/priority, never a bare instruction", async () => {
    await prisma.company.create({ data: { name: "Dup", possibleDuplicate: true } });
    const window = resolveTimeWindow("TODAY");
    const recs = await generateRecommendations(window);
    const dq = recs.find((r) => r.id === "rec.data_quality_cleanup");
    expect(dq).toBeDefined();
    expect(dq!.evidence.length).toBeGreaterThan(0);
    expect(dq!.reason.length).toBeGreaterThan(0);
    expect(Array.isArray(dq!.risks)).toBe(true);
    expect(["INFORMATIONAL", "LOW", "MEDIUM", "HIGH"]).toContain(dq!.priority);
    expect(["LOW", "MEDIUM", "HIGH"]).toContain(dq!.confidence);
  });
});
