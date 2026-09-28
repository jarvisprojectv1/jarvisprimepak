// core/business/idempotency.ts - outbound send idempotency (Phase 7, item
// 18). Every outbound send attempt carries a key derived from
// hash(taskId + contentHash) (or, with no taskId, contactId + contentHash) -
// checked against the OutboundSendLog table's unique constraint BEFORE the
// real provider is ever called. A retried task therefore cannot double-send:
// the second attempt finds the first attempt's log row and short-circuits.
import crypto from "node:crypto";
import { prisma } from "../../database/client";

export function contentHash(subject: string, body: string): string {
  return crypto.createHash("sha256").update(`${subject}\n${body}`).digest("hex");
}

export function computeIdempotencyKey(parts: { taskId?: string | null; contactEmail?: string | null; subject: string; body: string }): string {
  const basis = `${parts.taskId ?? ""}|${parts.contactEmail ?? ""}|${contentHash(parts.subject, parts.body)}`;
  return crypto.createHash("sha256").update(basis).digest("hex");
}

export interface IdempotencyCheck {
  alreadySent: boolean;
  existing?: { id: string; status: string; providerMessageId: string | null };
}

/** Checks whether a send with this idempotency key has already been attempted (and, if so, with what outcome). */
export async function checkIdempotency(idempotencyKey: string): Promise<IdempotencyCheck> {
  const existing = await prisma.outboundSendLog.findUnique({ where: { idempotencyKey } });
  if (!existing) return { alreadySent: false };
  return { alreadySent: existing.status === "SENT", existing: { id: existing.id, status: existing.status, providerMessageId: existing.providerMessageId } };
}

/** Records the outcome of a send attempt. A duplicate key with status SENT is left as-is (never overwritten to a later, possibly-forged outcome). */
export async function recordSendAttempt(input: {
  idempotencyKey: string;
  taskId?: string | null;
  contactId?: string | null;
  emailId?: string | null;
  status: "SENT" | "FAILED" | "BLOCKED";
  providerMessageId?: string | null;
}) {
  const existing = await prisma.outboundSendLog.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (existing && existing.status === "SENT") return existing; // never re-write a confirmed send
  if (existing) {
    return prisma.outboundSendLog.update({
      where: { idempotencyKey: input.idempotencyKey },
      data: { status: input.status, providerMessageId: input.providerMessageId ?? null },
    });
  }
  return prisma.outboundSendLog.create({
    data: {
      idempotencyKey: input.idempotencyKey,
      taskId: input.taskId ?? null,
      contactId: input.contactId ?? null,
      emailId: input.emailId ?? null,
      status: input.status,
      providerMessageId: input.providerMessageId ?? null,
    },
  });
}
