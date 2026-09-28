// core/business/intelligence/salesFunnel.test.ts - Phase 11, sections 10-13.
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../../../database/client";
import { getSalesFunnel, getPipelineConversion, getPipelineRisk, scoreLead, prioritizeOpenLeads } from "./salesFunnel";
import { resolveTimeWindow } from "./timeWindows";

beforeEach(async () => {
  await prisma.lead.deleteMany();
  await prisma.contact.deleteMany();
  await prisma.company.deleteMany();
});

async function makeLead(overrides: Partial<{ status: string; value: number; qualification: string; updatedAt: Date; contactId: string | null; possibleDuplicate: boolean }> = {}) {
  const contact = await prisma.contact.create({ data: { firstName: "A", email: "a@example.com" } });
  const lead = await prisma.lead.create({
    data: {
      status: overrides.status ?? "NEW",
      value: overrides.value,
      qualification: overrides.qualification,
      contactId: overrides.contactId === undefined ? contact.id : overrides.contactId,
      possibleDuplicate: overrides.possibleDuplicate ?? false,
    },
  });
  if (overrides.updatedAt) {
    await prisma.lead.update({ where: { id: lead.id }, data: { updatedAt: overrides.updatedAt } });
  }
  return lead;
}

describe("getSalesFunnel", () => {
  it("uses the real LEAD_STATUSES pipeline and counts accurately", async () => {
    await makeLead({ status: "NEW" });
    await makeLead({ status: "QUOTING" });
    await makeLead({ status: "QUOTING" });
    const result = await getSalesFunnel();
    expect(result.type).toBe("FACT");
    const quoting = result.value!.find((s) => s.status === "QUOTING");
    expect(quoting?.count).toBe(2);
  });
});

describe("getPipelineConversion", () => {
  it("returns UNKNOWN when there is no activity in the window", async () => {
    const window = resolveTimeWindow("CUSTOM", new Date(), { start: new Date("2020-01-01"), end: new Date("2020-01-02") });
    const result = await getPipelineConversion(window);
    expect(result.type).toBe("UNKNOWN");
    expect(result.value).toBeNull();
  });

  it("computes a conversion rate from real WON/created counts", async () => {
    await makeLead({ status: "WON" });
    await makeLead({ status: "NEW" });
    const window = resolveTimeWindow("TODAY");
    const result = await getPipelineConversion(window);
    expect(result.type).toBe("CALCULATION");
    expect(result.value!.created).toBeGreaterThanOrEqual(2);
  });
});

describe("getPipelineRisk", () => {
  it("flags a lead past its stage's staleness threshold, never a definitive-loss claim", async () => {
    const old = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
    await makeLead({ status: "QUOTING", updatedAt: old });
    const result = await getPipelineRisk();
    expect(result.value!.length).toBe(1);
    expect(result.narrative).not.toMatch(/will leave|will be lost|guaranteed/i);
  });

  it("does not flag a recently-updated lead", async () => {
    await makeLead({ status: "QUOTING" });
    const result = await getPipelineRisk();
    expect(result.value!.length).toBe(0);
  });
});

describe("scoreLead - explainable lead scoring", () => {
  it("returns a score with itemized, non-opaque factors", async () => {
    const lead = await makeLead({ status: "QUOTING", value: 6000, qualification: JSON.stringify({ qualified: true, reasons: ["ok"] }) });
    const result = await scoreLead(lead.id);
    expect(result).not.toBeNull();
    expect(result!.factors.length).toBeGreaterThan(0);
    for (const f of result!.factors) {
      expect(typeof f.reason).toBe("string");
      expect(f.reason.length).toBeGreaterThan(0);
    }
    expect(result!.score).toBeGreaterThan(0);
  });

  it("returns null for a non-existent lead", async () => {
    const result = await scoreLead("nonexistent-id");
    expect(result).toBeNull();
  });
});

describe("prioritizeOpenLeads", () => {
  it("ranks leads by score, highest first", async () => {
    await makeLead({ status: "NEW" });
    await makeLead({ status: "QUOTING", value: 9000, qualification: JSON.stringify({ qualified: true, reasons: [] }) });
    const ranked = await prioritizeOpenLeads();
    expect(ranked.length).toBeGreaterThanOrEqual(2);
    expect(ranked[0].score).toBeGreaterThanOrEqual(ranked[ranked.length - 1].score);
  });
});
