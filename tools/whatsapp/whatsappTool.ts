// tools/whatsapp/whatsappTool.ts - the `whatsapp` Tool (Phase 8, item 12).
// Same action-based house style as tools/email/emailTool.ts, and - per this
// phase's explicit instruction - a THIN CHANNEL ADAPTER over the exact same
// safety machinery email already built, not a parallel reimplementation of
// any business rule.
//
// THE SECOND MOST SAFETY-CRITICAL FUNCTION IN THIS CODEBASE (after
// emailTool.ts's handleSend): handleSend() below is the ONLY place a real
// WhatsAppProvider.sendMessage() call can happen. Together with
// emailTool.ts's handleSend(), these are the ONLY TWO
// `.sendMessage(`-to-a-real-provider call sites in the entire codebase - see
// docs/PHASE8_WHATSAPP.md's "provider send call count" section for the
// repo-wide grep proving this.
//
// Ordering is IDENTICAL to email's, reusing the SAME underlying functions
// (not re-derived copies):
//   1. suppression/opt-out check (core/business/antiSpam.ts's
//      isWhatsAppSuppressed() - the SAME SuppressedContact table email uses,
//      keyed by normalizedPhone instead of normalizedEmail)
//   2. anti-spam limits (checkWhatsAppAntiSpamLimits() - SAME
//      OutboundSendLog ledger and Setting-backed config, filtered by
//      channel)
//   3. idempotency check + atomic reservation (core/business/idempotency.ts's
//      reserveIdempotencyKey() - the SAME atomic, DB-unique-constraint-based
//      function email uses, keyed with `channel: "WHATSAPP"` folded in via
//      computeChannelIdempotencyKey())
//   4. outbound risk classification (core/business/outboundPolicy.ts's
//      classifyOutboundEmail() - called UNMODIFIED; risk depends on CONTENT,
//      not channel, so this file passes the WhatsApp body as `body` with an
//      empty `subject` and gets back the exact same LOW/HIGH categories and
//      core/policy wiring email gets)
//   5. for HIGH risk, an ApprovalRequest looked up FROM THE DATABASE
//      (core/approvals/index.ts, unmodified) with status/target/action/
//      expiresAt ALL re-validated at send time - `channel: "WHATSAPP"` is
//      carried in `supportingContext`, `action` is "whatsapp.send"
//   6. only LOW risk, or HIGH risk with a matching APPROVED request, reaches
//      provider.sendMessage()
import type { Tool, ToolResult } from "../registry";
import type { WhatsAppProvider } from "./types";
import { createDefaultWhatsAppProvider } from "./metaCloudProvider";
import { ingestInboundWhatsAppMessage } from "../../core/whatsapp/ingest";
import { isWhatsAppSuppressed, checkWhatsAppAntiSpamLimits } from "../../core/business/antiSpam";
import { classifyOutboundEmail } from "../../core/business/outboundPolicy";
import { computeChannelIdempotencyKey, checkIdempotency, recordSendAttempt, reserveIdempotencyKey } from "../../core/business/idempotency";
import { createApprovalRequest, getApprovalRequest } from "../../core/approvals";
import { recordActivity } from "../../core/crm/activity";
import { generateWhatsAppDraft, validateWhatsAppDraftGrounding } from "../../core/business/whatsappDraft";
import type { DraftContext } from "../../core/business/emailDraft";
import { getProductCategory } from "../../core/crm/businessConfig";
import { isFollowUpAllowed } from "../../core/business/followUp";
import { normalizePhone } from "../../core/crm/dedup";
import { prisma } from "../../database/client";
import { log } from "../../security/logger";

export function createWhatsAppTool(provider: WhatsAppProvider = createDefaultWhatsAppProvider()): Tool {
  return {
    name: "whatsapp",
    description:
      `Send/read WhatsApp messages via ${provider.name} (official WhatsApp Business Platform / Meta Cloud API). Actions: 'send' (gated by suppression/opt-out/anti-spam/idempotency/outbound-risk-approval, exactly like 'email'), 'draft' (no send). Inbound messages arrive via the webhook route, not 'list'. Returns CONFIGURATION_REQUIRED if no provider credential is set.`,
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "'send' | 'draft'" },
        to: { type: "string", description: "Recipient phone number, any reasonably-formatted variant (for 'send')" },
        body: { type: "string" },
        taskId: { type: "string", description: "Optional task id, for idempotency-key derivation and audit traceability." },
        contactId: { type: "string" },
        isMassCampaign: { type: "string", description: "'true' if this send targets a batch/broadcast. NOT_IMPLEMENTED this phase - always rejected, see outboundPolicy." },
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
          message: `CONFIGURATION_REQUIRED: no credentials configured for the "${provider.name}" WhatsApp provider (see .env.example - WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_BUSINESS_ACCOUNT_ID).`,
        };
      }

      // Phase 8's follow-up dispatch equivalent of emailTool.ts's - a
      // worker-executed follow-up task tagged toolName:"whatsapp" calls this
      // tool with no explicit action, only {taskId}.
      if (!action && typeof input.taskId === "string") {
        const followUp = await prisma.followUp.findUnique({ where: { taskId: input.taskId } });
        if (followUp && followUp.channel === "WHATSAPP") {
          return handleFollowUpDispatch(provider, followUp);
        }
      }

      if (action === "send") {
        return handleSend(provider, input);
      }

      if (action === "draft") {
        return handleDraft(input);
      }

      return { status: "ERROR", message: `Unknown action "${action}". Use 'send' or 'draft'. (Inbound messages are ingested via the webhook route, not this tool.)` };
    },
  };
}

