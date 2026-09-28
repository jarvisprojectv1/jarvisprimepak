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

/**
 * Phase 8 (item 23): the channel-generalized idempotency key, used ONLY by
 * tools/whatsapp/whatsappTool.ts. computeIdempotencyKey() above is left
 * completely UNTOUCHED and is still what tools/email/emailTool.ts calls -
 * this is a new, additive function, not a modification of the email key
 * shape (so no existing email idempotency key changes). `channel` is folded
 * into the hash basis so an email send and a WhatsApp send to the "same"
 * recipient/content can never collide on the same OutboundSendLog row. Both
 * functions feed the SAME reserveIdempotencyKey()/recordSendAttempt()
 * mechanism below - not a second, divergent idempotency system.
 */
export function computeChannelIdempotencyKey(parts: {
  channel?: "EMAIL" | "WHATSAPP" | "VOICE";
  taskId?: string | null;
  recipient?: string | null;
  subject?: string;
  body: string;
}): string {
  const channel = parts.channel ?? "EMAIL";
  const basis = `${channel}|${parts.taskId ?? ""}|${parts.recipient ?? ""}|${contentHash(parts.subject ?? "", parts.body)}`;
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

export interface ReservationResult {
  reserved: boolean;
  existing?: { id: string; status: string; providerMessageId: string | null };
}

/**
 * Phase 7.1 hardening (item 7): atomically reserves an idempotency key
 * BEFORE the real provider is ever called, closing a true-concurrency race
 * that checkIdempotency()'s plain read cannot: two concurrent send attempts
 * with the identical idempotencyKey (e.g. two worker slots racing the same
 * task, or a genuinely simultaneous retry) both pass checkIdempotency()'s
 * read (neither has sent yet), but only ONE of them can win this INSERT -
 * OutboundSendLog.idempotencyKey's DB unique constraint makes the second
 * caller's create() fail, not "unlikely to conflict." The loser never calls
 * the provider; it reports the winner's outcome instead (recordSendAttempt()
 * below then updates the winning row to SENT once the real send completes).
 */
export async function reserveIdempotencyKey(input: {
  idempotencyKey: string;
  taskId?: string | null;
  contactId?: string | null;
  channel?: "EMAIL" | "WHATSAPP" | "VOICE";
}): Promise<ReservationResult> {
  try {
    await prisma.outboundSendLog.create({
      data: {
        idempotencyKey: input.idempotencyKey,
        taskId: input.taskId ?? null,
        contactId: input.contactId ?? null,
        channel: input.channel ?? "EMAIL",
        status: "SENDING",
      },
    });
    return { reserved: true };
  } catch {
    // Unique constraint violation: a row for this key already exists. If it
    // is in a RETRYABLE terminal state (FAILED/BLOCKED - a prior attempt
    // that never actually reached "sent"), claim it for this retry via a
    // conditional update (still DB-atomic: only one concurrent caller's
    // updateMany can match+flip a given row). If it is SENDING (another
    // attempt is in flight right now) or SENT (already delivered), this
    // caller does not win the reservation.
    const claim = await prisma.outboundSendLog.updateMany({
      where: { idempotencyKey: input.idempotencyKey, status: { in: ["FAILED", "BLOCKED"] } },
      data: { status: "SENDING" },
    });
    if (claim.count === 1) return { reserved: true };

    const existing = await prisma.outboundSendLog.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    return {
      reserved: false,
      existing: existing ? { id: existing.id, status: existing.status, providerMessageId: existing.providerMessageId } : undefined,
    };
  }
}

/** Records the outcome of a send attempt. A duplicate key with status SENT is left as-is (never overwritten to a later, possibly-forged outcome). */
export async function recordSendAttempt(input: {
  idempotencyKey: string;
  taskId?: string | null;
  contactId?: string | null;
  emailId?: string | null;
  status: "SENT" | "FAILED" | "BLOCKED";
  providerMessageId?: string | null;
  channel?: "EMAIL" | "WHATSAPP" | "VOICE";
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
      channel: input.channel ?? "EMAIL",
    },
  });
}
