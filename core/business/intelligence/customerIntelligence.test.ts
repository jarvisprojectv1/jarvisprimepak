// core/business/intelligence/customerIntelligence.test.ts - Phase 11, sections 14-16.
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../../../database/client";
import { getCustomerTimeline, getCustomerSummary, getCommunicationStats } from "./customerIntelligence";
import { resolveTimeWindow } from "./timeWindows";

beforeEach(async () => {
  await prisma.communication.deleteMany();
  await prisma.lead.deleteMany();
  await prisma.contact.deleteMany();
});

describe("getCustomerTimeline", () => {
  it("returns UNKNOWN for a non-existent contact", async () => {
    const result = await getCustomerTimeline("nonexistent");
    expect(result.type).toBe("UNKNOWN");
  });

  it("returns the real communication history, oldest first", async () => {
    const contact = await prisma.contact.create({ data: { firstName: "Bob", email: "bob@example.com" } });
    await prisma.communication.create({ data: { contactId: contact.id, channel: "email", direction: "outbound", createdAt: new Date("2026-01-01") } });
    await prisma.communication.create({ data: { contactId: contact.id, channel: "email", direction: "inbound", createdAt: new Date("2026-01-02") } });
    const result = await getCustomerTimeline(contact.id);
    expect(result.type).toBe("FACT");
    expect(result.value!.length).toBe(2);
    expect(result.value![0].direction).toBe("outbound");
  });
});

describe("getCustomerSummary", () => {
  it("aggregates real lead status counts for a contact", async () => {
    const contact = await prisma.contact.create({ data: { firstName: "Carl", email: "carl@example.com" } });
    await prisma.lead.create({ data: { contactId: contact.id, status: "WON" } });
    await prisma.lead.create({ data: { contactId: contact.id, status: "NEW" } });
    const result = await getCustomerSummary(contact.id);
    expect(result.value!.wonLeadCount).toBe(1);
    expect(result.value!.openLeadCount).toBe(1);
  });
});

describe("getCommunicationStats", () => {
  it("returns UNKNOWN when nothing happened in the window", async () => {
    const window = resolveTimeWindow("CUSTOM", new Date(), { start: new Date("2020-01-01"), end: new Date("2020-01-02") });
    const result = await getCommunicationStats(window);
    expect(result.type).toBe("UNKNOWN");
  });

  it("computes a response-rate proxy from real inbound/outbound overlap", async () => {
    const contact = await prisma.contact.create({ data: { firstName: "D", email: "d@example.com" } });
    const window = resolveTimeWindow("TODAY");
    await prisma.communication.create({ data: { contactId: contact.id, channel: "email", direction: "outbound" } });
    await prisma.communication.create({ data: { contactId: contact.id, channel: "email", direction: "inbound" } });
    const result = await getCommunicationStats(window);
    expect(result.type).toBe("CALCULATION");
    expect(result.value!.responseRate).toBe(100);
  });
});
