// core/approvals/approvals.test.ts - items Q (approval queue) and R (audit trail).
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../../database/client";
import { createApprovalRequest, approveRequest, rejectRequest, revokeRequest, listApprovalRequests } from "./index";

beforeEach(async () => {
  await prisma.auditLog.deleteMany();
  await prisma.approvalRequest.deleteMany();
});

describe("Q: approval queue", () => {
  it("creates a PENDING request and lists it", async () => {
    const req = await createApprovalRequest({
      action: "email.send",
      reason: "HIGH-RISK pricing content",
      target: "buyer@brand.example",
      proposedContent: { subject: "Quote", body: "Our price is $500." },
      riskClassification: "HIGH",
      createdBy: "system:test",
    });
    expect(req.status).toBe("PENDING");
    const pending = await listApprovalRequests("PENDING");
    expect(pending.some((p) => p.id === req.id)).toBe(true);
  });

  it("approve() transitions PENDING -> APPROVED and cannot be decided twice", async () => {
    const req = await createApprovalRequest({
      action: "email.send",
      reason: "test",
      target: "x@example.com",
      proposedContent: { subject: "s", body: "b" },
      riskClassification: "HIGH",
      createdBy: "system:test",
    });
    const approved = await approveRequest(req.id, "owner:jane@example.com", "looks fine");
    expect(approved.status).toBe("APPROVED");
    expect(approved.decidedBy).toBe("owner:jane@example.com");
    await expect(approveRequest(req.id, "owner:jane@example.com")).rejects.toThrow();
  });

  it("reject() transitions PENDING -> REJECTED", async () => {
    const req = await createApprovalRequest({
      action: "email.send",
      reason: "test",
      target: "x@example.com",
      proposedContent: { subject: "s", body: "b" },
      riskClassification: "HIGH",
      createdBy: "system:test",
    });
    const rejected = await rejectRequest(req.id, "owner:jane@example.com", "too risky");
    expect(rejected.status).toBe("REJECTED");
  });

  it("approving NEVER mutates proposedContent - it stays exactly as created", async () => {
    const original = { subject: "Quote", body: "Our price is $500 per unit." };
    const req = await createApprovalRequest({
      action: "email.send",
      reason: "test",
      target: "x@example.com",
      proposedContent: original,
      riskClassification: "HIGH",
      createdBy: "system:test",
    });
    await approveRequest(req.id, "owner:jane@example.com");
    const row = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(JSON.parse(row.proposedContent)).toEqual(original);
  });

  it("reuses the existing PENDING request for the same idempotencyKey instead of creating a duplicate queue entry", async () => {
    const input = {
      action: "email.send",
      reason: "test",
      target: "x@example.com",
      proposedContent: { subject: "s", body: "b" },
      riskClassification: "HIGH",
      createdBy: "system:test",
      idempotencyKey: "key-1",
    };
    const first = await createApprovalRequest(input);
    const second = await createApprovalRequest(input);
    expect(second.id).toBe(first.id);
    const count = await prisma.approvalRequest.count();
    expect(count).toBe(1);
  });
});

describe("Phase 7.1 item 6: revoke lifecycle", () => {
  it("revokeRequest() transitions APPROVED -> REVOKED and is audited", async () => {
    const req = await createApprovalRequest({
      action: "email.send",
      reason: "test",
      target: "x@example.com",
      proposedContent: { subject: "s", body: "b" },
      riskClassification: "HIGH",
      createdBy: "system:test",
    });
    await approveRequest(req.id, "owner:jane@example.com");
    const revoked = await revokeRequest(req.id, "owner:jane@example.com", "circumstances changed");
    expect(revoked.status).toBe("REVOKED");
    const entries = await prisma.auditLog.findMany({ where: { target: req.id, action: "approval.revoked" } });
    expect(entries.length).toBe(1);
  });

  it("cannot revoke a request that is not APPROVED (e.g. still PENDING)", async () => {
    const req = await createApprovalRequest({
      action: "email.send",
      reason: "test",
      target: "x@example.com",
      proposedContent: { subject: "s", body: "b" },
      riskClassification: "HIGH",
      createdBy: "system:test",
    });
    await expect(revokeRequest(req.id, "owner:jane@example.com")).rejects.toThrow();
  });

  it("a REVOKED approval is treated as not-approved (status check fails closed)", async () => {
    const req = await createApprovalRequest({
      action: "email.send",
      reason: "test",
      target: "x@example.com",
      proposedContent: { subject: "s", body: "b" },
      riskClassification: "HIGH",
      createdBy: "system:test",
    });
    await approveRequest(req.id, "owner:jane@example.com");
    const revoked = await revokeRequest(req.id, "owner:jane@example.com");
    expect(revoked.status).not.toBe("APPROVED");
  });
});

describe("R: approval audit trail", () => {
  it("writes a real AuditLog entry for approve/reject, naming the actor and decision", async () => {
    const req = await createApprovalRequest({
      action: "email.send",
      reason: "test",
      target: "x@example.com",
      proposedContent: { subject: "s", body: "b" },
      riskClassification: "HIGH",
      createdBy: "system:test",
    });
    await approveRequest(req.id, "owner:jane@example.com", "ok");
    const entries = await prisma.auditLog.findMany({ where: { target: req.id } });
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0].actor).toBe("owner:jane@example.com");
    expect(entries[0].action).toBe("approval.approved");
  });

  it("never records the decidedBy actor as an unauthenticated/blank string", async () => {
    const req = await createApprovalRequest({
      action: "email.send",
      reason: "test",
      target: "x@example.com",
      proposedContent: { subject: "s", body: "b" },
      riskClassification: "HIGH",
      createdBy: "system:test",
    });
    await rejectRequest(req.id, "owner:jane@example.com");
    const entries = await prisma.auditLog.findMany({ where: { target: req.id } });
    expect(entries[0].actor).toBeTruthy();
    expect(entries[0].actor).not.toBe("");
  });
});
