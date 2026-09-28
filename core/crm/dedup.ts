// core/crm/dedup.ts - CRM deduplication (Phase 7, item 8).
//
// Rule: normalize, match, and on an AMBIGUOUS/uncertain match, flag
// `possibleDuplicate: true` rather than auto-merging or silently dropping a
// record. An exact, unambiguous match (same normalized email, or same
// normalized domain + same company name) is treated as "the same record" and
// updated in place - never duplicated. Nothing here ever deletes a row.
import { prisma } from "../../database/client";

export function normalizeEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const trimmed = email.trim().toLowerCase();
  return trimmed || null;
}

/** Extracts a normalized domain (lowercase host, no protocol/www./path) from a website or email address. */
export function normalizeDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  let value = input.trim().toLowerCase();
  if (!value) return null;
  if (value.includes("@")) {
    value = value.split("@")[1] ?? "";
  } else {
    value = value.replace(/^https?:\/\//, "").split("/")[0];
  }
  value = value.replace(/^www\./, "");
  return value || null;
}

// ---------------------------------------------------------------------------
// Phase 8 (WhatsApp, item 9): phone normalization - the gap Phase 7.1
// explicitly disclosed and deferred ("Phone normalization does NOT currently
// exist"). WhatsApp identity is phone-number-based, so this is now load-
// bearing for contact resolution (core/whatsapp/conversation.ts), not just a
// nice-to-have CRM field.
//
// Design: a lightweight, dependency-free normalizer targeting E.164 canonical
// form (e.g. "+923001234567"), with EXPLICIT Pakistan-specific handling
// (Prime Pak Packages is a Pakistan-based business - see docs/PHASE8_WHATSAPP.md)
// for the leading-zero/00-prefix/bare-national-number cases a generic E.164
// parser can't disambiguate without a country hint. A number this cannot
// PARSE WITH CONFIDENCE is rejected (`valid: false`, `normalized: null`) -
// never guessed. This function NEVER merges two different raw numbers into
// one contact by itself; it only produces the canonical key
// core/crm/dedup.ts's findOrCreateContactByPhone() then matches on exactly,
// same "no fuzzy matching" discipline as normalizeEmail().
// ---------------------------------------------------------------------------
export interface PhoneNormalizationResult {
  /** E.164-style canonical form ("+<countrycode><nationalnumber>"), or null if unparseable. */
  normalized: string | null;
  valid: boolean;
  reason: string;
}

const PK_COUNTRY_CODE = "92";

/**
 * Normalizes a raw phone string to E.164-style canonical form. Tolerant of
 * spaces, hyphens, parentheses, and dots. Handles, specifically:
 *   - "+923001234567"            (already E.164)
 *   - "00923001234567"           (00 international prefix)
 *   - "923001234567"             (bare country code, no leading +)
 *   - "03001234567"              (Pakistani local mobile/landline, leading 0)
 *   - "3001234567"               (bare Pakistani mobile, no leading 0)
 *   - "+92 0300 1234567"         (country code PLUS a stray local leading 0 -
 *                                  a common real-world user typo, stripped)
 * Anything that doesn't confidently resolve to one of these shapes (too
 * short, too long, no digits, ambiguous) is rejected rather than guessed.
 */
export function normalizePhone(input: string | null | undefined): PhoneNormalizationResult {
  if (!input) return { normalized: null, valid: false, reason: "Empty input." };
  const raw = input.trim();
  if (!raw) return { normalized: null, valid: false, reason: "Empty input." };

  const hadPlus = raw.startsWith("+");
  // Strip everything but digits (spaces, hyphens, parens, dots, the '+' itself).
  let digits = raw.replace(/\D/g, "");
  if (!digits) return { normalized: null, valid: false, reason: "No digits found." };

  const hadInternationalPrefix = hadPlus || digits.startsWith("00");
  if (!hadPlus && digits.startsWith("00")) {
    digits = digits.slice(2);
  }

  if (hadInternationalPrefix) {
    // A country code is already present. Guard against the common
    // "+92 0300 1234567" typo (country code immediately followed by a stray
    // local trunk '0') by stripping that one extra zero.
    if (digits.startsWith(`${PK_COUNTRY_CODE}0`)) {
      digits = PK_COUNTRY_CODE + digits.slice(PK_COUNTRY_CODE.length + 1);
    }
  } else if (digits.startsWith("0") && (digits.length === 10 || digits.length === 11)) {
    // Pakistani local number (mobile: 03XX-XXXXXXX = 11 digits; landline:
    // 0XX-XXXXXXX = 10 digits) - drop the trunk '0', prepend the country code.
    digits = PK_COUNTRY_CODE + digits.slice(1);
  } else if (/^3\d{9}$/.test(digits)) {
    // Bare 10-digit Pakistani mobile number, no leading 0 and no country code.
    digits = PK_COUNTRY_CODE + digits;
  }
  // Else: assume `digits` already includes a plausible country code as typed
  // (e.g. "923001234567" bare, no + and no leading 0) - fall through to
  // the general E.164 shape check below.

  if (digits.length < 8 || digits.length > 15) {
    return { normalized: null, valid: false, reason: `Digit count ${digits.length} outside the plausible E.164 range (8-15) after normalization.` };
  }
  if (digits.startsWith("0")) {
    return { normalized: null, valid: false, reason: "Cannot reliably determine a country code for a leading-zero number without a known country context." };
  }

  return { normalized: `+${digits}`, valid: true, reason: "Normalized to E.164-style canonical form." };
}

