// core/business/quote.ts - Quote preparation (Phase 7, item 21). NO
// autonomous financial commitment, ever: prepareQuote() only ever produces a
// DRAFT (or REQUIRES_APPROVAL once a real total is computed) row. Sending or
// finalizing a quote is a HIGH-RISK outbound action per
// core/business/outboundPolicy.ts and always goes through the Approval
// Queue (core/approvals) - see markQuoteSent() below, the ONLY function in
// this codebase that may set Quote.status to "SENT", and it REQUIRES an
// approved ApprovalRequest id to do so.
import { prisma } from "../../database/client";
import { getProductCategory } from "../crm/businessConfig";
import { getApprovalRequest } from "../approvals";

export interface QuoteLineItemInput {
  productCategoryName: string;
  quantity: number;
  unit?: string;
  notes?: string;
}

export interface PrepareQuoteInput {
  clientId?: string;
  companyId?: string;
  leadId?: string;
  lineItems: QuoteLineItemInput[];
}

export interface PreparedQuote {
  id: string;
  status: string;
  total: number | null;
  totalIsComputed: boolean;
  lineItems: Array<QuoteLineItemInput & { computedLineTotal: number | null; note?: string }>;
}

/**
 * Prepares a quote: collects specs, computes a total ONLY from configured
 * ProductCategory.costingRules - never a made-up price. If ANY line item's
 * category has no configured costing rules, the whole quote's total stays
 * null/uncomputed and is explicitly flagged as needing owner input, rather
 * than silently pricing only part of it.
 */
export async function prepareQuote(input: PrepareQuoteInput): Promise<PreparedQuote> {
  const enrichedLineItems: PreparedQuote["lineItems"] = [];
  let total = 0;
  let allComputed = input.lineItems.length > 0;

  for (const item of input.lineItems) {
    const category = await getProductCategory(item.productCategoryName);
    if (category?.costingRules) {
      const lineTotal = category.costingRules.baseUnitCost * item.quantity;
      total += lineTotal;
      enrichedLineItems.push({ ...item, computedLineTotal: lineTotal });
    } else {
      allComputed = false;
      enrichedLineItems.push({ ...item, computedLineTotal: null, note: "No configured costing rule for this product category - owner input required." });
    }
  }

  const totalIsComputed = allComputed;
  const row = await prisma.quote.create({
    data: {
      clientId: input.clientId ?? null,
      companyId: input.companyId ?? null,
      leadId: input.leadId ?? null,
      status: "DRAFT",
      total: totalIsComputed ? total : null,
      totalIsComputed,
      lineItems: JSON.stringify(enrichedLineItems),
    },
  });

  return { id: row.id, status: row.status, total: row.total, totalIsComputed: row.totalIsComputed, lineItems: enrichedLineItems };
}

/**
 * Moves a DRAFT quote to REQUIRES_APPROVAL - still not sent, just marked
 * ready for an owner to review before it can ever be sent.
 */
export async function markQuoteReadyForApproval(quoteId: string): Promise<void> {
  const quote = await prisma.quote.findUniqueOrThrow({ where: { id: quoteId } });
  if (quote.status !== "DRAFT") {
    throw new Error(`Quote ${quoteId} is not DRAFT (currently ${quote.status}); cannot mark ready for approval.`);
  }
  await prisma.quote.update({ where: { id: quoteId }, data: { status: "REQUIRES_APPROVAL" } });
}

/**
 * The ONLY function in this codebase that may set Quote.status to "SENT".
 * REQUIRES an already-APPROVED ApprovalRequest id - fails closed on every
 * other state (PENDING/REJECTED/EXPIRED/missing). See
 * core/business/quote.test.ts's "no autonomous send" architectural proof.
 */
export async function markQuoteSent(quoteId: string, approvalRequestId: string): Promise<void> {
  const approval = await getApprovalRequest(approvalRequestId);
  if (!approval || approval.status !== "APPROVED") {
    throw new Error(`Quote ${quoteId} cannot be marked SENT: approval request ${approvalRequestId} is not APPROVED.`);
  }
  const quote = await prisma.quote.findUniqueOrThrow({ where: { id: quoteId } });
  if (quote.status !== "REQUIRES_APPROVAL") {
    throw new Error(`Quote ${quoteId} is not REQUIRES_APPROVAL (currently ${quote.status}); cannot send.`);
  }
  await prisma.quote.update({
    where: { id: quoteId },
    data: { status: "SENT", approvalRequestId, sentAt: new Date() },
  });
}
