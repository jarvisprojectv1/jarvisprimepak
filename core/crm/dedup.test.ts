// core/crm/dedup.test.ts - items G (company dedup), H (contact dedup), I (lead dedup).
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../../database/client";
import { findOrCreateCompany, findOrCreateContact, findOrCreateLead, normalizeDomain, normalizeEmail } from "./dedup";

beforeEach(async () => {
  await prisma.lead.deleteMany();
  await prisma.contact.deleteMany();
  await prisma.company.deleteMany();
});

describe("normalizeEmail/normalizeDomain", () => {
  it("normalizes email casing/whitespace", () => {
    expect(normalizeEmail("  John.Doe@Example.COM ")).toBe("john.doe@example.com");
    expect(normalizeEmail(null)).toBeNull();
  });
  it("normalizes a website or email to a bare domain", () => {
    expect(normalizeDomain("https://www.Example.com/about")).toBe("example.com");
    expect(normalizeDomain("sales@example.com")).toBe("example.com");
  });
});

describe("G: company deduplication", () => {
  it("creates a new company when nothing matches", async () => {
    const outcome = await findOrCreateCompany({ name: "Acme Textiles", website: "https://acme-textiles.com" });
    expect(outcome.isNew).toBe(true);
    expect(outcome.possibleDuplicate).toBe(false);
  });

  it("matches an existing company by normalized domain, same name - no duplicate created", async () => {
    const first = await findOrCreateCompany({ name: "Acme Textiles", website: "https://www.acme-textiles.com/" });
    const second = await findOrCreateCompany({ name: "Acme Textiles", website: "http://acme-textiles.com" });
    expect(second.isNew).toBe(false);
    expect(second.record.id).toBe(first.record.id);
    const count = await prisma.company.count();
    expect(count).toBe(1);
  });

  it("flags (not auto-merges) a near-duplicate: same domain, different name", async () => {
    const first = await findOrCreateCompany({ name: "Acme Textiles Ltd", website: "https://acme-textiles.com" });
    const second = await findOrCreateCompany({ name: "Totally Different Co", website: "https://acme-textiles.com" });
    expect(second.record.id).toBe(first.record.id);
    expect(second.possibleDuplicate).toBe(true);
    const row = await prisma.company.findUnique({ where: { id: first.record.id } });
    expect(row?.possibleDuplicate).toBe(true);
  });

  it("never destroys an existing record on a flagged match", async () => {
    const first = await findOrCreateCompany({ name: "Acme Textiles Ltd", website: "https://acme-textiles.com" });
    await findOrCreateCompany({ name: "Different Name", website: "https://acme-textiles.com" });
    const row = await prisma.company.findUnique({ where: { id: first.record.id } });
    expect(row).not.toBeNull();
    expect(row?.name).toBe("Acme Textiles Ltd"); // name never silently overwritten
  });
});

describe("H: contact deduplication", () => {
  it("creates a new contact when nothing matches", async () => {
    const outcome = await findOrCreateContact({ firstName: "Jane", lastName: "Doe", email: "jane@example.com" });
    expect(outcome.isNew).toBe(true);
  });

  it("matches an existing contact by normalized email (case/whitespace insensitive)", async () => {
    const first = await findOrCreateContact({ firstName: "Jane", email: "Jane@Example.com" });
    const second = await findOrCreateContact({ firstName: "Jane", email: " jane@example.com " });
    expect(second.isNew).toBe(false);
    expect(second.record.id).toBe(first.record.id);
  });

  it("flags a same-company same-name but different-email contact as a possible duplicate, and still creates a new row", async () => {
    const company = await findOrCreateCompany({ name: "Acme", website: "https://acme.com" });
    const first = await findOrCreateContact({ firstName: "Jane", lastName: "Doe", email: "jane@acme.com", companyId: company.record.id });
    const second = await findOrCreateContact({ firstName: "Jane", lastName: "Doe", email: "jane.doe@acme.com", companyId: company.record.id });
    expect(second.isNew).toBe(true);
    expect(second.possibleDuplicate).toBe(true);
    expect(second.record.id).not.toBe(first.record.id);
    const count = await prisma.contact.count();
    expect(count).toBe(2); // never silently dropped
  });
});

describe("I: lead deduplication", () => {
  it("reuses an existing OPEN lead for the same company+contact instead of duplicating", async () => {
    const company = await findOrCreateCompany({ name: "Acme", website: "https://acme.com" });
    const contact = await findOrCreateContact({ firstName: "Jane", email: "jane@acme.com", companyId: company.record.id });
    const first = await findOrCreateLead({ companyId: company.record.id, contactId: contact.record.id });
    const second = await findOrCreateLead({ companyId: company.record.id, contactId: contact.record.id });
    expect(second.record.id).toBe(first.record.id);
    const count = await prisma.lead.count();
    expect(count).toBe(1);
  });

  it("flags a second open lead for the same company but a different contact", async () => {
    const company = await findOrCreateCompany({ name: "Acme", website: "https://acme.com" });
    const contactA = await findOrCreateContact({ firstName: "Jane", email: "jane@acme.com", companyId: company.record.id });
    const contactB = await findOrCreateContact({ firstName: "Bob", email: "bob@acme.com", companyId: company.record.id });
    await findOrCreateLead({ companyId: company.record.id, contactId: contactA.record.id });
    const second = await findOrCreateLead({ companyId: company.record.id, contactId: contactB.record.id });
    expect(second.isNew).toBe(true);
    expect(second.possibleDuplicate).toBe(true);
  });

  it("does not match a WON/LOST lead as 'open' - creates a fresh one for a re-engaged company", async () => {
    const company = await findOrCreateCompany({ name: "Acme", website: "https://acme.com" });
    const contact = await findOrCreateContact({ firstName: "Jane", email: "jane@acme.com", companyId: company.record.id });
    const first = await findOrCreateLead({ companyId: company.record.id, contactId: contact.record.id });
    await prisma.lead.update({ where: { id: first.record.id }, data: { status: "LOST" } });
    const second = await findOrCreateLead({ companyId: company.record.id, contactId: contact.record.id });
    expect(second.record.id).not.toBe(first.record.id);
  });
});