export interface CompanyDedupInput {
  name: string;
  website?: string | null;
}

export interface DedupOutcome<T> {
  record: T;
  isNew: boolean;
  possibleDuplicate: boolean;
  matchReason: string;
}

function namesLooselyMatch(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\b(inc|ltd|llc|co|corp|company|pvt|limited)\b/g, "").trim();
  return norm(a) === norm(b);
}

/**
 * Finds-or-creates a Company. Exact match key: normalized domain (from
 * `website`). If the domain matches an existing company whose NAME differs
 * substantially, the existing record is returned but flagged
 * `possibleDuplicate` rather than silently renamed. If no domain is given at
 * all, falls back to an exact case-insensitive name match (still flags a
 * fuzzy-but-not-exact name match as a possible duplicate rather than
 * creating a second row blindly).
 */
export async function findOrCreateCompany(input: CompanyDedupInput): Promise<DedupOutcome<{ id: string; name: string; website: string | null; domain: string | null; possibleDuplicate: boolean }>> {
  const domain = normalizeDomain(input.website);

  if (domain) {
    const existing = await prisma.company.findFirst({ where: { domain } });
    if (existing) {
      const exactName = namesLooselyMatch(existing.name, input.name);
      if (!exactName) {
        const updated = await prisma.company.update({ where: { id: existing.id }, data: { possibleDuplicate: true } });
        return {
          record: updated,
          isNew: false,
          possibleDuplicate: true,
          matchReason: `Matched existing company by domain "${domain}" but company name differs ("${existing.name}" vs "${input.name}") - flagged, not auto-merged.`,
        };
      }
      return { record: existing, isNew: false, possibleDuplicate: existing.possibleDuplicate, matchReason: `Matched existing company by domain "${domain}".` };
    }
  } else {
    const existingByName = await prisma.company.findFirst({ where: { name: { equals: input.name } } });
    if (existingByName) {
      return { record: existingByName, isNew: false, possibleDuplicate: existingByName.possibleDuplicate, matchReason: "Matched existing company by exact name (no website given to disambiguate)." };
    }
  }

  const created = await prisma.company.create({
    data: { name: input.name, website: input.website ?? null, domain },
  });
  return { record: created, isNew: true, possibleDuplicate: false, matchReason: "No existing match; created new company." };
}

export interface ContactDedupInput {
  firstName: string;
  lastName?: string | null;
  email?: string | null;
  companyId?: string | null;
}

/**
 * Finds-or-creates a Contact. Exact match key: normalizedEmail (case/trim
 * insensitive) - the single most reliable identifier. Without an email, a
 * same-company + same-first/last-name match is flagged `possibleDuplicate`
 * (never treated as an automatic match, since two different people can share
 * a name) and a NEW contact row is still created so no real contact is ever
 * silently dropped.
 */
export async function findOrCreateContact(input: ContactDedupInput): Promise<DedupOutcome<{ id: string; firstName: string; lastName: string | null; email: string | null; normalizedEmail: string | null; possibleDuplicate: boolean }>> {
  const normalizedEmail = normalizeEmail(input.email);

  if (normalizedEmail) {
    const existing = await prisma.contact.findFirst({ where: { normalizedEmail } });
    if (existing) {
      return { record: existing, isNew: false, possibleDuplicate: existing.possibleDuplicate, matchReason: `Matched existing contact by normalized email "${normalizedEmail}".` };
    }
  }

  let possibleDuplicate = false;
  let matchReason = "No existing match; created new contact.";
  if (input.companyId) {
    const sameCompanySameName = await prisma.contact.findFirst({
      where: {
        companyId: input.companyId,
        firstName: { equals: input.firstName },
        lastName: input.lastName ? { equals: input.lastName } : undefined,
      },
    });
    if (sameCompanySameName && normalizeEmail(sameCompanySameName.email) !== normalizedEmail) {
      possibleDuplicate = true;
      matchReason = `Same company + same name as contact ${sameCompanySameName.id} but a different/missing email - flagged as a possible duplicate, not auto-merged.`;
    }
  }

  const created = await prisma.contact.create({
    data: {
      firstName: input.firstName,
      lastName: input.lastName ?? null,
      email: input.email ?? null,
      normalizedEmail,
      companyId: input.companyId ?? null,
      possibleDuplicate,
    },
  });
  return { record: created, isNew: true, possibleDuplicate, matchReason };
}

