// tools/email/emailTool.ts - the `email` Tool (Phase 7, items 1-2, 16-18).
// Action-based (`action` parameter), same house style as tools/files.ts and
// tools/web.ts, replacing the old Phase 1 tools/email.ts stub - the NEW file
// still honestly returns CONFIGURATION_REQUIRED with no provider configured
// (same contract, now backed by a real provider implementation instead of a
// permanent stub).
//
// THE SINGLE MOST SAFETY-CRITICAL FUNCTION IN THIS PHASE: the "send" action
// below is the ONLY place in this entire codebase a real EmailProvider.
// sendMessage() call can happen (per the architecture non-negotiable: "no
// direct fetch/SMTP/IMAP call from anywhere except inside a registered
// Tool's execute()"). Its ordering is fixed and unconditional:
//   1. suppression check (BEFORE risk classification even runs - item 17)
//   2. anti-spam limits (daily/domain/cooldown)
//   3. idempotency check (a matching prior SENT attempt short-circuits here,
//      before risk classification or approval logic run again)
//   4. outbound risk classification (core/business/outboundPolicy.ts)
//   5. HIGH risk + no matching APPROVED ApprovalRequest -> creates one (or
//      reuses the existing PENDING one for this idempotency key) and RETURNS
//      "BLOCKED" - provider.sendMessage() is never reached.
//   6. Only LOW risk, or HIGH risk with a matching APPROVED request, reaches
//      provider.sendMessage().
// See agents/no-autonomous-highrisk-send.test.ts for the architectural proof
// this ordering cannot be bypassed by any caller of this tool.
import type { Tool, ToolResult } from "../registry";
import type { EmailProvider } from "./types";
import { createDefaultEmailProvider } from "./gmailProvider";
import { ingestInboundEmail } from "../../core/email/ingest";
import { isSuppressed } from "../../core/business/antiSpam";
import { checkAntiSpamLimits } from "../../core/business/antiSpam";
import { classifyOutboundEmail } from "../../core/business/outboundPolicy";
import { computeIdempotencyKey, checkIdempotency, recordSendAttempt, reserveIdempotencyKey } from "../../core/business/idempotency";
import { createApprovalRequest, getApprovalRequest } from "../../core/approvals";
import { recordActivity } from "../../core/crm/activity";
import { generateDraft, validateDraftGrounding, type DraftContext } from "../../core/business/emailDraft";
import { getProductCategory } from "../../core/crm/businessConfig";
import { isFollowUpAllowed } from "../../core/business/followUp";
import { prisma } from "../../database/client";
import { log } from "../../security/logger";

export function createEmailTool(provider: EmailProvider = createDefaultEmailProvider()): Tool {
  return {
    name: "email",
    description:
      `Read and send email via ${provider.name}. Actions: 'list' (inbox, ingested idempotently), 'send' (gated by suppression/anti-spam/idempotency/outbound-risk-approval), 'draft' (no send). Returns CONFIGURATION_REQUIRED if no provider credential is set.`,
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "'list' | 'send' | 'draft'" },
        to: { type: "string", description: "Recipient email address (for 'send')" },
        subject: { type: "string" },
        body: { type: "string" },
        taskId: { type: "string", description: "Optional task id, for idempotency-key derivation and audit traceability." },
        contactId: { type: "string" },
        isMassCampaign: { type: "string", description: "'true' if this send targets a batch/campaign." },
        monetaryValue: { type: "string", description: "Explicit monetary value attached to this send, if any." },
        approvalRequestId: { type: "string", description: "An already-APPROVED ApprovalRequest id authorizing a HIGH-RISK send to proceed." },
      },
      required: ["action"],
    },
    async execute(input): Promise<ToolResult> {
      const action = input.action as string | undefined;

      if (!provider.isConfigured()) {
        return {
          status: "CONFIGURATION_REQUIRED",
          message: `CONFIGURATION_REQUIRED: no credentials configured for the "${provider.name}" email provider (see .env.example).`,
        };
      }

      // Phase 7.1 (items 2-3): a follow-up task calls this SAME tool tagged
      // toolName:"email" with no explicit action - core/worker/index.ts
      // passes only {taskId} (the worker never knows about follow-ups).
      // Resolve the FollowUp row by taskId, re-check every cancellation
      // condition against the LATEST CRM state, and only then fall through
      // to the exact same "send" handler below with the content captured at
      // scheduling time - NOT a second sender, no bypass of any check below.
      if (!action && typeof input.taskId === "string") {
        const followUp = await prisma.followUp.findUnique({ where: { taskId: input.taskId } });
        if (followUp) {
          return handleFollowUpDispatch(provider, followUp);
        }
      }

      if (action === "list") {
        const messages = await provider.listMessages({ limit: 20 });
        if ("code" in messages) {
          return { status: messages.code === "CONFIGURATION_REQUIRED" ? "CONFIGURATION_REQUIRED" : "ERROR", message: messages.message };
        }
        const ingested = [];
        for (const msg of messages) {
          ingested.push(await ingestInboundEmail(msg));
        }
        return { status: "OK", message: `Ingested ${ingested.length} message(s).`, data: { ingested } };
      }

      if (action === "send") {
        return handleSend(provider, input);
      }

      if (action === "draft") {
        return handleDraft(input);
      }

      return { status: "ERROR", message: `Unknown action "${action}". Use 'list', 'send', or 'draft'.` };
    },
  };
}

