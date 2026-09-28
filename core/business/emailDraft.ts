// core/business/emailDraft.ts - email draft generation (Phase 7, item 15).
//
// DESIGN CHOICE: this is a deterministic, TEMPLATE-based generator, not an
// LLM call. A drafting function that assembles CRM context + configured
// business data (core/crm/businessConfig.ts) + conversation history and
// fills a template can satisfy "never invent unknown prices/certifications/
// capabilities" by construction - every fact it inserts is read directly
// from a configured data row; there is no generative step that could
// hallucinate one. Any fact the caller didn't supply becomes an explicit
// placeholder, never a fabricated value. An LLM-assisted variant (following
// the EXACT trust-boundary/grounding pattern of core/research/synthesis.ts)
// is a natural future extension - deliberately out of scope here (see
// docs/PHASE7_EMAIL_CRM.md "Deviations") because a template can already meet
// every hard safety requirement this item states, with strictly less risk.
//
// validateDraftGrounding() is a SEPARATE, general-purpose check usable
// against ANY draft text (template-generated here, or a future LLM-assisted
// one) - it flags any price-like/certification-like token that doesn't trace
// back to the supplied `allowedFacts`, per the hallucination-rejection test
// (item N).
import type { ProductCategoryData } from "../crm/businessConfig";

export interface DraftContext {
  contactFirstName?: string | null;
  companyName?: string | null;
  productCategory?: ProductCategoryData | null;
  /** Free-text conversation history snippets (already summarized, never raw untrusted email text without trustBoundary wrapping upstream). */
  conversationHistory?: string[];
  /** The customer's classified intent, to pick a template. */
  category: "NEW_INQUIRY" | "PRICING_REQUEST" | "SAMPLE_REQUEST" | "ORDER_FOLLOW_UP" | "GENERAL_REPLY";
}

export interface DraftResult {
  subject: string;
  body: string;
  /** Every concrete fact (price/certification/capability-shaped string) actually inserted into `body`, for grounding validation. */
  citedFacts: string[];
  placeholders: string[];
}

const PLACEHOLDER_PRICE = "[PRICE TO BE CONFIRMED]";
const PLACEHOLDER_CERT = "[CERTIFICATION TO BE CONFIRMED]";
const PLACEHOLDER_LEAD_TIME = "[PRODUCTION TIME TO BE CONFIRMED]";

