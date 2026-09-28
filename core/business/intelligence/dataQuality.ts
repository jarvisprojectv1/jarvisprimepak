// core/business/intelligence/dataQuality.ts - Phase 11, sections 42-43: data
// quality engine. Reuses core/crm/dedup.ts's `possibleDuplicate` flag (the
// existing dedup algorithm) rather than building a second dedup pass - this
// module only READS what dedup already flagged, plus checks for missing
// required fields. No new matching/merge logic is introduced here.
import { prisma } from "../../../database/client";
import type { IntelligenceStatement } from "./types";
import { unknownStatement } from "./types";

export interface DataQualityReport {
  duplicateCompanies: number;
  duplicateContacts: number;
  duplicateLeads: number;
  contactsMissingEmailAndPhone: number;
  leadsMissingCompany: number;
  leadsMissingContact: number;
}

/**
 * Reads the `possibleDuplicate` flags core/crm/dedup.ts already maintains
 * (never re-runs matching logic), plus a few simple missing-required-field
 * counts. Every count is a real query, never estimated.
 */
export async function getDataQualityReport(): Promise<IntelligenceStatement<DataQualityReport>> {
  const [duplicateCompanies, duplicateContacts, duplicateLeads, contactsMissingBoth, leadsMissingCompany, leadsMissingContact] = await Promise.all([
    prisma.company.count({ where: { possibleDuplicate: true } }),
    prisma.contact.count({ where: { possibleDuplicate: true } }),
    prisma.lead.count({ where: { possibleDuplicate: true } }),
    prisma.contact.count({ where: { email: null, phone: null } }),
    prisma.lead.count({ where: { companyId: null } }),
    prisma.lead.count({ where: { contactId: null } }),
  ]);

  const report: DataQualityReport = {
    duplicateCompanies,
    duplicateContacts,
    duplicateLeads,
    contactsMissingEmailAndPhone: contactsMissingBoth,
    leadsMissingCompany,
    leadsMissingContact,
  };
  const totalIssues = duplicateCompanies + duplicateContacts + duplicateLeads + contactsMissingBoth + leadsMissingCompany + leadsMissingContact;

  return {
    id: "data_quality.report",
    type: "FACT",
    label: "Data quality report",
    value: report,
    narrative:
      totalIssues === 0
        ? "No data-quality issues currently flagged: no possible-duplicate records, and no contacts/leads missing required identifying fields."
        : `${duplicateCompanies + duplicateContacts + duplicateLeads} record(s) flagged possibleDuplicate (by core/crm/dedup.ts); ${contactsMissingBoth} contact(s) missing both email and phone; ${leadsMissingCompany} lead(s) missing a company; ${leadsMissingContact} lead(s) missing a contact.`,
    provenance: { sourceIds: [], sourceModel: "Company+Contact+Lead", calculationMethod: "COUNT(possibleDuplicate=true) per model + COUNT(missing required field) per model." },
  };
}

export interface DuplicateGroup {
  model: "Company" | "Contact" | "Lead";
  id: string;
  label: string;
}

/** Lists the actual flagged records (not just counts) so a human/report can review them, bounded to avoid an unbounded dump. */
export async function listFlaggedDuplicates(limit = 50): Promise<IntelligenceStatement<DuplicateGroup[]>> {
  const [companies, contacts, leads] = await Promise.all([
    prisma.company.findMany({ where: { possibleDuplicate: true }, take: limit, select: { id: true, name: true } }),
    prisma.contact.findMany({ where: { possibleDuplicate: true }, take: limit, select: { id: true, firstName: true, lastName: true } }),
    prisma.lead.findMany({ where: { possibleDuplicate: true }, take: limit, select: { id: true, status: true } }),
  ]);
  const groups: DuplicateGroup[] = [
    ...companies.map((c) => ({ model: "Company" as const, id: c.id, label: c.name })),
    ...contacts.map((c) => ({ model: "Contact" as const, id: c.id, label: `${c.firstName} ${c.lastName ?? ""}`.trim() })),
    ...leads.map((l) => ({ model: "Lead" as const, id: l.id, label: `Lead (${l.status})` })),
  ];
  if (groups.length === 0) return unknownStatement("data_quality.flagged_list", "Flagged duplicate records", "No records currently flagged possibleDuplicate.");
  return {
    id: "data_quality.flagged_list",
    type: "FACT",
    label: "Flagged duplicate records",
    value: groups,
    narrative: `${groups.length} record(s) currently flagged possibleDuplicate across Company/Contact/Lead.`,
    provenance: { sourceIds: groups.map((g) => g.id), sourceModel: "Company+Contact+Lead", calculationMethod: "SELECT WHERE possibleDuplicate = true, per model, bounded to " + limit + " each." },
  };
}