async function handleDraft(input: Record<string, unknown>): Promise<ToolResult> {
  const category = (input.category as DraftContext["category"] | undefined) ?? "GENERAL_REPLY";
  const productCategoryName = typeof input.productCategoryName === "string" ? input.productCategoryName : undefined;
  const productCategory = productCategoryName ? await getProductCategory(productCategoryName) : null;

  const draft = generateWhatsAppDraft({
    contactFirstName: typeof input.contactFirstName === "string" ? input.contactFirstName : null,
    companyName: typeof input.companyName === "string" ? input.companyName : null,
    productCategory,
    category,
  });

  const grounding = validateWhatsAppDraftGrounding(draft.body, draft.citedFacts);
  if (!grounding.grounded) {
    return {
      status: "ERROR",
      message: `Draft rejected: contains claims not traceable to configured business data: ${grounding.ungroundedClaims.join(", ")}`,
      data: { draft, grounding },
    };
  }

  return { status: "OK", message: "Draft generated.", data: { draft, grounding } };
}

async function handleFollowUpDispatch(
  provider: WhatsAppProvider,
  followUp: { id: string; leadId: string | null; contactId: string | null; body: string; createdAt: Date; taskId: string | null }
): Promise<ToolResult> {
  const guard = await isFollowUpAllowed({
    taskId: followUp.taskId ?? "",
    contactId: followUp.contactId,
    leadId: followUp.leadId,
    sinceTaskCreatedAt: followUp.createdAt,
    channel: "WHATSAPP",
  });

  if (!guard.allowed) {
    await prisma.followUp.update({ where: { id: followUp.id }, data: { status: "CANCELLED", cancelReason: guard.reason ?? "Cancellation condition met." } });
    log("BUSINESS", "whatsapp.followUp.cancelled", { followUpId: followUp.id, reason: guard.reason });
    return { status: "BLOCKED", message: `Follow-up ${followUp.id} cancelled: ${guard.reason}`, data: { followUpId: followUp.id, cancelled: true } };
  }

  let contactPhone: string | null | undefined;
  if (followUp.contactId) {
    const contact = await prisma.contact.findUnique({ where: { id: followUp.contactId } });
    contactPhone = contact?.normalizedPhone ?? contact?.phone;
  }
  if (!contactPhone) {
    await prisma.followUp.update({ where: { id: followUp.id }, data: { status: "CANCELLED", cancelReason: "No resolvable contact phone number." } });
    return { status: "BLOCKED", message: `Follow-up ${followUp.id} cancelled: no resolvable contact phone number.`, data: { followUpId: followUp.id, cancelled: true } };
  }

  const result = await handleSend(provider, {
    action: "send",
    to: contactPhone,
    body: followUp.body,
    taskId: followUp.taskId,
    contactId: followUp.contactId,
  });

  if (result.status === "OK") {
    await prisma.followUp.update({ where: { id: followUp.id }, data: { status: "EXECUTED" } });
  }
  return result;
}