export function generateDraft(ctx: DraftContext): DraftResult {
  const greetingName = ctx.contactFirstName ?? "there";
  const company = ctx.companyName ? ` at ${ctx.companyName}` : "";
  const citedFacts: string[] = [];
  const placeholders: string[] = [];

  const productLine = ctx.productCategory?.description ?? null;
  if (productLine) citedFacts.push(productLine);
  const productPositioning = ctx.productCategory?.positioning ?? null;
  if (productPositioning) citedFacts.push(productPositioning);

  const certsLine = ctx.productCategory?.certifications?.length
    ? (() => {
        citedFacts.push(...ctx.productCategory!.certifications);
        return ctx.productCategory!.certifications.join(", ");
      })()
    : (() => {
        placeholders.push(PLACEHOLDER_CERT);
        return PLACEHOLDER_CERT;
      })();

  const priceLine = ctx.productCategory?.costingRules
    ? (() => {
        const fact = `${ctx.productCategory!.costingRules!.currency} ${ctx.productCategory!.costingRules!.baseUnitCost} per ${ctx.productCategory!.costingRules!.unit}`;
        citedFacts.push(fact);
        return fact;
      })()
    : (() => {
        placeholders.push(PLACEHOLDER_PRICE);
        return PLACEHOLDER_PRICE;
      })();

  const leadTimeLine = ctx.productCategory?.productionTimeNotes
    ? (() => {
        citedFacts.push(ctx.productCategory!.productionTimeNotes!);
        return ctx.productCategory!.productionTimeNotes!;
      })()
    : (() => {
        placeholders.push(PLACEHOLDER_LEAD_TIME);
        return PLACEHOLDER_LEAD_TIME;
      })();

  let subject: string;
  let bodyLines: string[];

  switch (ctx.category) {
    case "PRICING_REQUEST":
      subject = `Pricing information${ctx.companyName ? ` for ${ctx.companyName}` : ""}`;
      bodyLines = [
        `Hi ${greetingName},`,
        "",
        `Thank you for your interest in our packaging solutions${company}.`,
        productLine ? `Our relevant product line: ${productLine}.` : "",
        `Indicative pricing: ${priceLine}.`,
        `Certifications: ${certsLine}.`,
        `Typical production time: ${leadTimeLine}.`,
        "",
        "Could you share your target quantity and specifications so we can prepare a precise quotation?",
        "",
        "Best regards,",
        "Prime Pak Packages",
      ];
      break;
    case "SAMPLE_REQUEST":
      subject = "Sample request received";
      bodyLines = [
        `Hi ${greetingName},`,
        "",
        `Thanks for requesting a sample${company}. We've logged your request and will follow up with next steps shortly.`,
        productLine ? `Product line: ${productLine}.` : "",
        "",
        "Best regards,",
        "Prime Pak Packages",
      ];
      break;
    case "ORDER_FOLLOW_UP":
      subject = "Regarding your order";
      bodyLines = [
        `Hi ${greetingName},`,
        "",
        "Thanks for following up. We're checking on your order status and will get back to you shortly with an update.",
        "",
        "Best regards,",
        "Prime Pak Packages",
      ];
      break;
    case "NEW_INQUIRY":
      subject = "Thanks for reaching out to Prime Pak Packages";
      bodyLines = [
        `Hi ${greetingName},`,
        "",
        `Thank you for your interest${company}.`,
        productLine ? `We specialize in: ${productLine}.` : "",
        productPositioning ? productPositioning : "",
        "",
        "Could you tell us more about what you're looking for so we can recommend the right solution?",
        "",
        "Best regards,",
        "Prime Pak Packages",
      ];
      break;
    default:
      subject = "Re: your message";
      bodyLines = [`Hi ${greetingName},`, "", "Thanks for your message - we'll follow up shortly.", "", "Best regards,", "Prime Pak Packages"];
  }

  const body = bodyLines.filter((l) => l !== "").join("\n");
  return { subject, body, citedFacts, placeholders };
}

// ---------------------------------------------------------------------------
// Hallucination-rejection validator (item N). General-purpose: works on any
// draft text, not just this file's own template output.
// ---------------------------------------------------------------------------
const PRICE_PATTERN = /(?:USD|US\$|\$|INR|₹|EUR|€)\s?\d[\d,.]*\s*(?:per\s+\w+)?/gi;
const CERT_PATTERN = /\b(ISO\s?\d{3,5}|FSC(?:\s?certified)?|BRC\s?certified|GOTS\s?certified|OEKO-?TEX)\b/gi;

export interface GroundingCheckResult {
  grounded: boolean;
  ungroundedClaims: string[];
}

/**
 * Scans `draftText` for price-like/certification-like tokens and confirms
 * each one is one of the `allowedFacts` (or a substring of one) - i.e.
 * traceable to configured business data. Anything else is an ungrounded
 * claim and the draft must be flagged/rejected, never silently sent.
 */
export function validateDraftGrounding(draftText: string, allowedFacts: string[]): GroundingCheckResult {
  const ungrounded: string[] = [];
  const isAllowed = (token: string) => allowedFacts.some((fact) => fact.includes(token) || token.includes(fact));

  for (const match of draftText.matchAll(PRICE_PATTERN)) {
    if (!isAllowed(match[0])) ungrounded.push(match[0]);
  }
  for (const match of draftText.matchAll(CERT_PATTERN)) {
    if (!isAllowed(match[0])) ungrounded.push(match[0]);
  }

  return { grounded: ungrounded.length === 0, ungroundedClaims: [...new Set(ungrounded)] };
}
