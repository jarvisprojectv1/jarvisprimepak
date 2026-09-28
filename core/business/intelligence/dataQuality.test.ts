// core/business/intelligence/dataQuality.test.ts - Phase 11, sections 42-43.
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../../../database/client";
import { getDataQualityReport, listFlaggedDuplicates } from "./dataQuality";

beforeEach(async () => {
  await prisma.lead.deleteMany();
  await prisma.contact.deleteMany();
  await prisma.company.deleteMany();
});

describe("getDataQualityReport", () => {
  it("reports zero issues on a clean dataset", async () => {
    const result = await getDataQualityReport();
    expect(result.value!.duplicateCompanies).toBe(0);
    expect(result.value!.duplicateContacts).toBe(0);
  });

  it("reads the existing possibleDuplicate flags (does not re-run dedup matching itself)", async () => {
    await prisma.company.create({ data: { name: "Dup Co", possibleDuplicate: true } });
    await prisma.contact.create({ data: { firstName: "NoContact" } }); // missing email AND phone
    const result = await getDataQualityReport();
    expect(result.value!.duplicateCompanies).toBe(1);
    expect(result.value!.contactsMissingEmailAndPhone).toBe(1);
  });
});

describe("listFlaggedDuplicates", () => {
  it("returns UNKNOWN when nothing is flagged", async () => {
    const result = await listFlaggedDuplicates();
    expect(result.type).toBe("UNKNOWN");
  });

  it("lists the actual flagged records, not just a count", async () => {
    await prisma.company.create({ data: { name: "Flagged Co", possibleDuplicate: true } });
    const result = await listFlaggedDuplicates();
    expect(result.value!.some((g) => g.model === "Company" && g.label === "Flagged Co")).toBe(true);
  });
});
