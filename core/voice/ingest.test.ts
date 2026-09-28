// core/voice/ingest.test.ts - Phase 9, items 5-6, 16-22, 39.
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../../database/client";
import { ingestInboundCallEvent } from "./ingest";
import type { NormalizedInboundVoiceEvent } from "./webhook";

beforeEach(async () => {
  await prisma.call.deleteMany();
  await prisma.contact.deleteMany();
  await prisma.suppressedContact.deleteMany();
});

function event(overrides: Partial<NormalizedInboundVoiceEvent> = {}): NormalizedInboundVoiceEvent {
  return {
    provider: "twilio",
    providerCallId: "CA-test-1",
    callStatus: "ringing",
    direction: "inbound",
    from: "+923001234567",
    to: "+920000000000",
    transcriptionText: null,
    receivedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("ingestInboundCallEvent", () => {
  it("creates a new Call row on first event, with normalized caller number", async () => {
    const result = await ingestInboundCallEvent(event());
    expect(result.isNew).toBe(true);
    const row = await prisma.call.findUnique({ where: { providerCallId: "CA-test-1" } });
    expect(row?.normalizedCallerNumber).toBe("+923001234567");
  });

  it("is idempotent by providerCallId - a repeated status-callback event updates the SAME row, never a duplicate", async () => {
    await ingestInboundCallEvent(event({ callStatus: "ringing" }));
    await ingestInboundCallEvent(event({ callStatus: "in-progress" }));
    const result = await ingestInboundCallEvent(event({ callStatus: "completed" }));
    expect(result.isNew).toBe(false);
    const rows = await prisma.call.findMany({ where: { providerCallId: "CA-test-1" } });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("completed");
  });

  it("an unresolved caller is persisted with contactId null (never guess-attached)", async () => {
    const result = await ingestInboundCallEvent(event());
    expect(result.contactResolution).toBe("UNRESOLVED");
    const row = await prisma.call.findUnique({ where: { providerCallId: "CA-test-1" } });
    expect(row?.contactId).toBeNull();
  });

  it("a resolved caller (exact normalizedPhone match) is linked to the existing Contact", async () => {
    const contact = await prisma.contact.create({ data: { firstName: "Ali", phone: "0300-1234567", normalizedPhone: "+923001234567" } });
    const result = await ingestInboundCallEvent(event());
    expect(result.contactResolution).toBe("RESOLVED");
    const row = await prisma.call.findUnique({ where: { providerCallId: "CA-test-1" } });
    expect(row?.contactId).toBe(contact.id);
  });

  it("a DO_NOT_CALL transcript suppresses the number for future calls", async () => {
    const result = await ingestInboundCallEvent(event({ callStatus: "completed", transcriptionText: "please remove my number from your list" }));
    expect(result.doNotCall).toBe(true);
    const row = await prisma.suppressedContact.findUnique({ where: { normalizedPhone: "+923001234567" } });
    expect(row).not.toBeNull();
  });

  it("an unresolved caller's transcript is classified IDENTITY_UNCLEAR, never a specific CRM-adjacent intent", async () => {
    const result = await ingestInboundCallEvent(event({ callStatus: "completed", transcriptionText: "what's the status of my order?" }));
    expect(result.contactResolution).toBe("UNRESOLVED");
    expect(result.intent).toBe("IDENTITY_UNCLEAR");
  });

  it("a resolved caller asking for a human agent gets outcome HUMAN_HANDOFF and a CRM activity row", async () => {
    const contact = await prisma.contact.create({ data: { firstName: "Ali", phone: "0300-1234567", normalizedPhone: "+923001234567" } });
    await ingestInboundCallEvent(event({ callStatus: "completed", transcriptionText: "let me talk to a human please" }));
    const row = await prisma.call.findUnique({ where: { providerCallId: "CA-test-1" } });
    expect(row?.outcome).toBe("HUMAN_HANDOFF");
    const activity = await prisma.communication.findFirst({ where: { contactId: contact.id, activityType: "CALL_INBOUND" } });
    expect(activity).not.toBeNull();
  });
});
