// tools/browser/browserTool.ts - the `browser` Tool (Phase 10, sections
// 16-20), THE SINGLE MOST SAFETY-CRITICAL FILE THIS PHASE.
//
// handleBrowserAction() below is the ONLY place a real BrowserProvider
// side-effecting call (navigate/click/type/select/submit/download/upload)
// can happen, mirroring tools/email/emailTool.ts's/tools/whatsapp/
// whatsappTool.ts's/tools/voice/voiceTool.ts's handleSend()/
// handleOutboundCall() pattern for a FOURTH capability, registered through
// the SAME toolRegistry.register() enforcement gate - no fourth parallel
// safety system.
//
// Pipeline order (section 16): state (handled upstream by
// core/enforcement's gate, which every registered Tool already passes
// through - see agents/browser-emergency-stop.test.ts for the runtime
// proof) -> authz (handled upstream by the caller/route layer, per the
// existing browser.* AuthzAction additions) -> domain policy -> FINANCIAL
// HARD BLOCK (unconditional, before approval is even consulted) -> risk
// classification -> approval lookup/creation -> last-moment revalidation
// (re-check approval AND current page state right before executing) ->
// provider call -> verification -> audit.
//
// Deterministic, DOM/accessibility-tree-based action selection only this
// phase - no vision-capable LLM call site exists here, so there is nothing
// to route through core/ai/costControl.ts yet (matches the honest
// "consider skipping vision entirely" guidance). If page content is ever
// summarized for a human/LLM, it MUST go through core/browser/observation.ts
// (bounded) then core/research/trustBoundary.ts's wrapExternalBrowserContent()
// - see those files' headers.
import type { Tool, ToolResult } from "../registry";
import type { BrowserProvider } from "./types";
import { createDefaultBrowserProvider } from "./playwrightProvider";
import {
  classifyDomain,
  classifyBrowserAction,
  isFinancialHardBlock,
  type BrowserActionType,
} from "../../core/business/browserPolicy";
import { detectMfaOrCaptcha } from "../../core/browser/mfaDetect";
import { buildBoundedObservation } from "../../core/browser/observation";
import { domainOf, validateUrl } from "../web/sourceResolver";
import { createApprovalRequest, getApprovalRequest } from "../../core/approvals";
import { prisma } from "../../database/client";
import { log } from "../../security/logger";

const READ_ONLY_ACTIONS: BrowserActionType[] = ["navigate", "scroll", "extract", "screenshot"];

export function createBrowserTool(provider: BrowserProvider = createDefaultBrowserProvider()): Tool {
  return {
    name: "browser",
    description:
      "Control an isolated headless browser session (Playwright). Actions: 'create_session', 'navigate', 'click', 'type', 'get_content', 'screenshot', 'scroll', 'close_session'. Every beyond-read-only action is domain/financial/risk-checked; financial-transaction-shaped actions are hard-blocked; HIGH-risk or unknown-domain actions require prior OWNER approval.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "'create_session' | 'navigate' | 'click' | 'type' | 'get_content' | 'screenshot' | 'scroll' | 'close_session'" },
        sessionId: { type: "string" },
        url: { type: "string" },
        selector: { type: "string" },
        text: { type: "string" },
        value: { type: "string" },
        taskId: { type: "string" },
        approvalRequestId: { type: "string" },
      },
      required: ["action"],
    },
    async execute(input): Promise<ToolResult> {
      const action = typeof input.action === "string" ? input.action : "";
      const taskId = typeof input.taskId === "string" ? input.taskId : undefined;

      if (action === "create_session") {
        const created = await provider.createSession({ taskId, createdBy: "system:browser-tool" });
        if ("code" in created) return { status: "ERROR", message: created.message };
        return { status: "OK", message: `Browser session ${created.sessionId} created (isolated context).`, data: { sessionId: created.sessionId } };
      }

      const sessionId = typeof input.sessionId === "string" ? input.sessionId : "";
      if (!sessionId) return { status: "ERROR", message: `browser '${action}' requires 'sessionId' (create one first with action='create_session').` };

      if (action === "close_session") {
        const r = await provider.closeSession(sessionId);
        return { status: r.ok ? "OK" : "ERROR", message: r.message };
      }

      if (action === "get_content") {
        return handleReadOnly(provider, sessionId, "extract", async () => provider.getPageContent(sessionId));
      }
      if (action === "screenshot") {
        return handleReadOnly(provider, sessionId, "screenshot", async () => provider.screenshot(sessionId));
      }
      if (action === "scroll") {
        return handleReadOnly(provider, sessionId, "scroll", async () => provider.scroll(sessionId, "down"));
      }

      if (action === "navigate") {
        const url = typeof input.url === "string" ? input.url.trim() : "";
        if (!url) return { status: "ERROR", message: "browser 'navigate' requires 'url'." };
        // Reuses Phase 6's exact URL/protocol validation (tools/web/sourceResolver.ts)
        // rather than re-deriving allowlist logic.
        const validation = validateUrl(url);
        if (!validation.valid) return { status: "ERROR", message: validation.reason ?? "Invalid URL." };
        return handleBrowserAction(provider, {
          sessionId,
          taskId,
          actionType: "navigate",
          domain: safeDomain(url),
          targetText: null,
          approvalRequestId: typeof input.approvalRequestId === "string" ? input.approvalRequestId : undefined,
          run: () => provider.navigate(sessionId, url),
        });
      }

      if (action === "click") {
        const selector = typeof input.selector === "string" ? input.selector : undefined;
        const text = typeof input.text === "string" ? input.text : undefined;
        const currentUrl = await provider.getCurrentUrl(sessionId);
        const domain = safeDomain(String(currentUrl.data?.url ?? ""));
        return handleBrowserAction(provider, {
          sessionId,
          taskId,
          actionType: "click",
          domain,
          targetText: text ?? selector ?? null,
          approvalRequestId: typeof input.approvalRequestId === "string" ? input.approvalRequestId : undefined,
          run: () => provider.click(sessionId, { selector, text }),
        });
      }

      if (action === "type") {
        const selector = typeof input.selector === "string" ? input.selector : undefined;
        const text = typeof input.text === "string" ? input.text : undefined;
        const value = typeof input.value === "string" ? input.value : "";
        const currentUrl = await provider.getCurrentUrl(sessionId);
        const domain = safeDomain(String(currentUrl.data?.url ?? ""));
        return handleBrowserAction(provider, {
          sessionId,
          taskId,
          actionType: "type",
          domain,
          targetText: text ?? selector ?? null,
          approvalRequestId: typeof input.approvalRequestId === "string" ? input.approvalRequestId : undefined,
          run: () => provider.type(sessionId, { selector, text }, value),
        });
      }

      return { status: "ERROR", message: `Unknown browser action "${action}".` };
    },
  };
}

