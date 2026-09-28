// core/voice/privacy.test.ts - Phase 9, item 19 (PRIVACY, the novel security
// boundary this phase adds): an unresolved/low-confidence caller must never
// be treated as eligible for CRM-data disclosure.
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../../database/client";
import { resolveCallerIdentity, accessLevelFor, canDiscloseCrmData, SAFE_UNRESOLVED_RESPONSE_TEMPLATE } from "./privacy";

beforeEach(async () => {
  await prisma.contact.deleteMany();
});

describe("resolveCallerIdentity / canDiscloseCrmData", () => {
  it("an unparseable phone number is UNRESOLVED and CANNOT disclose CRM data", async () => {
    const resolution = await resolveCallerIdentity("not-a-phone-number");
    expect(resolution.outcome).toBe("UNRESOLVED");
    expect(accessLevelFor(resolution)).toBe("RESTRICTED");
    expect(canDiscloseCrmData(resolution)).toBe(false);
  });

  it("a well-formed number with no matching contact is UNRESOLVED and CANNOT disclose CRM data", async () => {
    const resolution = await resolveCallerIdentity("+923001234567");
    expect(resolution.outcome).toBe("UNRESOLVED");
    expect(canDiscloseCrmData(resolution)).toBe(false);
  });

  it("an exact normalizedPhone match on a real Contact IS resolved and CAN disclose CRM data", async () => {
    await prisma.contact.create({ data: { firstName: "Ali", phone: "0300-1234567", normalizedPhone: "+923001234567" } });
    const resolution = await resolveCallerIdentity("0300-1234567");
    expect(resolution.outcome).toBe("RESOLVED");
    expect(accessLevelFor(resolution)).toBe("FULL");
    expect(canDiscloseCrmData(resolution)).toBe(true);
  });

  it("a contact flagged possibleDuplicate is treated as NOT confidently resolved (RESTRICTED)", async () => {
    await prisma.contact.create({ data: { firstName: "Ali", phone: "0300-1234567", normalizedPhone: "+923001234567", possibleDuplicate: true } });
    const resolution = await resolveCallerIdentity("0300-1234567");
    expect(resolution.outcome).toBe("UNRESOLVED");
    expect(canDiscloseCrmData(resolution)).toBe(false);
  });

  it("no caller number at all is UNRESOLVED, never treated as an implicit match", async () => {
    const resolution = await resolveCallerIdentity(undefined);
    expect(resolution.outcome).toBe("UNRESOLVED");
    expect(canDiscloseCrmData(resolution)).toBe(false);
  });

  it("resolveCallerIdentity never creates a Contact as a side effect (strictly read-only)", async () => {
    const before = await prisma.contact.count();
    await resolveCallerIdentity("+923001234567");
    const after = await prisma.contact.count();
    expect(after).toBe(before);
  });

  it("the safe fallback template never claims to have checked an account", () => {
    expect(SAFE_UNRESOLVED_RESPONSE_TEMPLATE.toLowerCase()).not.toMatch(/your (order|account|quote) is/);
  });
});
