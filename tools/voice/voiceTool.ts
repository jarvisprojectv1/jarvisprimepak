// tools/voice/voiceTool.ts - the `voice` Tool (Phase 9, items 8-9, 20, 26).
// Same action-based house style as tools/whatsapp/whatsappTool.ts, and - per
// this phase's explicit instruction - a THIN CHANNEL ADAPTER over the exact
// same safety machinery email/WhatsApp already built, not a parallel
// reimplementation of any business rule.
//
// THE THIRD MOST SAFETY-CRITICAL FUNCTION IN THIS CODEBASE (after
// emailTool.ts's and whatsappTool.ts's handleSend): handleOutboundCall()
// below is the ONLY place a real VoiceProvider.createCall() call can happen.
// Together with those two, this is the ONLY outbound-send-to-a-real-provider
// call site added this phase - see docs/PHASE9_VOICE.md's "provider call
// call-site count" section for the repo-wide grep proving this.
//
// Ordering mirrors email/WhatsApp's handleSend() exactly, generalized where
// voice needs something extra (item 8):
//   1. mass-campaign / cold-calling rejection (NOT_IMPLEMENTED outright,
//      exactly like WhatsApp's isMassCampaign rejection - see section 45's
//      "unrestricted autonomous outbound calling"/"cold-call campaigns"
//      exclusion list)
//   2. caller/contact resolution + phone normalization (core/crm/dedup.ts's
//      normalizePhone() - the ONE shared normalizer, never a duplicate)
//   3. suppression/DO_NOT_CALL check (core/business/antiSpam.ts's
//      isDoNotCall() - the SAME SuppressedContact table WhatsApp uses,
//      keyed by normalizedPhone)
//   4. call-frequency anti-spam limit (checkVoiceAntiSpamLimits())
//   5. idempotency check + atomic reservation
//      (core/business/idempotency.ts's reserveIdempotencyKey(), channel
//      "VOICE")
//   6. outbound risk classification (core/business/outboundPolicy.ts's
//      classifyOutboundVoice() - voice defaults HIGH, see that file's header
//      for the one narrow LOW exception)
//   7. for HIGH risk, an ApprovalRequest looked up FROM THE DATABASE
//      (core/approvals/index.ts, unmodified) with status/target/action/
//      expiresAt ALL re-validated at call time - `channel: "VOICE"` is
//      carried in `supportingContext`, `action` is "voice.call"
//   8. only LOW risk, or HIGH risk with a matching APPROVED request, reaches
//      provider.createCall()
import type { Tool, ToolResult } from "../registry";
import type { VoiceProvider } from "./types";
import { createDefaultVoiceProvider } from "./twilioProvider";
import { isDoNotCall, checkVoiceAntiSpamLimits } from "../../core/business/antiSpam";
import { classifyOutboundVoice, type OutboundCallPurpose } from "../../core/business/outboundPolicy";
import { computeChannelIdempotencyKey, checkIdempotency, recordSendAttempt, reserveIdempotencyKey } from "../../core/business/idempotency";
import { createApprovalRequest, getApprovalRequest } from "../../core/approvals";
import { recordActivity } from "../../core/crm/activity";
import { isFollowUpAllowed } from "../../core/business/followUp";
import { normalizePhone } from "../../core/crm/dedup";
import { notificationService } from "../../core/notifications";
import { prisma } from "../../database/client";
import { log } from "../../security/logger";