export interface ContactPhoneDedupInput {
  firstName: string;
  lastName?: string | null;
  rawPhone: string;
  companyId?: string | null;
}

export type ContactPhoneResolution =
  | { outcome: "RESOLVED"; record: { id: string; firstName: string; lastName: string | null; normalizedPhone: string | null; possibleDuplicate: boolean }; isNew: boolean; matchReason: string }
  | { outcome: "UNRESOLVED"; reason: string };

/**
 * Finds-or-creates a Contact by normalized phone number (Phase 8, items 7-9)
 * - the WhatsApp analogue of findOrCreateContact()'s email-based matching.
 * Exact match key: normalizedPhone (E.164-style, via normalizePhone() above).
 * A phone number that fails to normalize with confidence returns
 * `{ outcome: "UNRESOLVED" }` rather than creating/attaching a contact under
 * a guessed identity - the caller (core/whatsapp/conversation.ts) is
 * responsible for routing this to a human-review state, never silently
 * dropping or mis-attaching the message. This function NEVER merges two
 * DIFFERENT normalized numbers into one contact - only an exact normalized-
 * phone match is ever treated as "the same person."
 */
export async function findOrCreateContactByPhone(input: ContactPhoneDedupInput): Promise<ContactPhoneResolution> {
  const { normalized, valid, reason } = normalizePhone(input.rawPhone);
  if (!valid || !normalized) {
    return { outcome: "UNRESOLVED", reason: `Phone number could not be reliably normalized: ${reason}` };
  }

  const existing = await prisma.contact.findFirst({ where: { normalizedPhone: normalized } });
  if (existing) {
    return {
      outcome: "RESOLVED",
      record: existing,
      isNew: false,
      matchReason: `Matched existing contact by normalized phone "${normalized}".`,
    };
  }

  const created = await prisma.contact.create({
    data: {
      firstName: input.firstName,
      lastName: input.lastName ?? null,
      phone: input.rawPhone,
      normalizedPhone: normalized,
      companyId: input.companyId ?? null,
    },
  });
  return { outcome: "RESOLVED", record: created, isNew: true, matchReason: `No existing match for normalized phone "${normalized}"; created new contact.` };
}

export interface LeadDedupInput {
  companyId?: string | null;
  contactId?: string | null;
  source?: string | null;
}

/**
 * Finds-or-creates a Lead for a (companyId, contactId) pair. An OPEN lead
 * (status not WON/LOST) already existing for the exact same company+contact
 * is treated as "the same lead" (returned as-is, never duplicated - a
 * prospect re-appearing in research/an inbound email should update the
 * existing pipeline entry, not fork a second one). A lead existing for the
 * same company but a DIFFERENT contact is flagged `possibleDuplicate` on the
 * new lead (a second real contact at the same company is legitimate, but
 * worth a human glance).
 */
export async function findOrCreateLead(input: LeadDedupInput): Promise<DedupOutcome<{ id: string; status: string; possibleDuplicate: boolean }>> {
  if (input.companyId && input.contactId) {
    const existingSame = await prisma.lead.findFirst({
      where: { companyId: input.companyId, contactId: input.contactId, status: { notIn: ["WON", "LOST"] } },
    });
    if (existingSame) {
      return { record: existingSame, isNew: false, possibleDuplicate: existingSame.possibleDuplicate, matchReason: "Matched existing open lead for the same company + contact." };
    }
  }

  let possibleDuplicate = false;
  let matchReason = "No existing match; created new lead.";
  if (input.companyId) {
    const otherOpenForCompany = await prisma.lead.findFirst({
      where: { companyId: input.companyId, status: { notIn: ["WON", "LOST"] } },
    });
    if (otherOpenForCompany) {
      possibleDuplicate = true;
      matchReason = `Another open lead (${otherOpenForCompany.id}) already exists for this company with a different contact - flagged for review.`;
    }
  }

  const created = await prisma.lead.create({
    data: { companyId: input.companyId ?? null, contactId: input.contactId ?? null, source: input.source ?? null, possibleDuplicate },
  });
  return { record: created, isNew: true, possibleDuplicate, matchReason };
}
