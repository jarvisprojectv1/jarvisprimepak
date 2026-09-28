// core/approvals - the Owner Approval Queue (Phase 7, item 26).
//
// A HIGH-RISK outbound action (see core/business/outboundPolicy.ts) creates
// a PENDING ApprovalRequest here instead of executing. approve()/reject() are
// the ONLY ways a request leaves PENDING (besides expire()). Approving NEVER
// mutates `proposedContent` - it is set once at creation and is immutable
// from then on; if an owner wants to change the content, that is a NEW
// ApprovalRequest (created by the caller with the edited content), never an
// in-place edit of this one's audit trail. Every decision is written to the
// real audit log (security/audit.ts), same as every other authenticated
// write in this codebase - not a parallel, undocumented log.
import { prisma } from "../../database/client";
import { notificationService } from "../notifications";
import { writeAuditLog } from "../../security/audit";
import { log } from "../../security/logger";

export type ApprovalStatus = "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED";

export interface CreateApprovalInput {
  action: string;
  reason: string;
  target: string;
  proposedContent: Record<string, unknown>;
  supportingContext?: Record<string, unknown>;
  riskClassification: string;
  taskId?: string | null;
  idempotencyKey?: string | null;
  createdBy: string;
  expiresInHours?: number;
}

export interface ApprovalRecord {
  id: string;
  action: string;
  reason: string;
  target: string;
  proposedContent: Record<string, unknown>;
  supportingContext: Record<string, unknown> | null;
  riskClassification: string;
  taskId: string | null;
  idempotencyKey: string | null;
  status: ApprovalStatus;
  createdBy: string;
  decidedBy: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function toRecord(row: {
  id: string;
  action: string;
  reason: string;
  target: string;
  proposedContent: string;
  supportingContext: string | null;
  riskClassification: string;
  taskId: string | null;
  idempotencyKey: string | null;
  status: string;
  createdBy: string;
  decidedBy: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): ApprovalRecord {
  return {
    ...row,
    status: row.status as ApprovalStatus,
    proposedContent: JSON.parse(row.proposedContent),
    supportingContext: row.supportingContext ? JSON.parse(row.supportingContext) : null,
  };
}

/** Creates a new PENDING approval request, or returns the existing one for the same idempotencyKey (never creates a duplicate queue entry for the same attempted action). */
export async function createApprovalRequest(input: CreateApprovalInput): Promise<ApprovalRecord> {
  if (input.idempotencyKey) {
    const existing = await prisma.approvalRequest.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (existing) return toRecord(existing);
  }
  const expiresAt = input.expiresInHours ? new Date(Date.now() + input.expiresInHours * 60 * 60 * 1000) : null;
  const row = await prisma.approvalRequest.create({
    data: {
      action: input.action,
      reason: input.reason,
      target: input.target,
      proposedContent: JSON.stringify(input.proposedContent),
      supportingContext: input.supportingContext ? JSON.stringify(input.supportingContext) : null,
      riskClassification: input.riskClassification,
      taskId: input.taskId ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      createdBy: input.createdBy,
      expiresAt,
    },
  });
  await notificationService.create({
    title: `Approval required: ${input.action}`,
    body: `${input.reason} (target: ${input.target})`,
    type: "ACTION_REQUIRED",
  });
  log("BUSINESS", "approvals.created", { id: row.id, action: input.action, riskClassification: input.riskClassification });
  return toRecord(row);
}

export async function getApprovalRequest(id: string): Promise<ApprovalRecord | null> {
  const row = await prisma.approvalRequest.findUnique({ where: { id } });
  return row ? toRecord(row) : null;
}

export async function listApprovalRequests(status?: ApprovalStatus): Promise<ApprovalRecord[]> {
  const rows = await prisma.approvalRequest.findMany({ where: status ? { status } : undefined, orderBy: { createdAt: "desc" } });
  return rows.map(toRecord);
}

async function decide(id: string, status: "APPROVED" | "REJECTED", decidedBy: string, note?: string): Promise<ApprovalRecord> {
  const existing = await prisma.approvalRequest.findUniqueOrThrow({ where: { id } });
  if (existing.status !== "PENDING") {
    throw new Error(`Approval request ${id} is already ${existing.status}; cannot decide again.`);
  }
  if (existing.expiresAt && existing.expiresAt.getTime() < Date.now()) {
    const expired = await prisma.approvalRequest.update({ where: { id }, data: { status: "EXPIRED" } });
    throw Object.assign(new Error(`Approval request ${id} has expired.`), { record: toRecord(expired) });
  }
  // proposedContent is NEVER touched here - only status/decidedBy/decidedAt/decisionNote change.
  const row = await prisma.approvalRequest.update({
    where: { id },
    data: { status, decidedBy, decidedAt: new Date(), decisionNote: note ?? null },
  });
  await writeAuditLog({
    actor: decidedBy,
    action: `approval.${status.toLowerCase()}`,
    target: id,
    meta: { approvalAction: existing.action, target: existing.target, riskClassification: existing.riskClassification, success: true },
  });
  log("BUSINESS", `approvals.${status.toLowerCase()}`, { id, decidedBy });
  return toRecord(row);
}

export async function approveRequest(id: string, decidedBy: string, note?: string): Promise<ApprovalRecord> {
  return decide(id, "APPROVED", decidedBy, note);
}

export async function rejectRequest(id: string, decidedBy: string, note?: string): Promise<ApprovalRecord> {
  return decide(id, "REJECTED", decidedBy, note);
}

/** Marks every PENDING request past its expiresAt as EXPIRED. Called by the scheduler/daily report, never blocks a decision path. */
export async function expireOverdueRequests(): Promise<number> {
  const result = await prisma.approvalRequest.updateMany({
    where: { status: "PENDING", expiresAt: { lt: new Date() } },
    data: { status: "EXPIRED" },
  });
  return result.count;
}
