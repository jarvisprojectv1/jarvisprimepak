// core/business/antiSpam.ts - anti-spam / suppression controls (Phase 7,
// item 17). Setting-backed config, same pattern as core/limits/index.ts
// (which this module deliberately does not duplicate the mechanism of -
// tool/agent rate limiting stays in core/limits; this module is specifically
// about OUTBOUND CUSTOMER COMMUNICATION volume/hygiene).
import { prisma } from "../../database/client";
import { normalizeEmail } from "../crm/dedup";

export interface AntiSpamConfig {
  perAccountDailyLimit: number;
  perDomainDailyLimit: number;
  perContactCooldownHours: number;
}

export const DEFAULT_ANTI_SPAM: AntiSpamConfig = {
  perAccountDailyLimit: 200,
  perDomainDailyLimit: 20,
  perContactCooldownHours: 24,
};

const SETTINGS_KEY = "business.anti_spam";

export async function getAntiSpamConfig(): Promise<AntiSpamConfig> {
  const row = await prisma.setting.findUnique({ where: { key: SETTINGS_KEY } });
  if (!row) return { ...DEFAULT_ANTI_SPAM };
  try {
    return { ...DEFAULT_ANTI_SPAM, ...(JSON.parse(row.value) as Partial<AntiSpamConfig>) };
  } catch {
    return { ...DEFAULT_ANTI_SPAM };
  }
}

export async function setAntiSpamConfig(partial: Partial<AntiSpamConfig>): Promise<AntiSpamConfig> {
  const current = await getAntiSpamConfig();
  const next = { ...current, ...partial };
  await prisma.setting.upsert({ where: { key: SETTINGS_KEY }, update: { value: JSON.stringify(next) }, create: { key: SETTINGS_KEY, value: JSON.stringify(next) } });
  return next;
}

export interface AntiSpamCheckResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Suppression check (unsubscribe/bounce/manual). MUST be called BEFORE the
 * outbound risk classification even runs - a suppressed contact is never
 * emailed regardless of risk category.
 */
export async function isSuppressed(email: string | null | undefined): Promise<boolean> {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;
  const row = await prisma.suppressedContact.findUnique({ where: { normalizedEmail: normalized } });
  return Boolean(row);
}

export async function suppressContact(email: string, reason: "UNSUBSCRIBE" | "BOUNCE" | "MANUAL" | "COMPLAINT", contactId?: string): Promise<void> {
  const normalized = normalizeEmail(email);
  if (!normalized) return;
  await prisma.suppressedContact.upsert({
    where: { normalizedEmail: normalized },
    update: { reason },
    create: { normalizedEmail: normalized, reason, contactId: contactId ?? null },
  });
  if (contactId) {
    await prisma.contact.update({ where: { id: contactId }, data: { unsubscribed: true } });
  } else {
    await prisma.contact.updateMany({ where: { normalizedEmail: normalized }, data: { unsubscribed: true } });
  }
}

function startOfDayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Per-account, per-domain daily send limits and per-contact cooldown, using the real OutboundSendLog ledger. */
export async function checkAntiSpamLimits(input: { toEmail: string }): Promise<AntiSpamCheckResult> {
  const config = await getAntiSpamConfig();
  const since = startOfDayUtc();

  const dailyCount = await prisma.outboundSendLog.count({ where: { status: "SENT", createdAt: { gte: since } } });
  if (dailyCount >= config.perAccountDailyLimit) {
    return { allowed: false, reason: `Per-account daily send limit of ${config.perAccountDailyLimit} reached.` };
  }

  const domain = input.toEmail.split("@")[1]?.toLowerCase();
  if (domain) {
    // OutboundSendLog has no declared relation to Contact (plain contactId
    // string, kept a loose reference on purpose - see schema comment), so a
    // domain count joins manually via Contact.normalizedEmail.
    const domainContacts = await prisma.contact.findMany({
      where: { normalizedEmail: { endsWith: `@${domain}` } },
      select: { id: true },
    });
    const domainContactIds = domainContacts.map((c) => c.id);
    const domainSends = domainContactIds.length
      ? await prisma.outboundSendLog.count({
          where: { status: "SENT", createdAt: { gte: since }, contactId: { in: domainContactIds } },
        })
      : 0;
    if (domainSends >= config.perDomainDailyLimit) {
      return { allowed: false, reason: `Per-domain daily send limit of ${config.perDomainDailyLimit} reached for "${domain}".` };
    }
  }

  const normalized = normalizeEmail(input.toEmail);
  if (normalized) {
    const contact = await prisma.contact.findFirst({ where: { normalizedEmail: normalized } });
    if (contact?.lastContactedAt) {
      const cooldownMs = config.perContactCooldownHours * 60 * 60 * 1000;
      const elapsed = Date.now() - contact.lastContactedAt.getTime();
      if (elapsed < cooldownMs) {
        return { allowed: false, reason: `Contact is within its ${config.perContactCooldownHours}h send cooldown (last contacted ${contact.lastContactedAt.toISOString()}).` };
      }
    }
  }

  return { allowed: true };
}
