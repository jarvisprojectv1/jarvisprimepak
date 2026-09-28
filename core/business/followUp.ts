// core/business/followUp.ts - follow-up engine (Phase 7, item 20).
// Data-driven config (Setting-backed, same pattern as core/limits), reusing
// the existing task/scheduler machinery rather than a bespoke timer: a
// follow-up is just another Task, created by whatever caller decides one is
// due (e.g. a daily scheduler pass), and isFollowUpAllowed() is the single
// gate that Task's execution must pass before it may actually send anything.
import { prisma } from "../../database/client";
import { getSystemState } from "../state";
import { isSuppressed } from "./antiSpam";
import { planTask } from "../planner";
import { log } from "../../security/logger";

export interface FollowUpConfig {
  cooldownHours: number;
}

export const DEFAULT_FOLLOW_UP: FollowUpConfig = { cooldownHours: 72 };

const SETTINGS_KEY = "business.follow_up";

export async function getFollowUpConfig(): Promise<FollowUpConfig> {
  const row = await prisma.setting.findUnique({ where: { key: SETTINGS_KEY } });
  if (!row) return { ...DEFAULT_FOLLOW_UP };
  try {
    return { ...DEFAULT_FOLLOW_UP, ...(JSON.parse(row.value) as Partial<FollowUpConfig>) };
  } catch {
    return { ...DEFAULT_FOLLOW_UP };
  }
}

export async function setFollowUpConfig(partial: Partial<FollowUpConfig>): Promise<FollowUpConfig> {
  const current = await getFollowUpConfig();
  const next = { ...current, ...partial };
  await prisma.setting.upsert({ where: { key: SETTINGS_KEY }, update: { value: JSON.stringify(next) }, create: { key: SETTINGS_KEY, value: JSON.stringify(next) } });
  return next;
}

