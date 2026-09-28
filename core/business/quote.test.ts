// core/business/quote.test.ts - items Z (quote preparation), AA (quote
// cannot autonomously create a financial commitment).
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../../database/client";
import { prepareQuote, markQuoteReadyForApproval, markQuoteSent } from "./quote";
import { upsertProductCategory } from "../crm/businessConfig";
import { createApprovalRequest, approveRequest } from "../approvals";

beforeEach(async () => {
  await prisma.quote.deleteMany();
  await prisma.approvalRequest.deleteMany();
  await prisma.productCategory.deleteMany();
});

describe("Z: quote preparation", () => {
  it("computes a real total ONLY from configured costing rules", async () => {
    await upsertProductCategory({ name: "Corrugated Packaging", costingRules: { unit: "carton", baseUnitCost: 2, currency: "USD" } });
    const quote = await prepareQuote({ lineItems: [{ productCategoryName: "Corrugated Packaging", quantity: 100 }] });
    expect(quote.status).toBe("DRAFT");
    expect(quote.totalIsComputed).toBe(true);
    expect(quote.total).toBe(200);
  });

  it("leaves total null and flags for owner input when no costing rule is configured", async () => {
    const quote = await prepareQuote({ lineItems: [{ productCategoryName: "Unknown Category", quantity: 50 }] });
    expect(quote.total).toBeNull();
    expect(quote.totalIsComputed).toBe(false);
    expect(quote.lineItems[0].note).toMatch(/owner input required/i);
  });

  it("never partially prices a quote - if ANY line item lacks a costing rule, total stays uncomputed", async () => {
    await upsertProductCategory({ name: "Corrugated Packaging", costingRules: { unit: "carton", baseUnitCost: 2, currency: "USD" } });
    const quote = await prepareQuote({
      lineItems: [
        { productCategoryName: "Corrugated Packaging", quantity: 10 },
        { productCategoryName: "Unpriced Category", quantity: 5 },
      ],
    });
    expect(quote.totalIsComputed).toBe(false);
    expect(quote.total).toBeNull();
  });
});

describe("AA: quote cannot autonomously create a financial commitment", () => {
  it("markQuoteSent() REQUIRES an APPROVED ApprovalRequest - fails on a PENDING one", async () => {
    const quote = await prepareQuote({ lineItems: [{ productCategoryName: "X", quantity: 1 }] });
    await markQuoteReadyForApproval(quote.id);
    const approval = await createApprovalRequest({
      action: "quote.send",
      reason: "test",
      target: quote.id,
      proposedContent: { quoteId: quote.id },
      riskClassification: "HIGH",
      createdBy: "system:test",
    });
    await expect(markQuoteSent(quote.id, approval.id)).rejects.toThrow();
    const row = await prisma.quote.findUniqueOrThrow({ where: { id: quote.id } });
    expect(row.status).not.toBe("SENT");
  });

  it("markQuoteSent() succeeds ONLY after the approval is APPROVED", async () => {
    const quote = await prepareQuote({ lineItems: [{ productCategoryName: "X", quantity: 1 }] });
    await markQuoteReadyForApproval(quote.id);
    const approval = await createApprovalRequest({
      action: "quote.send",
      reason: "test",
      target: quote.id,
      proposedContent: { quoteId: quote.id },
      riskClassification: "HIGH",
      createdBy: "system:test",
    });
    await approveRequest(approval.id, "owner:jane@example.com");
    await markQuoteSent(quote.id, approval.id);
    const row = await prisma.quote.findUniqueOrThrow({ where: { id: quote.id } });
    expect(row.status).toBe("SENT");
    expect(row.approvalRequestId).toBe(approval.id);
  });

  it("a DRAFT quote cannot be sent directly (must pass through REQUIRES_APPROVAL first)", async () => {
    const quote = await prepareQuote({ lineItems: [{ productCategoryName: "X", quantity: 1 }] });
    const approval = await createApprovalRequest({
      action: "quote.send",
      reason: "test",
      target: quote.id,
      proposedContent: { quoteId: quote.id },
      riskClassification: "HIGH",
      createdBy: "system:test",
    });
    await approveRequest(approval.id, "owner:jane@example.com");
    await expect(markQuoteSent(quote.id, approval.id)).rejects.toThrow(/REQUIRES_APPROVAL/);
  });

  it("architectural proof: markQuoteSent is the ONLY function in core/business/quote.ts that sets status to SENT", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const source = await fs.readFile(path.join(__dirname, "quote.ts"), "utf-8");
    const sentAssignments = source.match(/status:\s*"SENT"/g) ?? [];
    // Exactly one occurrence, and it must be inside markQuoteSent.
    expect(sentAssignments.length).toBe(1);
    const fnBody = source.slice(source.indexOf("export async function markQuoteSent"));
    expect(fnBody).toContain('status: "SENT"');
  });
});
