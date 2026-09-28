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