export interface FollowUpCheckResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Checks every guard a follow-up must pass BEFORE it may create/send
 * anything (item 20's explicit list): an intervening customer reply since
 * the follow-up task was created, suppression, task cancellation, system
 * pause, and emergency stop.
 */
export async function isFollowUpAllowed(input: {
  taskId: string;
  contactId?: string | null;
  sinceTaskCreatedAt: Date;
  /** Phase 7.1: the lead this follow-up concerns, if any - checked for WON/LOST/NURTURE closure. */
  leadId?: string | null;
}): Promise<FollowUpCheckResult> {
  const state = await getSystemState();
  if (state.state === "EMERGENCY_STOP") return { allowed: false, reason: "System is in EMERGENCY_STOP." };
  if (state.state === "PAUSED") return { allowed: false, reason: "System is globally PAUSED." };

  const task = await prisma.task.findUnique({ where: { id: input.taskId } });
  if (!task || task.status === "CANCELLED") return { allowed: false, reason: "Follow-up task was cancelled." };

  if (input.leadId) {
    const lead = await prisma.lead.findUnique({ where: { id: input.leadId } });
    if (!lead) return { allowed: false, reason: "Lead no longer exists." };
    if (lead.status === "WON" || lead.status === "LOST") {
      return { allowed: false, reason: `Lead is ${lead.status} - opportunity closed, cancelling follow-up.` };
    }
    if (lead.status === "NURTURE") {
      // NURTURE means the lead is deliberately parked, not actively being
      // pursued - a scheduled follow-up sequence must not push through it.
      return { allowed: false, reason: "Lead is in NURTURE status - owner has paused active outreach." };
    }
  }

  let contactEmail: string | null | undefined;
  if (input.contactId) {
    const contact = await prisma.contact.findUnique({ where: { id: input.contactId } });
    contactEmail = contact?.email;

    const suppressed = await isSuppressed(contactEmail);
    if (suppressed) return { allowed: false, reason: "Contact is suppressed (unsubscribed/bounced)." };

    // Belt-and-suspenders: Contact.unsubscribed can in principle be true
    // without a matching SuppressedContact row (e.g. set directly), so this
    // is checked too, even though suppressContact() normally keeps both in
    // sync and the isSuppressed() check above already covers the common case.
    if (contact?.unsubscribed) {
      return { allowed: false, reason: "Contact is suppressed (unsubscribed)." };
    }

    const reply = await prisma.communication.findFirst({
      where: { contactId: input.contactId, direction: "inbound", createdAt: { gt: input.sinceTaskCreatedAt } },
    });
    if (reply) return { allowed: false, reason: "Customer replied since this follow-up was scheduled - cancelling." };

    // Item 5: no follow-up while an earlier outbound message to the same
    // contact still has a PENDING approval - sending a follow-up on top of
    // an unresolved HIGH-RISK send would confuse the pipeline and could race
    // the owner's eventual decision.
    if (contactEmail) {
      const pendingApproval = await prisma.approvalRequest.findFirst({
        where: { status: "PENDING", target: contactEmail },
      });
      if (pendingApproval) {
        return { allowed: false, reason: `An earlier outbound message to this contact has a PENDING approval (${pendingApproval.id}) - skipping follow-up until it is resolved.` };
      }
    }
  }

  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Phase 7.1 (items 2-5): follow-up scheduling and worker dispatch. A
// FollowUp row is DATA describing a follow-up that is due; dispatching it
// creates a real Task (tagged toolName:"email") that the worker executes
// through the exact SAME tools/email/emailTool.ts `send` action every other
// outbound email goes through - see that file's follow-up branch. Nothing
// here ever calls an EmailProvider directly.
// ---------------------------------------------------------------------------

export interface ScheduleFollowUpInput {
  leadId?: string | null;
  contactId?: string | null;
  sequenceStep: number;
  subject: string;
  body: string;
  scheduledFor: Date;
}

export interface FollowUpRecord {
  id: string;
  leadId: string | null;
  contactId: string | null;
  sequenceStep: number;
  subject: string;
  body: string;
  scheduledFor: Date;
  status: string;
  cancelReason: string | null;
  taskId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Schedules a follow-up (item 4's idempotency requirement): `leadId +
 * sequenceStep` is DB-unique, so calling this twice for the same lead/step
 * (e.g. a retried caller, two concurrent decisions) reuses the existing row
 * rather than creating a second one. Without a leadId, no such dedup key
 * exists (documented limitation - a contact-only follow-up sequence isn't
 * covered by this constraint), so callers should prefer supplying leadId.
 */
export async function scheduleFollowUp(input: ScheduleFollowUpInput): Promise<FollowUpRecord> {
  if (input.leadId) {
    const existing = await prisma.followUp.findUnique({
      where: { leadId_sequenceStep: { leadId: input.leadId, sequenceStep: input.sequenceStep } },
    });
    if (existing) return existing;
  }
  try {
    return await prisma.followUp.create({
      data: {
        leadId: input.leadId ?? null,
        contactId: input.contactId ?? null,
        sequenceStep: input.sequenceStep,
        subject: input.subject,
        body: input.body,
        scheduledFor: input.scheduledFor,
        status: "SCHEDULED",
      },
    });
  } catch (err) {
    // Race: another concurrent caller won the unique-constraint insert first
    // - reuse their row rather than failing (idempotent-by-construction).
    if (input.leadId) {
      const existing = await prisma.followUp.findUnique({
        where: { leadId_sequenceStep: { leadId: input.leadId, sequenceStep: input.sequenceStep } },
      });
      if (existing) return existing;
    }
    throw err;
  }
}

/**
 * Dispatch pass (item 2): finds every SCHEDULED follow-up whose
 * `scheduledFor` has arrived and has no Task yet, and creates ONE real Task
 * per follow-up, tagged toolName:"email" so the worker executes it directly
 * through the guarded email tool (core/worker/index.ts's processClaimedTask
 * passes {taskId} through so the tool can look the FollowUp back up).
 *
 * Concurrency-safe against two overlapping dispatch passes (item 4's
 * "scheduler duplicate fire" case): the claim step is a single
 * updateMany({where: {id, taskId: null}}) - DB-atomic, so only one caller's
 * pass ever wins the race for a given FollowUp row and creates its Task.
 */
export async function scheduleDueFollowUps(now: Date = new Date()): Promise<{ dispatched: number }> {
  const due = await prisma.followUp.findMany({
    where: { status: "SCHEDULED", scheduledFor: { lte: now }, taskId: null },
  });

  let dispatched = 0;
  for (const followUp of due) {
    const task = await planTask({
      title: `Follow-up (step ${followUp.sequenceStep})`,
      description: `Automated follow-up for FollowUp ${followUp.id}.`,
      priority: "LOW",
      toolName: "email",
    });
    const rootTaskId = task[0].id;

    // Atomic claim: only the caller whose updateMany actually flips a row
    // (count === 1) owns this dispatch; a concurrent pass that lost the race
    // must not leave an orphan Task pointing nowhere, so it deletes the Task
    // it just (wastefully but safely) created.
    const claim = await prisma.followUp.updateMany({
      where: { id: followUp.id, taskId: null },
      data: { taskId: rootTaskId },
    });
    if (claim.count === 1) {
      dispatched += 1;
    } else {
      await prisma.task.delete({ where: { id: rootTaskId } }).catch(() => undefined);
      log("INFO", "followUp.dispatch_race_lost", { followUpId: followUp.id });
    }
  }
  return { dispatched };
}

export async function getFollowUp(id: string): Promise<FollowUpRecord | null> {
  return prisma.followUp.findUnique({ where: { id } });
}

/** Owner/system cancellation of a not-yet-executed follow-up. */
export async function cancelFollowUp(id: string, reason: string): Promise<FollowUpRecord | null> {
  const existing = await prisma.followUp.findUnique({ where: { id } });
  if (!existing || existing.status !== "SCHEDULED") return existing;
  return prisma.followUp.update({ where: { id }, data: { status: "CANCELLED", cancelReason: reason } });
}