function safeDomain(url: string): string {
  try {
    return domainOf(url);
  } catch {
    return "";
  }
}

async function handleReadOnly(provider: BrowserProvider, sessionId: string, actionType: BrowserActionType, run: () => Promise<{ ok: boolean; message: string; data?: Record<string, unknown> }>): Promise<ToolResult> {
  const currentUrl = await provider.getCurrentUrl(sessionId);
  const domain = safeDomain(String(currentUrl.data?.url ?? ""));
  const domainClassification = classifyDomain(domain);
  // Read-only actions are never hard-blocked by financial policy (see
  // isFinancialHardBlock's READ_ONLY_ACTIONS carve-out), but a domain on the
  // hardcoded BLOCKED list is blocked even for reading, since a financial
  // institution's checkout/account pages should not be scraped either.
  if (domainClassification === "BLOCKED" && actionType !== "extract") {
    return { status: "BLOCKED", message: `Domain "${domain}" is on the hardcoded financial/payment BLOCKED list - even read-only ${actionType} is refused.` };
  }
  const r = await run();
  if (!r.ok) return { status: "ERROR", message: r.message };

  if (actionType === "extract" && typeof r.data?.text === "string") {
    const finding = detectMfaOrCaptcha(r.data.text);
    const observation = buildBoundedObservation({ url: String(r.data.url ?? currentUrl.data?.url ?? ""), domain, title: null, rawText: r.data.text });
    if (finding) {
      return { status: "OK", message: `${finding}: best-effort heuristic detected a CAPTCHA/MFA challenge on this page - task paused, not bypassed.`, data: { state: finding, observation } };
    }
    return { status: "OK", message: r.message, data: { observation } };
  }
  return { status: "OK", message: r.message, data: r.data };
}

interface ActionCtx {
  sessionId: string;
  taskId?: string;
  actionType: BrowserActionType;
  domain: string;
  targetText: string | null;
  approvalRequestId?: string;
  run: () => Promise<{ ok: boolean; message: string; data?: Record<string, unknown> }>;
}

