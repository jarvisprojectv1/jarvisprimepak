// core/enforcement - the single choke point every tool execution and agent
// run passes through (Phase 2 / Step 3, parts A/B/C/D combined).
//
// Order of checks ("state gate first, then policy gate", per spec):
//   1. Global system state (PAUSED / EMERGENCY_STOP blocks everything)
//   2. Per-agent pause / per-tool disable
//   3. Rate & concurrency limits
//   4. The Autonomy Policy Engine (core/policy) - BLOCKED short-circuits,
//      NOTIFY still executes but is flagged and creates a Notification
//
// Every outcome (allowed or blocked) is written to the audit log
// (security/audit.ts -> writeAuditLog, which redacts before persisting).
import { log } from "../../security/logger";
import { writeAuditLog } from "../../security/audit";
import { classify } from "../decision_engine";
import { evaluatePolicy, type PolicyContext, type PolicyLevel } from "../policy";
import { getSystemState, isAgentPaused, isToolDisabled } from "../state";
import {
  checkToolRate,
  checkAgentRate,
  acquireAgentSlot,
  releaseAgentSlot,
} from "../limits";
import { notificationService } from "../notifications";
import { SYSTEM_IDENTITY, identityToActorString, type Identity } from "../auth/identity";
import type { ToolResult } from "../../tools/registry";
import type { AgentRunResult } from "../../agents/types";

export interface GateContext {
  kind: "tool" | "agent";
  name: string;
  input?: unknown;
  policyContext?: PolicyContext;
}

export interface GateResult {
  allowed: boolean;
  level: PolicyLevel;
  decision: ReturnType<typeof classify>;
  reason: string;
  concurrencyToken?: string;
}

