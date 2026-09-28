// core/business/intelligence/followUpIntelligence.test.ts - Phase 11,
// section 17: the safety-critical "never recommend a follow-up ignoring an
// already-happened reply" behavior.
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../../../database/client";
import { getFollowUpCandidates } from "./followUpIntelligence";

beforeEach(async () => {
  await prisma.communication.deleteMany();
  await prisma.lead.deleteMany();
  await prisma.contact.deleteMany();
});

async function makeOpenLead(status = "CONTACTED") {
  const contact = await prisma.contact.create({ data: { firstName: "X", email: `x-${Math.random()}@example.com` } });
  const lead = await prisma.lead.create({ data: { contactId: contact.id, status } });
  return { contact, lead };
}

describe("getFollowUpCandidates", () => {
  it("recommends a lead with an old outbound message and no reply", async () => {
    const { contact, lead } = await makeOpenLead();
    await prisma.communication.create({
      data: { contactId: contact.id, channel: "email", direction: "outbound", createdAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000) },
    });
    const result = await getFollowUpCandidates(5);
    expect(result.value!.some((c) => c.leadId === lead.id)).toBe(true);
  });

  it("NEVER recommends a lead that already replied since the last outbound message (critical safety rule)", async () => {
    const { contact, lead } = await makeOpenLead();
    const oldOutbound = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    await prisma.communication.create({ data: { contactId: contact.id, channel: "email", direction: "outbound", createdAt: oldOutbound } });
    await prisma.communication.create({
      data: { contactId: contact.id, channel: "email", direction: "inbound", createdAt: new Date(oldOutbound.getTime() + 60 * 60 * 1000) },
    });
    const result = await getFollowUpCandidates(5);
    expect(result.value!.some((c) => c.leadId === lead.id)).toBe(false);
  });

  it("does not recommend a lead contacted too recently", async () => {
    const { contact, lead } = await makeOpenLead();
    await prisma.communication.create({ data: { contactId: contact.id, channel: "email", direction: "outbound", createdAt: new Date() } });
    const result = await getFollowUpCandidates(5);
    expect(result.value!.some((c) => c.leadId === lead.id)).toBe(false);
  });

  it("does not recommend a NURTURE lead", async () => {
    const { contact, lead } = await makeOpenLead("NURTURE");
    await prisma.communication.create({
      data: { contactId: contact.id, channel: "email", direction: "outbound", createdAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000) },
    });
    const result = await getFollowUpCandidates(5);
    expect(result.value!.some((c) => c.leadId === lead.id)).toBe(false);
  });

  it("never contacted yet - not a follow-up candidate", async () => {
    const { lead } = await makeOpenLead();
    const result = await getFollowUpCandidates(5);
    expect(result.value!.some((c) => c.leadId === lead.id)).toBe(false);
  });
});