export function createVoiceTool(provider: VoiceProvider = createDefaultVoiceProvider()): Tool {
  return {
    name: "voice",
    description:
      `Outbound calls via ${provider.name} (Twilio Programmable Voice). Actions: 'call' (gated by suppression/DO-NOT-CALL/anti-spam/idempotency/outbound-risk-approval, exactly like 'email'/'whatsapp' send), 'human_handoff' (creates a callback task/notification - never a real live telephony transfer). Inbound calls arrive via the webhook route, not this tool. Returns CONFIGURATION_REQUIRED if no provider credential is set.`,
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "'call' | 'human_handoff'" },
        to: { type: "string", description: "Recipient phone number, any reasonably-formatted variant (for 'call')" },
        purposeSummary: { type: "string", description: "A short, non-business-content summary of the call's purpose (never invented business claims)." },
        purpose: { type: "string", description: "'CALLBACK_CONFIRMATION' | 'BUSINESS_OUTREACH' | 'GENERAL' - see core/business/outboundPolicy.ts's classifyOutboundVoice()." },
        taskId: { type: "string", description: "Optional task id, for idempotency-key derivation and audit traceability." },
        contactId: { type: "string" },
        callId: { type: "string", description: "The Call row id this human_handoff concerns." },
        reason: { type: "string", description: "Why a human handoff is being requested." },
        isMassCampaign: { type: "string", description: "'true' if this targets a batch. NOT_IMPLEMENTED this phase - always rejected, see section 45." },
        monetaryValue: { type: "string" },
        approvalRequestId: { type: "string", description: "An already-APPROVED ApprovalRequest id authorizing a HIGH-RISK call to proceed." },
      },
      required: ["action"],
    },
    async execute(input): Promise<ToolResult> {
      const action = input.action as string | undefined;

      if (!provider.isConfigured()) {
        return {
          status: "CONFIGURATION_REQUIRED",
          message: `CONFIGURATION_REQUIRED: no credentials configured for the "${provider.name}" voice provider (see .env.example - TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER).`,
        };
      }

      // Follow-up dispatch equivalent of email/whatsapp's - a worker-executed
      // callback FollowUp tagged toolName:"voice" calls this tool with no
      // explicit action, only {taskId}. A callback REQUEST never pre-
      // authorizes the eventual call (item 26) - handleOutboundCall() below
      // still re-runs the FULL safety pipeline from scratch.
      if (!action && typeof input.taskId === "string") {
        const followUp = await prisma.followUp.findUnique({ where: { taskId: input.taskId } });
        if (followUp && followUp.channel === "VOICE") {
          return handleFollowUpDispatch(provider, followUp);
        }
      }

      if (action === "call") {
        return handleOutboundCall(provider, input);
      }

      if (action === "human_handoff") {
        return handleHumanHandoff(input);
      }

      return { status: "ERROR", message: `Unknown action "${action}". Use 'call' or 'human_handoff'. (Inbound calls are ingested via the webhook route, not this tool.)` };
    },
  };
}

/**
 * Item 20: a "human handoff" in this phase means creating a callback task +
 * dashboard notification - honest about NOT attempting a fake live transfer
 * (no real telephony call-control session exists to transfer within, and
 * provider.transferCall() itself honestly returns NOT_IMPLEMENTED - see
 * twilioProvider.ts/mockProvider.ts).
 */
async function handleHumanHandoff(input: Record<string, unknown>): Promise<ToolResult> {
  const callId = typeof input.callId === "string" ? input.callId : undefined;
  const contactId = typeof input.contactId === "string" ? input.contactId : undefined;
  const reason = typeof input.reason === "string" ? input.reason : "Caller requested a human agent, or identity/topic required human review.";

  if (callId) {
    await prisma.call.update({ where: { id: callId }, data: { outcome: "HUMAN_HANDOFF" } }).catch(() => undefined);
  }
  if (contactId) {
    await recordActivity({ contactId, channel: "call", direction: "inbound", activityType: "CALL_HUMAN_HANDOFF", relatedEntityId: callId ?? null, summary: reason });
  }
  await notificationService.create({ title: "Call requires a human follow-up", body: reason, type: "ACTION_REQUIRED" }).catch((err) => {
    log("ERROR", "voice.handoff_notification_failed", { error: err instanceof Error ? err.message : String(err) });
  });
  log("BUSINESS", "voice.human_handoff_created", { callId, contactId, reason });
  return { status: "OK", message: "Human-handoff callback task/notification created (no live telephony transfer was attempted).", data: { callId, contactId } };
}

