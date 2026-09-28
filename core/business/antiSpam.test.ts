// core/business/antiSpam.test.ts - item T (suppression) unit coverage and
// anti-spam limit config, beyond what emailTool.test.ts exercises end-to-end.
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../../database/client";
import { isSuppressed, suppressContact, getAntiSpamConfig, setAntiSpamConfig, DEFAULT_ANTI_SPAM, checkAntiSpamLimits } from "./antiSpam";

beforeEach(async () => {
  await prisma.suppressedContact.deleteMany();
  await prisma.contact.deleteMany();
  await prisma.outboundSendLog.deleteMany();
  await setAntiSpamConfig(DEFAULT_ANTI_SPAM);
});

describe("T: suppression list", () => {
  it("is false for a never-suppressed address", async () => {
    expect(await isSuppressed("new@brand.example")).toBe(false);
  });

  it("suppressContact() hard-blocks future checks, normalized (case/whitespace insensitive)", async () => {
    await suppressContact("Unsub@Brand.example", "UNSUBSCRIBE");
    expect(await isSuppressed(" unsub@brand.example ")).toBe(true);
  });

  it("also flips the linked Contact.unsubscribed flag when a contactId is known", async () => {
    const contact = await prisma.contact.create({ data: { firstName: "Jane", email: "jane@brand.example", normalizedEmail: "jane@brand.example" } });
    await suppressContact("jane@brand.example", "BOUNCE", contact.id);
    const row = await prisma.contact.findUniqueOrThrow({ where: { id: contact.id } });
    expect(row.unsubscribed).toBe(true);
  });
});

describe("anti-spam config", () => {
  it("getAntiSpamConfig returns defaults when unset, and setAntiSpamConfig persists a partial override", async () => {
    const defaults = await getAntiSpamConfig();
    expect(defaults.perAccountDailyLimit).toBe(DEFAULT_ANTI_SPAM.perAccountDailyLimit);
    const updated = await setAntiSpamConfig({ perAccountDailyLimit: 5 });
    expect(updated.perAccountDailyLimit).toBe(5);
    expect(updated.perDomainDailyLimit).toBe(DEFAULT_ANTI_SPAM.perDomainDailyLimit);
  });

  it("checkAntiSpamLimits blocks once the per-account daily limit is reached", async () => {
    await setAntiSpamConfig({ perAccountDailyLimit: 1 });
    await prisma.outboundSendLog.create({ data: { idempotencyKey: "k1", status: "SENT" } });
    const check = await checkAntiSpamLimits({ toEmail: "someone@brand.example" });
    expect(check.allowed).toBe(false);
  });
});
