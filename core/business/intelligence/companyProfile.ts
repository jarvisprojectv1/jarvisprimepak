// core/business/intelligence/companyProfile.ts - Phase 11, section 3: Prime
// Pak Packages' own factual profile, as DATA (Setting-backed, same
// discipline core/ai/costControl.ts and core/business/followUp.ts already
// use for config that must be editable without a code deploy), never
// hardcoded business claims scattered through report-generation logic.
//
// CRITICAL, EXPLICIT DISTINCTION (the user was repeated and explicit about
// this - it is a factual-accuracy requirement, not boilerplate):
//   ALLOWED:     "Backed by 25+ years of manufacturing expertise" - this
//                attributes the experience to the PRODUCTION BACKBONE
//                (MM Printing Agency), not to Prime Pak Packages the
//                corporate entity.
//   NOT ALLOWED: "Prime Pak has 25+ years of manufacturing experience" -
//                this falsely ages the corporate entity itself.
// `manufacturingExpertiseStatement` below is the ONLY place this fact is
// phrased; every report/briefing that needs to mention it MUST call
// getCompanyProfile() and use this exact string, never re-word it inline.
// `DISALLOWED_PHRASES` + `assertNoDisallowedClaims()` are the mechanical,
// tested guard (see companyProfile.test.ts) - reused by every BI text
// generator (executiveBriefing.ts, synthesis.ts) before any text is ever
// returned to a caller.
import { prisma } from "../../../database/client";

export interface CompanyProfile {
  legalName: string;
  tradingAs: string;
  productionBackbone: string;
  industry: string;
  productLines: string[];
  /** The one allowed phrasing of the 25+ years claim - see file header. */
  manufacturingExpertiseStatement: string;
  /** Facts NOT verified in this system - never invented, always explicit UNKNOWN/INSUFFICIENT_DATA when asked about. */
  unverifiedCategories: string[];
}

const SETTINGS_KEY = "business.company_profile";

export const DEFAULT_COMPANY_PROFILE: CompanyProfile = {
  legalName: "Prime Pak Packages (SMC-Pvt.) Limited",
  tradingAs: "Prime Pak Packages",
  productionBackbone: "MM Printing Agency",
  industry: "Apparel packaging, garment trims, and packaging accessories",
  productLines: [
    "Hang tags",
    "Woven labels",
    "Satin labels",
    "Leather patches",
    "Jacron patches",
    "Medicine boxes",
    "Packing cartons",
    "Food boxes",
    "Poly bags",
    "Packaging accessories",
  ],
  manufacturingExpertiseStatement:
    "Backed by 25+ years of manufacturing expertise (via its production backbone, MM Printing Agency).",
  unverifiedCategories: [
    "certifications",
    "named customers",
    "revenue",
    "margins",
    "production capacity",
    "pricing",
    "delivery-time guarantees",
    "number of factories/offices",
    "employee count",
    "awards",
  ],
};

/**
 * The exact disallowed phrasing pattern (case-insensitive): any statement
 * that ages PRIME PAK ITSELF (rather than its production backbone) with the
 * "25+ years" claim. Deliberately narrow and mechanical - a grep-style
 * check, not a semantic judgment - so it is trivially testable and cannot
 * silently pass a rephrased version of the same false claim.
 */
export const DISALLOWED_PHRASES: RegExp[] = [
  /prime\s*pak[^.]{0,60}\b(has|with|possess(?:es)?|boast(?:s|ing)?)\b[^.]{0,40}\b25\+?\s*years?\b/i,
  /prime\s*pak[^.]{0,80}\b25\+?\s*years?\s+of\s+manufacturing\s+experience\b/i,
];

export interface DisallowedClaimCheck {
  ok: boolean;
  violations: string[];
}

/** Scans arbitrary generated text for the disallowed "Prime Pak itself has 25+ years" phrasing. Never mutates the text - callers decide what to do (reject/log). */
export function checkForDisallowedClaims(text: string): DisallowedClaimCheck {
  const violations: string[] = [];
  for (const pattern of DISALLOWED_PHRASES) {
    const match = text.match(pattern);
    if (match) violations.push(match[0]);
  }
  return { ok: violations.length === 0, violations };
}

export async function getCompanyProfile(): Promise<CompanyProfile> {
  const row = await prisma.setting.findUnique({ where: { key: SETTINGS_KEY } });
  if (!row) return { ...DEFAULT_COMPANY_PROFILE };
  try {
    const parsed = JSON.parse(row.value) as Partial<CompanyProfile>;
    return { ...DEFAULT_COMPANY_PROFILE, ...parsed };
  } catch {
    return { ...DEFAULT_COMPANY_PROFILE };
  }
}

/** Idempotent seed, same pattern as core/crm/businessConfig.ts's seedDefaultProductCategories(). */
export async function seedCompanyProfile(): Promise<void> {
  const existing = await prisma.setting.findUnique({ where: { key: SETTINGS_KEY } });
  if (existing) return;
  await prisma.setting.create({ data: { key: SETTINGS_KEY, value: JSON.stringify(DEFAULT_COMPANY_PROFILE) } });
}