async function handleDraft(input: Record<string, unknown>): Promise<ToolResult> {
  const category = (input.category as DraftContext["category"] | undefined) ?? "GENERAL_REPLY";
  const productCategoryName = typeof input.productCategoryName === "string" ? input.productCategoryName : undefined;
  const productCategory = productCategoryName ? await getProductCategory(productCategoryName) : null;

  const draft = generateDraft({
    contactFirstName: typeof input.contactFirstName === "string" ? input.contactFirstName : null,
    companyName: typeof input.companyName === "string" ? input.companyName : null,
    productCategory,
    category,
  });

  const grounding = validateDraftGrounding(draft.body, draft.citedFacts);
  if (!grounding.grounded) {
    // Never silently send an ungrounded draft - this should not happen given
    // generateDraft() only ever inserts configured facts or placeholders,
    // but the check is defense-in-depth and fails closed if it ever does.
    return {
      status: "ERROR",
      message: `Draft rejected: contains claims not traceable to configured business data: ${grounding.ungroundedClaims.join(", ")}`,
      data: { draft, grounding },
    };
  }

  return { status: "OK", message: "Draft generated.", data: { draft, grounding } };
}

/**
 * Phase 7.1 (items 2-3): the follow-up pre-check + dispatch. Runs BEFORE
 * anything in handleSend() - if any cancellation condition is true, the
 * FollowUp transitions SCHEDULED -> CANCELLED with a clear reason and the
 * real provider is never reached (handleSend() itself is not even called).
 * Otherwise it calls
 * handleSend() with the content captured at scheduling time, then records
 * the outcome back onto the FollowUp row (EXECUTED on a real send;
 * otherwise left SCHEDULED so a legitimate BLOCKED outcome - e.g. a fresh
 * suppression, a new HIGH-risk approval requirement - can still be resolved
 * and retried through the normal task-retry/approval mechanisms rather than
 * being permanently abandoned).
 */
async function handleFollowUpDispatch(
  provider: EmailProvider,
  followUp: { id: string; leadId: string | null; contactId: string | null; subject: string; body: string; createdAt: Date; taskId: string | null }
): Promise<ToolResult> {
  const guard = await isFollowUpAllowed({
    taskId: followUp.taskId ?? "",
    contactId: followUp.contactId,
    leadId: followUp.leadId,
    sinceTaskCreatedAt: followUp.createdAt,
  });

  if (!guard.allowed) {
    await prisma.followUp.update({
      where: { id: followUp.id },
      data: { status: "CANCELLED", cancelReason: guard.reason ?? "Cancellation condition met." },
    });
    log("BUSINESS", "followUp.cancelled", { followUpId: followUp.id, reason: guard.reason });
    return { status: "BLOCKED", message: `Follow-up ${followUp.id} cancelled: ${guard.reason}`, data: { followUpId: followUp.id, cancelled: true } };
  }

  let contactEmail: string | null | undefined;
  if (followUp.contactId) {
    contactEmail = (await prisma.contact.findUnique({ where: { id: followUp.contactId } }))?.email;
  }
  if (!contactEmail) {
    await prisma.followUp.update({ where: { id: followUp.id }, data: { status: "CANCELLED", cancelReason: "No resolvable contact email." } });
    return { status: "BLOCKED", message: `Follow-up ${followUp.id} cancelled: no resolvable contact email.`, data: { followUpId: followUp.id, cancelled: true } };
  }

  const result = await handleSend(provider, {
    action: "send",
    to: contactEmail,
    subject: followUp.subject,
    body: followUp.body,
    taskId: followUp.taskId,
    contactId: followUp.contactId,
  });

  if (result.status === "OK") {
    await prisma.followUp.update({ where: { id: followUp.id }, data: { status: "EXECUTED" } });
  }
  // Any other outcome (BLOCKED by suppression/anti-spam/approval, CONFIGURATION_REQUIRED,
  // ERROR) leaves the FollowUp row as SCHEDULED - it remains resolvable/retryable
  // via the underlying task-retry or approval-decision path, not silently abandoned.
  return result;
}

