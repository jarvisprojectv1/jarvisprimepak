// core/business/antiSpam.ts - anti-spam / suppression controls (Phase 7,
// item 17). Setting-backed config, same pattern as core/limits/index.ts
// (which this module deliberately does not duplicate the mechanism of -
// tool/agent rate limiting stays in core/limits; this module is specifically
// about OUTBOUND CUSTOMER COMMUNICATION volume/hygiene).
import { prisma } from "../../database/client";
import { normalizeEmail, normalizePhone } from "../crm/dedup";

export interface AntiSpamConfig {
  perAccountDailyLimit: number;
  perDomainDailyLimit: number;
  perContactCooldownHours: number;
  /** Phase 9 (Voice): a stricter, phone-call-specific cooldown, additive - falls back to perContactCooldownHours when unset. */
  perContactCallCooldownHours?: number;
}

export const DEFAULT_ANTI_SPAM: AntiSpamConfig = {
  perAccountDailyLimit: 200,
  perDomainDailyLimit: 20,
  perContactCooldownHours: 24,
  perContactCallCooldownHours: 48,
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

// ---------------------------------------------------------------------------
// Phase 8 (WhatsApp, item 10): the SAME SuppressedContact table/mechanism,
// extended to a second identifier (normalizedPhone) rather than a parallel
// WhatsApp-only suppression table - see database/schema.prisma's
// SuppressedContact comment. isWhatsAppSuppressed()/suppressWhatsAppContact()
// are the phone-keyed siblings of isSuppressed()/suppressContact() above,
// same fail-closed-on-unparseable-number discipline as normalizePhone().
// ---------------------------------------------------------------------------
export async function isWhatsAppSuppressed(rawPhone: string | null | undefined): Promise<boolean> {
  if (!rawPhone) return false;
  const { normalized, valid } = normalizePhone(rawPhone);
  if (!valid || !normalized) return false; // an unparseable number can't be looked up; the caller's own UNRESOLVED_CONTACT path handles that case
  const row = await prisma.suppressedContact.findUnique({ where: { normalizedPhone: normalized } });
  return Boolean(row);
}

export async function suppressWhatsAppContact(rawPhone: string, reason: "UNSUBSCRIBE" | "BOUNCE" | "MANUAL" | "COMPLAINT", contactId?: string): Promise<void> {
  const { normalized, valid } = normalizePhone(rawPhone);
  if (!valid || !normalized) return;
  await prisma.suppressedContact.upsert({
    where: { normalizedPhone: normalized },
    update: { reason },
    create: { normalizedPhone: normalized, reason, contactId: contactId ?? null },
  });
  if (contactId) {
    await prisma.contact.update({ where: { id: contactId }, data: { unsubscribed: true } });
  } else {
    await prisma.contact.updateMany({ where: { normalizedPhone: normalized }, data: { unsubscribed: true } });
  }
}

// Phase 8 (item 10): a short, precise, deterministic opt-out phrase list -
// NEVER fuzzy sentiment analysis. Matched case/whitespace-insensitively
// against the ENTIRE trimmed message body (not a substring search across an
// arbitrary sentence) so ordinary conversation that happens to contain one
// of these words is not misread as an opt-out (e.g. "please stop calling
// after 6pm" does not match; a standalone "STOP" does).
const OPT_OUT_PHRASES = ["stop", "unsubscribe", "remove me", "do not message", "do not contact", "opt out", "optout"];

/**
 * Deterministic opt-out detection for inbound WhatsApp text (item 10).
 * Returns true only for an exact (post-normalization) match against the
 * fixed phrase list above - never a heuristic/LLM judgment call, since a
 * false positive here silently and permanently stops legitimate outreach.
 */
export function isOptOutMessage(text: string | null | undefined): boolean {
  if (!text) return false;
  const normalized = text.trim().toLowerCase().replace(/[.!?]+$/, "").replace(/\s+/g, " ");
  return OPT_OUT_PHRASES.includes(normalized);
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

/**
 * Phase 8 (items 12, 24): the WhatsApp analogue of checkAntiSpamLimits()
 * above - SAME config (getAntiSpamConfig()), SAME OutboundSendLog ledger,
 * SAME per-account/per-contact-cooldown shape, just keyed by normalized
 * phone + `channel: "WHATSAPP"` instead of email/domain. Deliberately not a
 * second, divergent limiter implementation - "per-domain" has no WhatsApp
 * analogue (there is no domain concept for a phone number) so that check is
 * simply omitted here rather than faked.
 */
export async function checkWhatsAppAntiSpamLimits(input: { toPhone: string }): Promise<AntiSpamCheckResult> {
  const config = await getAntiSpamConfig();
  const since = startOfDayUtc();

  const dailyCount = await prisma.outboundSendLog.count({ where: { status: "SENT", channel: "WHATSAPP", createdAt: { gte: since } } });
  if (dailyCount >= config.perAccountDailyLimit) {
    return { allowed: false, reason: `Per-account daily WhatsApp send limit of ${config.perAccountDailyLimit} reached.` };
  }

  const { normalized } = normalizePhone(input.toPhone);
  if (normalized) {
    const contact = await prisma.contact.findFirst({ where: { normalizedPhone: normalized } });
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

// ---------------------------------------------------------------------------
// Phase 9 (Voice, items 8-9, 25): the SAME SuppressedContact table, keyed by
// normalizedPhone, that Phase 8's isWhatsAppSuppressed()/
// suppressWhatsAppContact() already use - a phone number is a single
// identity across WhatsApp and voice, so a number that has opted out of one
// is treated as opted out of a cold outbound call too (the safer default -
// see docs/PHASE9_VOICE.md's honesty note on this design choice; this is
// NOT a second, phone-scoped-per-channel suppression table, deliberately, to
// avoid a customer who said "stop messaging me" still receiving a call).
// isDoNotCall() is the DO_NOT_CALL-flavored name item 28 asks for; it is a
// thin, documented alias, not a re-derived lookup.
export async function isDoNotCall(rawPhone: string | null | undefined): Promise<boolean> {
  return isWhatsAppSuppressed(rawPhone);
}

export async function suppressPhoneForCalls(rawPhone: string, reason: "UNSUBSCRIBE" | "BOUNCE" | "MANUAL" | "COMPLAINT", contactId?: string): Promise<void> {
  return suppressWhatsAppContact(rawPhone, reason, contactId);
}

/**
 * Phase 9 (items 8-9, 24-25): call-frequency anti-spam limiting - the voice
 * analogue of checkWhatsAppAntiSpamLimits() above. SAME config
 * (getAntiSpamConfig()), SAME OutboundSendLog ledger, filtered by
 * `channel: "VOICE"`. A stricter default per-contact cooldown is used for
 * calls specifically (a phone call is more intrusive than a message), via
 * `perContactCallCooldownHours` on the SAME Setting-backed config object -
 * additive field, does not change any existing email/WhatsApp behavior.
 */
export async function checkVoiceAntiSpamLimits(input: { toPhone: string }): Promise<AntiSpamCheckResult> {
  const config = await getAntiSpamConfig();
  const since = startOfDayUtc();

  const dailyCount = await prisma.outboundSendLog.count({ where: { status: "SENT", channel: "VOICE", createdAt: { gte: since } } });
  if (dailyCount >= config.perAccountDailyLimit) {
    return { allowed: false, reason: `Per-account daily outbound call limit of ${config.perAccountDailyLimit} reached.` };
  }

  const { normalized } = normalizePhone(input.toPhone);
  if (normalized) {
    const contact = await prisma.contact.findFirst({ where: { normalizedPhone: normalized } });
    if (contact?.lastContactedAt) {
      const cooldownHours = config.perContactCallCooldownHours ?? config.perContactCooldownHours;
      const cooldownMs = cooldownHours * 60 * 60 * 1000;
      const elapsed = Date.now() - contact.lastContactedAt.getTime();
      if (elapsed < cooldownMs) {
        return { allowed: false, reason: `Contact is within its ${cooldownHours}h call cooldown (last contacted ${contact.lastContactedAt.toISOString()}).` };
      }
    }
  }

  return { allowed: true };
}
