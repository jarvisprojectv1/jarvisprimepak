// core/business/intelligence/customerIntelligence.ts - Phase 11, sections
// 14-16: customer intelligence, customer timeline, and communication
// intelligence. All deterministic aggregations over Contact/Communication -
// no LLM call anywhere in this file.
import { prisma } from "../../../database/client";
import type { IntelligenceStatement, Provenance } from "./types";
import { unknownStatement } from "./types";
import type { ResolvedWindow } from "./timeWindows";

export interface TimelineEntry {
  id: string;
  channel: string;
  direction: string;
  activityType: string | null;
  summary: string | null;
  createdAt: string;
}

/** Section 15: a contact's full communication timeline, oldest-first, straight from Communication - no synthesis, no interpretation. */
export async function getCustomerTimeline(contactId: string, limit = 200): Promise<IntelligenceStatement<TimelineEntry[]>> {
  const contact = await prisma.contact.findUnique({ where: { id: contactId } });
  if (!contact) return unknownStatement(`customer_timeline.${contactId}`, "Customer timeline", "Contact not found.");

  const rows = await prisma.communication.findMany({
    where: { contactId },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
  const entries: TimelineEntry[] = rows.map((r) => ({
    id: r.id,
    channel: r.channel,
    direction: r.direction,
    activityType: r.activityType,
    summary: r.summary,
    createdAt: r.createdAt.toISOString(),
  }));
  return {
    id: `customer_timeline.${contactId}`,
    type: "FACT",
    label: `Communication timeline for ${contact.firstName} ${contact.lastName ?? ""}`.trim(),
    value: entries,
    narrative: `${entries.length} recorded communication(s) across all channels, oldest first.`,
    provenance: { sourceIds: entries.map((e) => e.id), sourceModel: "Communication", calculationMethod: "Communication rows WHERE contactId = given id, ORDER BY createdAt ASC." },
  };
}

export interface CustomerSummary {
  contactId: string;
  totalCommunications: number;
  lastContactedAt: string | null;
  openLeadCount: number;
  wonLeadCount: number;
  lostLeadCount: number;
}

/** Section 14: a per-contact rollup - counts only, no invented "relationship health" score. */
export async function getCustomerSummary(contactId: string): Promise<IntelligenceStatement<CustomerSummary>> {
  const contact = await prisma.contact.findUnique({ where: { id: contactId } });
  if (!contact) return unknownStatement(`customer_summary.${contactId}`, "Customer summary", "Contact not found.");

  const [totalCommunications, leads] = await Promise.all([
    prisma.communication.count({ where: { contactId } }),
    prisma.lead.findMany({ where: { contactId }, select: { status: true } }),
  ]);
  const openLeadCount = leads.filter((l) => l.status !== "WON" && l.status !== "LOST").length;
  const wonLeadCount = leads.filter((l) => l.status === "WON").length;
  const lostLeadCount = leads.filter((l) => l.status === "LOST").length;

  const summary: CustomerSummary = {
    contactId,
    totalCommunications,
    lastContactedAt: contact.lastContactedAt ? contact.lastContactedAt.toISOString() : null,
    openLeadCount,
    wonLeadCount,
    lostLeadCount,
  };
  return {
    id: `customer_summary.${contactId}`,
    type: "FACT",
    label: `Customer summary for ${contact.firstName} ${contact.lastName ?? ""}`.trim(),
    value: summary,
    narrative: `${totalCommunications} total communication(s); ${openLeadCount} open lead(s), ${wonLeadCount} won, ${lostLeadCount} lost.`,
    provenance: { sourceIds: [contactId], sourceModel: "Contact", calculationMethod: "COUNT(Communication) + Lead status breakdown for this contactId." },
  };
}

export interface CommunicationStats {
  outboundByChannel: Record<string, number>;
  inboundByChannel: Record<string, number>;
  responseRate: number | null;
}

/**
 * Section 16: communication intelligence - outbound/inbound volume per
 * channel in a window, plus a simple response-rate proxy (distinct contacts
 * who sent an inbound message, over distinct contacts who received an
 * outbound message, in-window). Documented as a proxy, not a strict
 * per-message reply-matching rate (no thread-id linkage exists in
 * Communication to do better than that honestly).
 */
export async function getCommunicationStats(window: ResolvedWindow): Promise<IntelligenceStatement<CommunicationStats>> {
  const rows = await prisma.communication.findMany({
    where: { createdAt: { gte: window.start, lt: window.end } },
    select: { channel: true, direction: true, contactId: true },
  });
  if (rows.length === 0) {
    return unknownStatement("communication_stats", `Communication stats (${window.label})`, "No communications recorded in this window.");
  }
  const outboundByChannel: Record<string, number> = {};
  const inboundByChannel: Record<string, number> = {};
  const outboundContacts = new Set<string>();
  const inboundContacts = new Set<string>();
  for (const r of rows) {
    if (r.direction === "outbound") {
      outboundByChannel[r.channel] = (outboundByChannel[r.channel] ?? 0) + 1;
      if (r.contactId) outboundContacts.add(r.contactId);
    } else if (r.direction === "inbound") {
      inboundByChannel[r.channel] = (inboundByChannel[r.channel] ?? 0) + 1;
      if (r.contactId) inboundContacts.add(r.contactId);
    }
  }
  const responseRate =
    outboundContacts.size > 0
      ? Math.round(([...inboundContacts].filter((c) => outboundContacts.has(c)).length / outboundContacts.size) * 1000) / 10
      : null;

  return {
    id: "communication_stats",
    type: "CALCULATION",
    label: `Communication stats (${window.label})`,
    value: { outboundByChannel, inboundByChannel, responseRate },
    narrative:
      responseRate !== null
        ? `${responseRate}% of contacts messaged outbound in this window also had an inbound message in the same window (a proxy for response rate, not per-message thread matching).`
        : "No outbound messages in this window to compute a response-rate proxy against.",
    provenance: { sourceIds: [], sourceModel: "Communication", dateRangeStart: window.start.toISOString(), dateRangeEnd: window.end.toISOString(), calculationMethod: "GROUP BY channel/direction over Communication in window; response rate = |inbound contacts ∩ outbound contacts| / |outbound contacts|." },
  };
}
