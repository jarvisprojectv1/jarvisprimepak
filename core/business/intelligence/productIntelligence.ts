// core/business/intelligence/productIntelligence.ts - Phase 11, sections
// 18-19: product intelligence. Quote.lineItems is free-form JSON with no
// enforced link to ProductCategory (see database/schema.prisma's Quote
// model comment - "kept simple for Phase 1"), so this module is honest about
// what it CAN and CANNOT compute: real quote-volume/status metrics (can),
// per-product-category demand (cannot, without a structured line-item ->
// ProductCategory link that does not exist yet) - returns UNKNOWN rather
// than guessing from unstructured text.
import { prisma } from "../../../database/client";
import { listProductCategories } from "../../crm/businessConfig";
import type { IntelligenceStatement } from "./types";
import { unknownStatement } from "./types";
import type { ResolvedWindow } from "./timeWindows";

export interface QuoteVolume {
  totalQuotes: number;
  byStatus: Record<string, number>;
  computedTotalCount: number; // quotes whose total was actually computed from real costing rules
}

/** Section 18: real quote-volume/status metrics in a window. */
export async function getQuoteVolume(window: ResolvedWindow): Promise<IntelligenceStatement<QuoteVolume>> {
  const quotes = await prisma.quote.findMany({
    where: { createdAt: { gte: window.start, lt: window.end } },
    select: { status: true, totalIsComputed: true },
  });
  if (quotes.length === 0) {
    return unknownStatement("product.quote_volume", `Quote volume (${window.label})`, "No quotes created in this window.");
  }
  const byStatus: Record<string, number> = {};
  let computedTotalCount = 0;
  for (const q of quotes) {
    byStatus[q.status] = (byStatus[q.status] ?? 0) + 1;
    if (q.totalIsComputed) computedTotalCount += 1;
  }
  return {
    id: "product.quote_volume",
    type: "FACT",
    label: `Quote volume (${window.label})`,
    value: { totalQuotes: quotes.length, byStatus, computedTotalCount },
    narrative: `${quotes.length} quote(s) created; ${computedTotalCount} had a total computed from real costing rules (core/crm/businessConfig.ts).`,
    provenance: { sourceIds: [], sourceModel: "Quote", dateRangeStart: window.start.toISOString(), dateRangeEnd: window.end.toISOString(), calculationMethod: "COUNT(Quote) GROUP BY status in window." },
  };
}

/**
 * Section 19: per-product-category demand. Honestly UNKNOWN - Quote has no
 * structured ProductCategory reference, and Quote.lineItems is free-form
 * JSON this module will not attempt to keyword-guess against (that would be
 * exactly the kind of fabrication section 59 forbids). Lists the configured
 * product categories so a caller can see what COULD be tracked once a
 * structured link exists, without claiming any demand numbers for them.
 */
export async function getProductDemand(): Promise<IntelligenceStatement<null>> {
  const categories = await listProductCategories();
  return {
    id: "product.demand_by_category",
    type: "UNKNOWN",
    label: "Product demand by category",
    value: null,
    narrative:
      categories.length > 0
        ? `INSUFFICIENT_DATA: ${categories.length} product categor(y/ies) are configured (${categories.map((c) => c.name).join(", ")}), but Quote records have no structured link to a ProductCategory - per-category demand cannot be computed without fabricating an association.`
        : "INSUFFICIENT_DATA: no product categories are configured, and Quote has no structured product-category link.",
    provenance: { sourceIds: categories.map((c) => c.id), sourceModel: "ProductCategory", calculationMethod: "none - no structured Quote-to-ProductCategory link exists." },
  };
}