async function handleSend(provider: EmailProvider, input: Record<string, unknown>): Promise<ToolResult> {
  const to = typeof input.to === "string" ? input.to.trim() : "";
  const subject = typeof input.subject === "string" ? input.subject : "";
  const body = typeof input.body === "string" ? input.body : "";
  const taskId = typeof input.taskId === "string" ? input.taskId : undefined;
  const contactId = typeof input.contactId === "string" ? input.contactId : undefined;
  const isMassCampaign = input.isMassCampaign === "true" || input.isMassCampaign === true;
  const monetaryValue = typeof input.monetaryValue === "string" ? Number(input.monetaryValue) : (input.monetaryValue as number | undefined);
  const approvalRequestId = typeof input.approvalRequestId === "string" ? input.approvalRequestId : undefined;

  if (!to || !subject || !body) {
    return { status: "ERROR", message: "email 'send' requires 'to', 'subject', and 'body'." };
  }

  // 1. Suppression check - BEFORE risk classification even runs.
  if (await isSuppressed(to)) {
    log("SECURITY", "email.send_blocked_suppressed", { to });
    return { status: "BLOCKED", message: `"${to}" is on the suppression list (unsubscribed/bounced) - send blocked.` };
  }

  // 2. Anti-spam limits.
  const antiSpam = await checkAntiSpamLimits({ toEmail: to });
  if (!antiSpam.allowed) {
    return { status: "BLOCKED", message: `Anti-spam limit hit: ${antiSpam.reason}` };
  }

  // 3. Idempotency check.
  const idempotencyKey = computeIdempotencyKey({ taskId, contactEmail: to, subject, body });
  const idem = await checkIdempotency(idempotencyKey);
  if (idem.alreadySent) {
    return {
      status: "OK",
      message: "This exact send was already completed previously - not sending again (idempotent).",
      data: { idempotencyKey, providerMessageId: idem.existing?.providerMessageId, deduplicated: true },
    };
  }

  // 4. Outbound risk classification - feeds into core/policy (see outboundPolicy.ts header).
  const risk = classifyOutboundEmail({ subject, body, isMassCampaign, monetaryValue });

  if (risk.riskCategory === "HIGH") {
    let approval = approvalRequestId ? await getApprovalRequest(approvalRequestId) : null;
    if (!approval) {
      // No approval reference given: check for an existing one under this idempotency key first (avoids a duplicate queue entry on retry).
      approval = await prisma.approvalRequest.findUnique({ where: { idempotencyKey } }).then((row) =>
        row
          ? {
              id: row.id,
              status: row.status as "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED" | "REVOKED",
              action: row.action,
              reason: row.reason,
              target: row.target,
              proposedContent: JSON.parse(row.proposedContent),
              supportingContext: row.supportingContext ? JSON.parse(row.supportingContext) : null,
              riskClassification: row.riskClassification,
              taskId: row.taskId,
              idempotencyKey: row.idempotencyKey,
              createdBy: row.createdBy,
              decidedBy: row.decidedBy,
              decidedAt: row.decidedAt,
              decisionNote: row.decisionNote,
              expiresAt: row.expiresAt,
              createdAt: row.createdAt,
              updatedAt: row.updatedAt,
            }
          : null
      );
    }

    // Phase 7.1 hardening (item 6): an APPROVED record is only valid for
    // THIS exact send - verify it, never trust the caller's approvalRequestId
    // input beyond "which row to look up." A caller-forged id that resolves
    // to someone else's approved request (different target/action), or a
    // real approval that has since gone stale (expiresAt passed - checked
    // here, not just at creation/decision time), is treated as absent.
    if (approval && approval.status === "APPROVED") {
      if (approval.action !== "email.send" || approval.target !== to) {
        log("SECURITY", "email.approval_target_mismatch", { to, approvalRequestId: approval.id, approvalTarget: approval.target, approvalAction: approval.action });
        approval = null;
      } else if (approval.expiresAt && approval.expiresAt.getTime() < Date.now()) {
        await prisma.approvalRequest.update({ where: { id: approval.id }, data: { status: "EXPIRED" } }).catch(() => undefined);
        log("SECURITY", "email.approval_expired_at_send", { to, approvalRequestId: approval.id });
        approval = null;
      }
    }

    if (!approval || approval.status !== "APPROVED") {
      const created =
        approval && approval.status === "PENDING"
          ? approval
          : await createApprovalRequest({
              action: "email.send",
              reason: `HIGH-RISK outbound email: ${risk.reasons.join(" ")}`,
              target: to,
              proposedContent: { to, subject, body },
              supportingContext: { taskId, contactId, isMassCampaign, monetaryValue },
              riskClassification: "HIGH",
              taskId,
              idempotencyKey,
              createdBy: "system:email-tool",
              expiresInHours: 72,
            });
      await recordSendAttempt({ idempotencyKey, taskId, contactId, status: "BLOCKED" });
      log("SECURITY", "email.send_blocked_pending_approval", { to, approvalRequestId: created.id, riskReasons: risk.reasons });
      return {
        status: "BLOCKED",
        message: `HIGH-RISK outbound email requires owner approval before it can be sent (approval request ${created.id}, status ${created.status}).`,
        data: { approvalRequestId: created.id, riskCategory: "HIGH", reasons: risk.reasons },
      };
    }
    // approval.status === "APPROVED": proceed to send below.
  }

  // 5/6. Atomically reserve the idempotency key BEFORE the real provider is
  // ever called (item 7 hardening) - closes a true-concurrency race that
  // step 3's plain read cannot: two simultaneous calls with the identical
  // idempotencyKey can both pass checkIdempotency() above, but only one can
  // win this DB-unique-constrained insert. The loser never reaches the
  // provider and reports the winner's outcome instead.
  const reservation = await reserveIdempotencyKey({ idempotencyKey, taskId, contactId });
  if (!reservation.reserved) {
    return {
      status: "OK",
      message: "This exact send is already in flight or completed (idempotent) - not sending again.",
      data: { idempotencyKey, providerMessageId: reservation.existing?.providerMessageId, deduplicated: true },
    };
  }

  const result = await provider.sendMessage({ to: [to], subject, body, idempotencyKey });
  if ("code" in result) {
    await recordSendAttempt({ idempotencyKey, taskId, contactId, status: "FAILED" });
    return { status: result.code === "CONFIGURATION_REQUIRED" ? "CONFIGURATION_REQUIRED" : "ERROR", message: result.message };
  }

  await recordSendAttempt({ idempotencyKey, taskId, contactId, status: "SENT", providerMessageId: result.providerMessageId });

  const emailRow = await prisma.email.create({
    data: {
      contactId: contactId ?? null,
      direction: "outbound",
      subject,
      body,
      status: "SENT",
      providerMessageId: result.providerMessageId,
      toAddress: to,
      riskCategory: risk.riskCategory,
      idempotencyKey,
    },
  });

  if (contactId) {
    await prisma.contact.update({ where: { id: contactId }, data: { lastContactedAt: new Date() } });
  }
  await recordActivity({ contactId, activityType: "EMAIL_SENT", relatedEntityId: emailRow.id, summary: `Sent email "${subject}" to ${to}.` });

  return { status: "OK", message: `Email sent to ${to}.`, data: { providerMessageId: result.providerMessageId, emailId: emailRow.id, riskCategory: risk.riskCategory } };
}

export const emailTool: Tool = createEmailTool();
