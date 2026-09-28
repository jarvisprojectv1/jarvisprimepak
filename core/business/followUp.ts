// core/business/followUp.ts - follow-up engine (Phase 7, item 20).
// Data-driven config (Setting-backed, same pattern as core/limits), reusing
// the existing task/scheduler machinery rather than a bespoke timer: a
// follow-up is just another Task, created by whatever caller decides one is
// due (e.g. a daily scheduler pass), and isFollowUpAllowed() is the single
// gate that Task's execution must pass before it may actually send anything.
import { prisma } from "../../database/client";
import { getSystemState } from "../state";
import { isSuppressed } from "./antiSpam";

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
export async function isFollowUpAllowed(input: { taskId: string; contactId?: string | null; sinceTaskCreatedAt: Date }): Promise<FollowUpCheckResult> {
  const state = await getSystemState();
  if (state.state === "EMERGENCY_STOP") return { allowed: false, reason: "System is in EMERGENCY_STOP." };
  if (state.state === "PAUSED") return { allowed: false, reason: "System is globally PAUSED." };

  const task = await prisma.task.findUnique({ where: { id: input.taskId } });
  if (!task || task.status === "CANCELLED") return { allowed: false, reason: "Follow-up task was cancelled." };

  if (input.contactId) {
    const suppressed = await isSuppressed((await prisma.contact.findUnique({ where: { id: input.contactId } }))?.email);
    if (suppressed) return { allowed: false, reason: "Contact is suppressed (unsubscribed/bounced)." };

    const reply = await prisma.communication.findFirst({
      where: { contactId: input.contactId, direction: "inbound", createdAt: { gt: input.sinceTaskCreatedAt } },
    });
    if (reply) return { allowed: false, reason: "Customer replied since this follow-up was scheduled - cancelling." };
  }

  return { allowed: true };
}