async function handleSend(provider: WhatsAppProvider, input: Record<string, unknown>): Promise<ToolResult> {
  const rawTo = typeof input.to === "string" ? input.to.trim() : "";
  const body = typeof input.body === "string" ? input.body : "";
  const taskId = typeof input.taskId === "string" ? input.taskId : undefined;
  const contactId = typeof input.contactId === "string" ? input.contactId : undefined;
  const isMassCampaign = input.isMassCampaign === "true" || input.isMassCampaign === true;
  const monetaryValue = typeof input.monetaryValue === "string" ? Number(input.monetaryValue) : (input.monetaryValue as number | undefined);
  const approvalRequestId = typeof input.approvalRequestId === "string" ? input.approvalRequestId : undefined;

  if (!rawTo || !body) {
    return { status: "ERROR", message: "whatsapp 'send' requires 'to' and 'body'." };
  }

  // Section 25: mass outbound / broadcast is explicitly NOT_IMPLEMENTED this
  // phase - not even gated behind approval. A caller asking for one is
  // rejected outright, before any other check runs.
  if (isMassCampaign) {
    return { status: "ERROR", message: "Mass WhatsApp campaigns/broadcasts are NOT_IMPLEMENTED (see docs/PHASE8_WHATSAPP.md) - this send was rejected, not queued." };
  }

  const { normalized: to, valid: toValid } = normalizePhone(rawTo);
  if (!toValid || !to) {
    return { status: "ERROR", message: `"${rawTo}" could not be reliably normalized to a phone number - refusing to guess a recipient.` };
  }

  // 1. Suppression/opt-out check - BEFORE risk classification even runs.
  if (await isWhatsAppSuppressed(to)) {
    log("SECURITY", "whatsapp.send_blocked_suppressed", { to });
    return { status: "BLOCKED", message: `"${to}" is on the suppression list (opted out) - send blocked.` };
  }

  // 2. Anti-spam limits.
  const antiSpam = await checkWhatsAppAntiSpamLimits({ toPhone: to });
  if (!antiSpam.allowed) {
    return { status: "BLOCKED", message: `Anti-spam limit hit: ${antiSpam.reason}` };
  }

  // 3. Idempotency check.
  const idempotencyKey = computeChannelIdempotencyKey({ channel: "WHATSAPP", taskId, recipient: to, body });
  const idem = await checkIdempotency(idempotencyKey);
  if (idem.alreadySent) {
    return {
      status: "OK",
      message: "This exact send was already completed previously - not sending again (idempotent).",
      data: { idempotencyKey, providerMessageId: idem.existing?.providerMessageId, deduplicated: true },
    };
  }

  // 4. Outbound risk classification - the SAME classifier email uses
  // (core/business/outboundPolicy.ts), unmodified. Risk depends on CONTENT,
  // not channel, so `subject` is simply empty.
  const risk = classifyOutboundEmail({ subject: "", body, isMassCampaign: false, monetaryValue });

  if (risk.riskCategory === "HIGH") {
    let approval = approvalRequestId ? await getApprovalRequest(approvalRequestId) : null;
    if (!approval) {
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

    // Same Phase 7.1 hardening as email: an APPROVED record is only valid
    // for THIS exact send - action AND target must match, and expiresAt is
    // re-checked at send time regardless of what it was at decision time.
    if (approval && approval.status === "APPROVED") {
      if (approval.action !== "whatsapp.send" || approval.target !== to) {
        log("SECURITY", "whatsapp.approval_target_mismatch", { to, approvalRequestId: approval.id, approvalTarget: approval.target, approvalAction: approval.action });
        approval = null;
      } else if (approval.expiresAt && approval.expiresAt.getTime() < Date.now()) {
        await prisma.approvalRequest.update({ where: { id: approval.id }, data: { status: "EXPIRED" } }).catch(() => undefined);
        log("SECURITY", "whatsapp.approval_expired_at_send", { to, approvalRequestId: approval.id });
        approval = null;
      }
    }

    if (!approval || approval.status !== "APPROVED") {
      const created =
        approval && approval.status === "PENDING"
          ? approval
          : await createApprovalRequest({
              action: "whatsapp.send",
              reason: `HIGH-RISK outbound WhatsApp message: ${risk.reasons.join(" ")}`,
              target: to,
              proposedContent: { to, body },
              supportingContext: { channel: "WHATSAPP", taskId, contactId, monetaryValue },
              riskClassification: "HIGH",
              taskId,
              idempotencyKey,
              createdBy: "system:whatsapp-tool",
              expiresInHours: 72,
            });
      await recordSendAttempt({ idempotencyKey, taskId, contactId, status: "BLOCKED", channel: "WHATSAPP" });
      log("SECURITY", "whatsapp.send_blocked_pending_approval", { to, approvalRequestId: created.id, riskReasons: risk.reasons });
      return {
        status: "BLOCKED",
        message: `HIGH-RISK outbound WhatsApp message requires owner approval before it can be sent (approval request ${created.id}, status ${created.status}).`,
        data: { approvalRequestId: created.id, riskCategory: "HIGH", reasons: risk.reasons },
      };
    }
  }

  // 5/6. Atomically reserve the idempotency key BEFORE the real provider is
  // ever called - the SAME atomic mechanism email uses.
  const reservation = await reserveIdempotencyKey({ idempotencyKey, taskId, contactId, channel: "WHATSAPP" });
  if (!reservation.reserved) {
    return {
      status: "OK",
      message: "This exact send is already in flight or completed (idempotent) - not sending again.",
      data: { idempotencyKey, providerMessageId: reservation.existing?.providerMessageId, deduplicated: true },
    };
  }

  const result = await provider.sendMessage({ to, body, idempotencyKey });
  if ("code" in result) {
    await recordSendAttempt({ idempotencyKey, taskId, contactId, status: "FAILED", channel: "WHATSAPP" });
    return { status: result.code === "CONFIGURATION_REQUIRED" ? "CONFIGURATION_REQUIRED" : "ERROR", message: result.message };
  }

  await recordSendAttempt({ idempotencyKey, taskId, contactId, status: "SENT", providerMessageId: result.providerMessageId, channel: "WHATSAPP" });

  const messageRow = await prisma.email.create({
    data: {
      contactId: contactId ?? null,
      direction: "outbound",
      channel: "WHATSAPP",
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
  await recordActivity({ contactId, channel: "whatsapp", activityType: "WHATSAPP_SENT", relatedEntityId: messageRow.id, summary: `Sent WhatsApp message to ${to}.` });

  return { status: "OK", message: `WhatsApp message sent to ${to}.`, data: { providerMessageId: result.providerMessageId, messageId: messageRow.id, riskCategory: risk.riskCategory } };
}

export const whatsappTool: Tool = createWhatsAppTool();
