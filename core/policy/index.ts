// core/policy - the Autonomy Policy Engine (Phase 2 / Step 3).
//
// This module does NOT duplicate core/decision_engine's classify() logic. It
// calls classify() to get a DecisionCategory, then maps/combines that with a
// static policy table into one of three PolicyLevels:
//
//   AUTONOMOUS - known-safe action, executes with no notification
//   NOTIFY     - executes, but a Notification is created and the audit entry
//                is flagged (external comms, uncertain/failed actions,
//                decisions needing owner info, significant business events)
//   BLOCKED    - never executes, no exceptions
//
// The BLOCKED list is intentionally hardcoded in this file, not read from the
// `settings` table or any other runtime-configurable source, so neither an
// agent nor a bad config row can ever flip a blocked action to allowed. This
// is enforced by construction: `isHardBlocked()` takes no config input at
// all - only the action/tool/agent name and context flags baked into the
// call itself.
import { classify, type Decision, type DecisionInput } from "../decision_engine";

export type PolicyLevel = "AUTONOMOUS" | "NOTIFY" | "BLOCKED";

export interface PolicyContext extends DecisionInput {
  /** "tool" | "agent" | undefined (generic action, e.g. a chat-level action) */
  kind?: "tool" | "agent";
  agentName?: string;
}

export interface PolicyResult {
  level: PolicyLevel;
  decision: Decision;
  allowed: boolean;
  reason: string;
}

// ---------------------------------------------------------------------------
// Hardcoded, non-configurable BLOCKED list (spec: "must not be overridable by
// any config/settings row"). Matched case-insensitively as substrings against
// the action/tool/agent name, so both a canonical action id (e.g.
// "financial.transaction") and a descriptive one (e.g. "wire-transfer-funds")
// are caught.
// ---------------------------------------------------------------------------
const BLOCKED_KEYWORDS = [
  // financial transactions / live broker trading
  "financial.transaction",
  "transfer_funds",
  "wire_transfer",
  "wire-transfer",
  "money_movement",
  "broker",
  "trading.execute",
  "place_trade",
  "buy_stock",
  "sell_stock",
  // password / security changes
  "password_change",
  "change_password",
  "security.password",
  "reset_credentials",
  "mfa_disable",
  "disable_2fa",
  // destructive operations (data deletion)
  "data.delete",
  "delete_database",
  "drop_table",
  "wipe_data",
  "purge_data",
  "destroy_data",
  // legal commitments
  "legal.commit",
  "sign_contract",
  "legal_commitment",
  "accept_legal_terms",
  // account deletion
  "account.delete",
  "delete_account",
  "close_account",
  // security-control bypasses
  "security.bypass",
  "bypass_security",
  "disable_audit",
  "disable_firewall",
  "disable_2fa",
] as const;

function isHardBlocked(...names: (string | undefined)[]): string | undefined {
  const haystack = names
    .filter((n): n is string => Boolean(n))
    .join(" ")
    .toLowerCase();
  if (!haystack) return undefined;
  return BLOCKED_KEYWORDS.find((kw) => haystack.includes(kw));
}

// ---------------------------------------------------------------------------
// Known-safe (AUTONOMOUS) and known-external/uncertain (NOTIFY) action/tool/
// agent names. This table is just a default mapping used to *lift* a routine
// or configured-business action into a level; it can never move something
// into BLOCKED (only isHardBlocked() can do that) and it never overrides an
// explicit BLOCKED hit above.
// ---------------------------------------------------------------------------
const AUTONOMOUS_NAMES = new Set([
  "research", // research agent / research actions
  "crm", // CRM read/update agent
  "task", // task agent (wraps core/planner - internal task bookkeeping)
  "system", // system agent (read-only health/state queries)
  "files", // internal data organization (sandboxed)
  "web", // read-only research/search
  "reports.generate",
  "reports.scheduled",
  "crm.read",
  "crm.update",
  "maintenance.non_destructive",
  "data.organize",
]);

const NOTIFY_NAMES = new Set([
  "email", // external communication
  "calendar", // touches external calendar invitees
  "voice", // telephony / calling
  "browser", // uncertain / open-ended web actions
  "computer", // uncertain / open-ended desktop actions
]);

function tableLevelFor(name: string | undefined): PolicyLevel | undefined {
  if (!name) return undefined;
  if (AUTONOMOUS_NAMES.has(name)) return "AUTONOMOUS";
  if (NOTIFY_NAMES.has(name)) return "NOTIFY";
  return undefined;
}

/**
 * Evaluates the policy for a named action. `actionName` is typically a tool
 * name, an agent name, or a canonical action id (e.g. "financial.transaction")
 * used in tests. `context` carries the same fields core/decision_engine's
 * classify() understands, plus optional `kind`/`agentName` for table lookups.
 */
export function evaluatePolicy(
  actionName: string,
  context: PolicyContext = {}
): PolicyResult {
  const blockedMatch = isHardBlocked(actionName, context.toolName, context.agentName);
  const decision = classify({ ...context, actionName, toolName: context.toolName });

  if (blockedMatch) {
    return {
      level: "BLOCKED",
      decision,
      allowed: false,
      reason: `Hardcoded policy block: action matches non-overridable blocked pattern "${blockedMatch}".`,
    };
  }

  const tableLevel = tableLevelFor(actionName) ?? tableLevelFor(context.toolName) ?? tableLevelFor(context.agentName);

  let level: PolicyLevel;
  let reason: string;

  switch (decision.category) {
    case "ROUTINE":
      level = tableLevel ?? "AUTONOMOUS";
      reason = tableLevel
        ? `ROUTINE action; policy table says ${tableLevel}.`
        : "ROUTINE action with no risk factors; autonomous by default.";
      break;
    case "CONFIGURED_BUSINESS_ACTION":
      // Safe default: only actions explicitly known-safe run autonomously;
      // everything else configured-but-unclassified is surfaced via NOTIFY.
      level = tableLevel ?? "NOTIFY";
      reason = tableLevel
        ? `Configured business action; policy table says ${tableLevel}.`
        : "Configured business action with no explicit safe-list entry; notifying by default.";
      break;
    case "INFORMATION_MISSING":
      level = "NOTIFY";
      reason = "Decision needs owner-supplied information; executing (if applicable) and notifying.";
      break;
    case "HIGH_IMPACT":
      level = "NOTIFY";
      reason = "High-impact/irreversible action; executing and notifying so a human can review.";
      break;
    case "CRITICAL_SYSTEM_FAILURE":
      level = "NOTIFY";
      reason = "Critical system failure reported; notifying immediately.";
      break;
    default:
      level = "NOTIFY";
      reason = "Unrecognized decision category; notifying as a safe default.";
  }

  return { level, decision, allowed: true, reason };
}
