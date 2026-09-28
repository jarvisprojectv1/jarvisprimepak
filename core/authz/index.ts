// core/authz - Owner Command Authority (Phase 3 / Identity & Events).
//
// This module is DELIBERATELY separate from core/policy. The two answer
// different questions:
//
//   core/authz   - "is THIS IDENTITY allowed to REQUEST this kind of action
//                   at all?" A coarse, identity-based gate (role-based).
//   core/policy  - "given the action's CONTENT, should it run autonomously,
//                   notify, or be blocked?" (AUTONOMOUS/NOTIFY/BLOCKED,
//                   wraps core/decision_engine.classify()).
//
// Full chain: AUTHENTICATION -> IDENTITY -> AUTHORIZATION (this module) ->
// AUTONOMY POLICY (core/policy, inside core/enforcement) -> RATE/CONCURRENCY
// -> EXECUTION -> AUDIT. Authorization runs BEFORE core/enforcement's gate.
// Being authorized to *request* something (e.g. OWNER triggering emergency
// stop) never bypasses a hardcoded BLOCKED policy outcome - the two layers
// are independent and both must allow an action for it to execute.
import type { Identity, IdentityKind } from "../auth/identity";

export type AuthzAction =
  | "system.emergency_stop"
  | "system.pause"
  | "system.resume"
  | "system.agent_pause"
  | "system.agent_resume"
  | "system.tool_disable"
  | "system.tool_enable"
  | "agent.run"
  | "tool.execute"
  | "task.write"
  | "task.read"
  | "memory.write"
  | "memory.read"
  | "notification.read"
  | "notification.write"
  | "system.health.read"
  | "chat.use"
  | "brain.read";

export interface AuthzResult {
  allowed: boolean;
  reason: string;
}

// Coarse role -> allowed-actions table. Any action not listed for a role is
// denied by default (fail closed). This is intentionally simple: a real
// permission matrix (per-tool/per-agent grants for AGENT/SERVICE identities)
// is future work - see docs/PHASE3_IDENTITY_EVENTS.md limitations.
const ROLE_ACTIONS: Record<IdentityKind, Set<AuthzAction> | "ALL"> = {
  OWNER: "ALL",
  SYSTEM: new Set<AuthzAction>([
    "agent.run",
    "tool.execute",
    "task.write",
    "task.read",
    "memory.write",
    "memory.read",
    "notification.write",
    "notification.read",
    "system.health.read",
    "brain.read",
  ]),
  AGENT: new Set<AuthzAction>(["tool.execute", "memory.read", "memory.write", "task.write", "task.read"]),
  SERVICE: new Set<AuthzAction>(["tool.execute", "memory.read", "task.read"]),
};

const ALL_ACTIONS: AuthzAction[] = [
  "system.emergency_stop",
  "system.pause",
  "system.resume",
  "system.agent_pause",
  "system.agent_resume",
  "system.tool_disable",
  "system.tool_enable",
  "agent.run",
  "tool.execute",
  "task.write",
  "task.read",
  "memory.write",
  "memory.read",
  "notification.read",
  "notification.write",
  "system.health.read",
  "chat.use",
  "brain.read",
];

/**
 * Checks whether `identity` is authorized to request `action` at all. This
 * is coarser than core/policy - it does not look at the action's content or
 * risk level, only at who is asking and what kind of thing they're asking
 * to do.
 */
export function authorize(identity: Identity | null | undefined, action: AuthzAction): AuthzResult {
  if (!identity) {
    return { allowed: false, reason: "No authenticated identity." };
  }
  const table = ROLE_ACTIONS[identity.kind];
  if (table === "ALL") {
    return { allowed: true, reason: `${identity.kind} is authorized for all actions.` };
  }
  if (table.has(action)) {
    return { allowed: true, reason: `${identity.kind} is authorized for "${action}".` };
  }
  return { allowed: false, reason: `${identity.kind} is not authorized for "${action}".` };
}

export function isKnownAction(action: string): action is AuthzAction {
  return (ALL_ACTIONS as string[]).includes(action);
}
