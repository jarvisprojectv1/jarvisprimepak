// core/business/intelligence/followUpIntelligence.ts - Phase 11, section 17
// (the one genuinely safety-adjacent BI module).
//
// This module ONLY *identifies candidates* a human/worker might want to
// follow up with - it NEVER creates a FollowUp row, a Task, or calls any
// send/call function itself. If a caller wants to act on a candidate, it
// must go through core/business/followUp.ts's scheduleFollowUp() (which
// itself only ever creates a Task tagged toolName:"email"/"whatsapp"/"voice"
// for the worker to execute through the existing guarded tool pipeline).
//
// Critical correctness rule (reused, not re-derived): a lead/contact must
// NEVER be recommended for follow-up if they already replied on ANY channel
// since the last outbound contact - this file reuses the exact same
// "inbound Communication row since X" check core/business/followUp.ts's
// isFollowUpAllowed() already performs (item 22 there), rather than
// re-implementing a second, possibly-divergent version of that logic.
import { prisma } from "../../../database/client";
import type { IntelligenceStatement } from "./types";

export interface FollowUpCandidate {
  contactId: string;
  leadId: string | null;
  leadStatus: string | null;
  lastOutboundAt: string;
  daysSinceLastOutbound: number;
  hasRepliedSince: boolean; // always false for anything actually included in `candidates`
}

const DEFAULT_STALE_DAYS = 5;

/**
 * Finds open leads whose most recent OUTBOUND communication is older than
 * `staleDays` AND who have NOT replied since (any channel) - the exact
 * "latest CRM/channel state" check the phase spec requires. A contact who
 * replied is filtered OUT entirely, never merely down-weighted, matching
 * core/business/followUp.ts's isFollowUpAllowed() hard-reject discipline.
 */
export async function getFollowUpCandidates(staleDays = DEFAULT_STALE_DAYS, now: Date = new Date()): Promise<IntelligenceStatement<FollowUpCandidate[]>> {
  const openLeads = await prisma.lead.findMany({
    where: { status: { notIn: ["WON", "LOST", "NURTURE"] }, contactId: { not: null } },
    select: { id: true, status: true, contactId: true },
  });

  const candidates: FollowUpCandidate[] = [];
  const sourceIds: string[] = [];

  for (const lead of openLeads) {
    if (!lead.contactId) continue;
    const lastOutbound = await prisma.communication.findFirst({
      where: { contactId: lead.contactId, direction: "outbound" },
      orderBy: { createdAt: "desc" },
    });
    if (!lastOutbound) continue; // never contacted yet - not a "follow-up", that's an initial-outreach decision, out of scope here

    // Reuse the SAME "any inbound Communication since X" check
    // isFollowUpAllowed() performs (core/business/followUp.ts) - not a
    // second implementation of this rule.
    const replySince = await prisma.communication.findFirst({
      where: { contactId: lead.contactId, direction: "inbound", createdAt: { gt: lastOutbound.createdAt } },
    });
    if (replySince) continue; // customer already replied - never a follow-up candidate

    const daysSinceLastOutbound = Math.floor((now.getTime() - lastOutbound.createdAt.getTime()) / (24 * 60 * 60 * 1000));
    if (daysSinceLastOutbound < staleDays) continue;

    candidates.push({
      contactId: lead.contactId,
      leadId: lead.id,
      leadStatus: lead.status,
      lastOutboundAt: lastOutbound.createdAt.toISOString(),
      daysSinceLastOutbound,
      hasRepliedSince: false,
    });
    sourceIds.push(lead.id, lead.contactId);
  }

  return {
    id: "follow_up.candidates",
    type: "OBSERVATION",
    label: "Follow-up candidates",
    value: candidates,
    narrative:
      candidates.length === 0
        ? "No open leads currently qualify as follow-up candidates (either recently contacted, already replied, or never contacted yet)."
        : `${candidates.length} open lead(s) have had no reply for at least ${staleDays} day(s) since the last outbound message. These are CANDIDATES only - any actual follow-up still goes through core/business/followUp.ts's scheduleFollowUp() and the existing outbound safety pipeline.`,
    provenance: { sourceIds, sourceModel: "Lead+Communication", calculationMethod: `For each open, non-NURTURE lead with a contact: last outbound Communication age >= ${staleDays} days AND no inbound Communication since that outbound message.` },
  };
}