async function handleBrowserAction(provider: BrowserProvider, ctx: ActionCtx): Promise<ToolResult> {
  const domainClassification = classifyDomain(ctx.domain);

  // 1. FINANCIAL HARD BLOCK - unconditional, checked BEFORE approval is even
  // consulted. No approvalRequestId, however "valid", can ever satisfy this.
  const hardBlock = isFinancialHardBlock({ domain: ctx.domain, actionType: ctx.actionType, targetText: ctx.targetText });
  if (hardBlock.blocked) {
    log("SECURITY", "browser.financial_hard_block", { domain: ctx.domain, actionType: ctx.actionType, reason: hardBlock.reason });
    await recordBrowserTask(ctx, "BLOCKED", null, hardBlock.reason);
    return { status: "BLOCKED", message: `BLOCKED (financial hard block, non-approvable): ${hardBlock.reason}`, data: { hardBlocked: true } };
  }

  // 2. Risk classification (feeds core/policy via classifyBrowserAction).
  const risk = classifyBrowserAction({ domain: ctx.domain, actionType: ctx.actionType, targetText: ctx.targetText, domainClassification });
  if (risk.riskCategory === "BLOCKED") {
    await recordBrowserTask(ctx, "BLOCKED", null, risk.reasons.join(" "));
    return { status: "BLOCKED", message: `BLOCKED: ${risk.reasons.join(" ")}`, data: { riskCategory: risk.riskCategory } };
  }

  // 3. Approval gate.
  if (risk.requiresApproval) {
    let approval = ctx.approvalRequestId ? await getApprovalRequest(ctx.approvalRequestId) : null;

    // Last-moment revalidation (section 18): status/target/action/expiry are
    // ALL re-checked right here, never trusted from the caller's earlier
    // decision-time snapshot.
    if (approval && approval.status === "APPROVED") {
      const targetMatches = approval.target === ctx.domain || approval.target === ctx.targetText;
      if (approval.action !== `browser.${ctx.actionType}` || !targetMatches) {
        log("SECURITY", "browser.approval_target_mismatch", { domain: ctx.domain, approvalId: approval.id });
        approval = null;
      } else if (approval.expiresAt && approval.expiresAt.getTime() < Date.now()) {
        await prisma.approvalRequest.update({ where: { id: approval.id }, data: { status: "EXPIRED" } }).catch(() => undefined);
        approval = null;
      }
    }

    if (!approval || approval.status !== "APPROVED") {
      const created =
        approval && approval.status === "PENDING"
          ? approval
          : await createApprovalRequest({
              action: `browser.${ctx.actionType}`,
              reason: `${risk.riskCategory}-risk browser action: ${risk.reasons.join(" ")}`,
              target: ctx.domain || ctx.targetText || ctx.sessionId,
              proposedContent: { domain: ctx.domain, actionType: ctx.actionType, targetText: ctx.targetText, sessionId: ctx.sessionId },
              supportingContext: { channel: "BROWSER", taskId: ctx.taskId, riskCategory: risk.riskCategory },
              riskClassification: risk.riskCategory === "HIGH" ? "HIGH" : "HIGH", // only HIGH-or-above ever reaches this queue, matching ApprovalRequest's documented invariant
              taskId: ctx.taskId,
              createdBy: "system:browser-tool",
              expiresInHours: 24,
            });
      await recordBrowserTask(ctx, "APPROVAL_REQUIRED", created.id, risk.reasons.join(" "));
      log("SECURITY", "browser.action_blocked_pending_approval", { domain: ctx.domain, actionType: ctx.actionType, approvalId: created.id });
      return {
        status: "BLOCKED",
        message: `${risk.riskCategory}-risk browser action requires owner approval before it can execute (approval request ${created.id}, status ${created.status}).`,
        data: { approvalRequestId: created.id, riskCategory: risk.riskCategory, reasons: risk.reasons },
      };
    }

    // 4. Section 19: re-check current page state immediately before
    // executing - if it materially changed since the plan/approval was
    // made, STOP rather than blindly proceed. Best-effort: we can only
    // compare against the domain the approval was granted for; a full
    // "expected step text vs observed page text" diff needs the Brain's
    // plan-step text, out of this tool's scope - documented honestly.
    const liveUrl = await provider.getCurrentUrl(ctx.sessionId);
    const liveDomain = safeDomain(String(liveUrl.data?.url ?? ""));
    if (ctx.actionType !== "navigate" && liveDomain && liveDomain !== ctx.domain) {
      await recordBrowserTask(ctx, "BLOCKED", approval.id, "Page domain changed since approval was granted.");
      return { status: "BLOCKED", message: `PAGE_CHANGED: current page domain ("${liveDomain}") no longer matches the approved target ("${ctx.domain}") - refusing to proceed without re-approval.`, data: { state: "PAGE_CHANGED" } };
    }
  }

  // 5. Execute - the ONLY point in this file a real provider side-effecting
  // call happens.
  const result = await ctx.run();
  await recordBrowserTask(ctx, result.ok ? "DONE" : "FAILED", ctx.approvalRequestId ?? null, result.ok ? null : result.message);
  if (!result.ok) return { status: "ERROR", message: result.message };
  return { status: "OK", message: result.message, data: { ...result.data, riskCategory: risk.riskCategory } };
}

async function recordBrowserTask(ctx: ActionCtx, status: string, approvalId: string | null, failureReason: string | null | undefined): Promise<void> {
  await prisma.browserTask
    .create({
      data: {
        taskId: ctx.taskId ?? null,
        sessionId: ctx.sessionId,
        domain: ctx.domain || null,
        action: ctx.actionType,
        targetText: ctx.targetText,
        status,
        approvalId,
        failureReason: failureReason ?? null,
        completedAt: status === "DONE" || status === "FAILED" ? new Date() : null,
      },
    })
    .catch(() => undefined);
}

export const browserTool: Tool = createBrowserTool();