async function handleFollowUpDispatch(
  provider: VoiceProvider,
  followUp: { id: string; leadId: string | null; contactId: string | null; body: string; createdAt: Date; taskId: string | null }
): Promise<ToolResult> {
  const guard = await isFollowUpAllowed({
    taskId: followUp.taskId ?? "",
    contactId: followUp.contactId,
    leadId: followUp.leadId,
    sinceTaskCreatedAt: followUp.createdAt,
    channel: "VOICE",
  });

  if (!guard.allowed) {
    await prisma.followUp.update({ where: { id: followUp.id }, data: { status: "CANCELLED", cancelReason: guard.reason ?? "Cancellation condition met." } });
    log("BUSINESS", "voice.followUp.cancelled", { followUpId: followUp.id, reason: guard.reason });
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

  // Item 26: a callback REQUEST does not pre-authorize the call - the full
  // pipeline (suppression/anti-spam/idempotency/risk/approval) runs again
  // from scratch here, exactly as if this were any other 'call' action.
  const result = await handleOutboundCall(provider, {
    action: "call",
    to: contactPhone,
    purpose: "CALLBACK_CONFIRMATION",
    purposeSummary: followUp.body,
    taskId: followUp.taskId,
    contactId: followUp.contactId,
  });

  if (result.status === "OK") {
    await prisma.followUp.update({ where: { id: followUp.id }, data: { status: "EXECUTED" } });
  }
  return result;
}

async function handleOutboundCall(provider: VoiceProvider, input: Record<string, unknown>): Promise<ToolResult> {
  const rawTo = typeof input.to === "string" ? input.to.trim() : "";
  const purposeSummary = typeof input.purposeSummary === "string" ? input.purposeSummary : "";
  const purpose = (typeof input.purpose === "string" ? input.purpose : "GENERAL") as OutboundCallPurpose;
  const taskId = typeof input.taskId === "string" ? input.taskId : undefined;
  const contactId = typeof input.contactId === "string" ? input.contactId : undefined;
  const isMassCampaign = input.isMassCampaign === "true" || input.isMassCampaign === true;
  const monetaryValue = typeof input.monetaryValue === "string" ? Number(input.monetaryValue) : (input.monetaryValue as number | undefined);
  const approvalRequestId = typeof input.approvalRequestId === "string" ? input.approvalRequestId : undefined;

  if (!rawTo) {
    return { status: "ERROR", message: "voice 'call' requires 'to'." };
  }

  // Section 45: mass outbound / cold-call campaigns / unrestricted
  // autonomous outbound calling are explicitly NOT_IMPLEMENTED - rejected
  // outright, before any other check runs, exactly like WhatsApp's
  // isMassCampaign rejection.
  if (isMassCampaign) {
    return { status: "ERROR", message: "Mass outbound calling / cold-call campaigns are NOT_IMPLEMENTED (see docs/PHASE9_VOICE.md, section 45's exclusion list) - this call was rejected, not queued." };
  }

  const { normalized: to, valid: toValid } = normalizePhone(rawTo);
  if (!toValid || !to) {
    return { status: "ERROR", message: `"${rawTo}" could not be reliably normalized to a phone number - refusing to guess a recipient.` };
  }

  // 1. Suppression/DO_NOT_CALL check - BEFORE risk classification even runs.
  if (await isDoNotCall(to)) {
    log("SECURITY", "voice.call_blocked_suppressed", { to });
    return { status: "BLOCKED", message: `"${to}" is on the suppression/do-not-call list - call blocked.` };
  }

  // 2. Call-frequency anti-spam limit.
  const antiSpam = await checkVoiceAntiSpamLimits({ toPhone: to });
  if (!antiSpam.allowed) {
    return { status: "BLOCKED", message: `Anti-spam call-frequency limit hit: ${antiSpam.reason}` };
  }

  // 3. Idempotency check.
  const idempotencyKey = computeChannelIdempotencyKey({ channel: "VOICE", taskId, recipient: to, body: `${purpose}\n${purposeSummary}` });
  const idem = await checkIdempotency(idempotencyKey);
  if (idem.alreadySent) {
    return {
      status: "OK",
      message: "This exact outbound call was already completed previously - not calling again (idempotent).",
      data: { idempotencyKey, providerCallId: idem.existing?.providerMessageId, deduplicated: true },
    };
  }

  // 4. Outbound risk classification - voice defaults HIGH; see
  // core/business/outboundPolicy.ts's classifyOutboundVoice() for the one
  // narrow LOW exception.
  const risk = classifyOutboundVoice({ body: purposeSummary, purpose, isMassCampaign: false, monetaryValue });

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

    // Same Phase 7.1 hardening as email/WhatsApp: an APPROVED record is only
    // valid for THIS exact call - action AND target must match, and
    // expiresAt is re-checked at CALL time regardless of what it was at
    // decision time.
    if (approval && approval.status === "APPROVED") {
      if (approval.action !== "voice.call" || approval.target !== to) {
        log("SECURITY", "voice.approval_target_mismatch", { to, approvalRequestId: approval.id, approvalTarget: approval.target, approvalAction: approval.action });
        approval = null;
      } else if (approval.expiresAt && approval.expiresAt.getTime() < Date.now()) {
        await prisma.approvalRequest.update({ where: { id: approval.id }, data: { status: "EXPIRED" } }).catch(() => undefined);
        log("SECURITY", "voice.approval_expired_at_send", { to, approvalRequestId: approval.id });
        approval = null;
      }
    }

    if (!approval || approval.status !== "APPROVED") {
      const created =
        approval && approval.status === "PENDING"
          ? approval
          : await createApprovalRequest({
              action: "voice.call",
              reason: `HIGH-RISK outbound call: ${risk.reasons.join(" ")}`,
              target: to,
              proposedContent: { to, purpose, purposeSummary },
              supportingContext: { channel: "VOICE", taskId, contactId, monetaryValue },
              riskClassification: "HIGH",
              taskId,
              idempotencyKey,
              createdBy: "system:voice-tool",
              expiresInHours: 72,
            });
      await recordSendAttempt({ idempotencyKey, taskId, contactId, status: "BLOCKED", channel: "VOICE" });
      log("SECURITY", "voice.call_blocked_pending_approval", { to, approvalRequestId: created.id, riskReasons: risk.reasons });
      return {
        status: "BLOCKED",
        message: `HIGH-RISK outbound call requires owner approval before it can be placed (approval request ${created.id}, status ${created.status}).`,
        data: { approvalRequestId: created.id, riskCategory: "HIGH", reasons: risk.reasons },
      };
    }
  }

  // 5/6. Atomically reserve the idempotency key BEFORE the real provider is
  // ever called - the SAME atomic mechanism email/WhatsApp use.
  const reservation = await reserveIdempotencyKey({ idempotencyKey, taskId, contactId, channel: "VOICE" });
  if (!reservation.reserved) {
    return {
      status: "OK",
      message: "This exact outbound call is already in flight or completed (idempotent) - not calling again.",
      data: { idempotencyKey, providerCallId: reservation.existing?.providerMessageId, deduplicated: true },
    };
  }

  const statusCallbackUrl = process.env.VOICE_PUBLIC_WEBHOOK_URL ? `${process.env.VOICE_PUBLIC_WEBHOOK_URL.replace(/\/$/, "")}/webhooks/voice` : undefined;
  const result = await provider.createCall({ to, purposeSummary, statusCallbackUrl, idempotencyKey });
  if ("code" in result) {
    await recordSendAttempt({ idempotencyKey, taskId, contactId, status: "FAILED", channel: "VOICE" });
    return { status: result.code === "CONFIGURATION_REQUIRED" ? "CONFIGURATION_REQUIRED" : "ERROR", message: result.message };
  }

  await recordSendAttempt({ idempotencyKey, taskId, contactId, status: "SENT", providerMessageId: result.providerCallId, channel: "VOICE" });

  const callRow = await prisma.call.create({
    data: {
      contactId: contactId ?? null,
      direction: "outbound",
      provider: provider.name,
      providerCallId: result.providerCallId,
      callerNumber: to,
      normalizedCallerNumber: to,
      status: result.status,
      riskCategory: risk.riskCategory,
      idempotencyKey,
      startedAt: new Date(),
    },
  });

  if (contactId) {
    await prisma.contact.update({ where: { id: contactId }, data: { lastContactedAt: new Date() } });
  }
  await recordActivity({ contactId, channel: "call", activityType: "CALL_OUTBOUND", relatedEntityId: callRow.id, summary: `Placed outbound call to ${to}.` });

  return { status: "OK", message: `Outbound call placed to ${to}.`, data: { providerCallId: result.providerCallId, callId: callRow.id, riskCategory: risk.riskCategory } };
}

export const voiceTool: Tool = createVoiceTool();