async function createNotification(title: string, body: string): Promise<void> {
  try {
    // Real Notification Service (core/notifications) - repository -> service
    // -> dispatcher, replacing the old ad-hoc direct prisma.notification.create()
    // call. NOTIFY-level policy outcomes are surfaced as ACTION_REQUIRED so
    // an operator knows a human look may be warranted.
    await notificationService.create({ title, body, type: "ACTION_REQUIRED" });
  } catch (err) {
    log("WARNING", "enforcement.notification_write_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Runs the state gate, then the rate/concurrency checks, then the policy gate. */
export async function evaluateGate(ctx: GateContext): Promise<GateResult> {
  const decisionInput = {
    actionName: ctx.name,
    toolName: ctx.kind === "tool" ? ctx.name : undefined,
    ...(ctx.policyContext ?? {}),
  };
  const fallbackDecision = classify(decisionInput);

  const state = await getSystemState();
  if (state.state === "EMERGENCY_STOP") {
    return {
      allowed: false,
      level: "BLOCKED",
      decision: fallbackDecision,
      reason: `System is in EMERGENCY_STOP${state.reason ? ` (${state.reason})` : ""}.`,
    };
  }
  if (state.state === "PAUSED") {
    return {
      allowed: false,
      level: "BLOCKED",
      decision: fallbackDecision,
      reason: "System is globally PAUSED.",
    };
  }

  if (ctx.kind === "agent" && (await isAgentPaused(ctx.name))) {
    return {
      allowed: false,
      level: "BLOCKED",
      decision: fallbackDecision,
      reason: `Agent "${ctx.name}" is paused.`,
    };
  }
  if (ctx.kind === "tool" && (await isToolDisabled(ctx.name))) {
    return {
      allowed: false,
      level: "BLOCKED",
      decision: fallbackDecision,
      reason: `Tool "${ctx.name}" is disabled.`,
    };
  }

  let concurrencyToken: string | undefined;
  if (ctx.kind === "tool") {
    const rate = await checkToolRate(ctx.name);
    if (!rate.allowed) {
      return { allowed: false, level: "BLOCKED", decision: fallbackDecision, reason: rate.reason! };
    }
  } else {
    const rate = await checkAgentRate(ctx.name);
    if (!rate.allowed) {
      return { allowed: false, level: "BLOCKED", decision: fallbackDecision, reason: rate.reason! };
    }
    const slot = await acquireAgentSlot(ctx.name);
    if (!slot.allowed) {
      return { allowed: false, level: "BLOCKED", decision: fallbackDecision, reason: slot.reason! };
    }
    concurrencyToken = slot.token;
  }

  const policyResult = evaluatePolicy(ctx.name, {
    ...decisionInput,
    agentName: ctx.kind === "agent" ? ctx.name : undefined,
  });

  if (!policyResult.allowed) {
    if (concurrencyToken) releaseAgentSlot(concurrencyToken);
    return {
      allowed: false,
      level: "BLOCKED",
      decision: policyResult.decision,
      reason: policyResult.reason,
    };
  }

  return {
    allowed: true,
    level: policyResult.level,
    decision: policyResult.decision,
    reason: policyResult.reason,
    concurrencyToken,
  };
}

/**
 * Wraps a tool's real `execute` in the full gate. Used by ToolRegistry.register()
 * to mutate the tool object in place, so even a hand-held reference to the
 * original tool object (bypassing the registry) still goes through this gate -
 * there is no unguarded `execute` left to call.
 */
export function guardToolExecution(
  toolName: string,
  original: (input: Record<string, unknown>) => Promise<ToolResult>
): (input: Record<string, unknown>, identity?: Identity) => Promise<ToolResult> {
  return async (input: Record<string, unknown> = {}, identity?: Identity): Promise<ToolResult> => {
    // The audit actor is ALWAYS derived from a validated Identity object,
    // never from a client-supplied string - see core/auth. Callers that
    // don't (or can't) supply one (e.g. the scheduler) are attributed to the
    // fixed, non-human SYSTEM_IDENTITY, never an arbitrary string.
    const actor = identityToActorString(identity ?? SYSTEM_IDENTITY);
    const gate = await evaluateGate({ kind: "tool", name: toolName, input });

    if (!gate.allowed) {
      await writeAuditLog({
        actor,
        action: `tool.blocked:${toolName}`,
        target: toolName,
        meta: {
          input,
          policyLevel: gate.level,
          decisionCategory: gate.decision.category,
          reason: gate.reason,
          success: false,
        },
      });
      log("SECURITY", `tool.blocked:${toolName}`, { reason: gate.reason });
      return { status: "BLOCKED", message: `Blocked: ${gate.reason}` };
    }

    if (gate.level === "NOTIFY") {
      await createNotification(
        `Tool "${toolName}" executed (NOTIFY)`,
        gate.reason
      );
    }

    try {
      const result = await original(input);
      await writeAuditLog({
        actor,
        action: `tool.execute:${toolName}`,
        target: toolName,
        meta: {
          input,
          result,
          policyLevel: gate.level,
          decisionCategory: gate.decision.category,
          success: result.status !== "ERROR",
        },
      });
      return result;
    } catch (err) {
      await writeAuditLog({
        actor,
        action: `tool.execute:${toolName}`,
        target: toolName,
        meta: {
          input,
          error: err instanceof Error ? err.message : String(err),
          policyLevel: gate.level,
          decisionCategory: gate.decision.category,
          success: false,
        },
      });
      throw err;
    }
  };
}

/** Same idea as guardToolExecution, for an agent's `run()`. */
export function guardAgentExecution(
  agentName: string,
  original: (input?: Record<string, unknown>) => Promise<AgentRunResult>
): (input?: Record<string, unknown>, identity?: Identity) => Promise<AgentRunResult> {
  return async (input?: Record<string, unknown>, identity?: Identity): Promise<AgentRunResult> => {
    const actor = identityToActorString(identity ?? SYSTEM_IDENTITY);
    const gate = await evaluateGate({ kind: "agent", name: agentName, input });

    if (!gate.allowed) {
      await writeAuditLog({
        actor,
        action: `agent.blocked:${agentName}`,
        target: agentName,
        meta: {
          input,
          policyLevel: gate.level,
          decisionCategory: gate.decision.category,
          reason: gate.reason,
          success: false,
        },
      });
      log("SECURITY", `agent.blocked:${agentName}`, { reason: gate.reason });
      return { status: "FAILED", summary: `BLOCKED: ${gate.reason}` };
    }

    if (gate.level === "NOTIFY") {
      await createNotification(`Agent "${agentName}" run (NOTIFY)`, gate.reason);
    }

    try {
      const result = await original(input);
      await writeAuditLog({
        actor,
        action: `agent.run:${agentName}`,
        target: agentName,
        meta: {
          input,
          result,
          policyLevel: gate.level,
          decisionCategory: gate.decision.category,
          success: result.status === "SUCCESS" || result.status === "NOT_IMPLEMENTED",
        },
      });
      return result;
    } catch (err) {
      await writeAuditLog({
        actor,
        action: `agent.run:${agentName}`,
        target: agentName,
        meta: {
          input,
          error: err instanceof Error ? err.message : String(err),
          policyLevel: gate.level,
          decisionCategory: gate.decision.category,
          success: false,
        },
      });
      throw err;
    } finally {
      if (gate.concurrencyToken) releaseAgentSlot(gate.concurrencyToken);
    }
  };
}
