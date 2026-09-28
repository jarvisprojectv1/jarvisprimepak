// core/auth/identity.ts - the shared Identity type used everywhere downstream
// (authorization, enforcement, audit) instead of a bare string.
//
// Channel-agnostic by design: nothing here assumes the identity came from an
// HTTP request. A Session (see core/auth/session.ts) can be created and
// validated the exact same way by a future voice or desktop client. A future
// `kind: "OWNER"` with a voice-biometric-verified session is a forward
// extension point, NOT implemented in this phase - see the comment on
// `IdentityKind` below.
export type IdentityKind = "OWNER" | "SYSTEM" | "AGENT" | "SERVICE";

export const IDENTITY_KINDS: readonly IdentityKind[] = ["OWNER", "SYSTEM", "AGENT", "SERVICE"];

/** Strict, exhaustive role check. Never treat an unrecognized string as any valid kind - fail closed. */
export function isIdentityKind(value: unknown): value is IdentityKind {
  return typeof value === "string" && (IDENTITY_KINDS as string[]).includes(value);
}

export interface Identity {
  kind: IdentityKind;
  /** Stable id: a User.id for OWNER, or a fixed code-defined id for SYSTEM/AGENT/SERVICE. */
  id: string;
  /** Human-readable label for logs/audit entries, e.g. "owner:jane@example.com" or "system:scheduler". */
  label: string;
}

// The fixed, non-human identity JARVIS's own internal/scheduled actions run
// as. Replaces the old hardcoded `actor: "system"` string throughout
// core/enforcement and security/audit with a real, typed identity.
export const SYSTEM_IDENTITY: Identity = {
  kind: "SYSTEM",
  id: "system",
  label: "system:jarvis-core",
};

/**
 * Constructs a fixed, code-defined AGENT identity for an internal caller
 * (e.g. an agent invoking a tool on its own behalf). AGENT identities are
 * NOT created via any HTTP endpoint - they exist only as compile-time
 * constants callers construct explicitly, so nothing external can mint one.
 */
export function agentIdentity(agentName: string): Identity {
  return { kind: "AGENT", id: `agent:${agentName}`, label: `agent:${agentName}` };
}

/**
 * Constructs a fixed, code-defined SERVICE identity for a future service-to-
 * service caller (e.g. an internal cron/worker process). Same non-HTTP-
 * mintable guarantee as agentIdentity().
 */
export function serviceIdentity(serviceName: string): Identity {
  return { kind: "SERVICE", id: `service:${serviceName}`, label: `service:${serviceName}` };
}

/** Constructs an OWNER identity from a real, validated User row. Never construct this from client input alone. */
export function ownerIdentity(userId: string, email: string): Identity {
  return { kind: "OWNER", id: userId, label: `owner:${email}` };
}

/**
 * Derives the Identity a session should resolve to from a real, validated
 * User row - using that row's stored `role` column as the sole source of
 * truth for `kind`. This is the ONLY function core/auth/session.ts may use
 * to turn a User row into an Identity; it must never hardcode a kind.
 *
 * Fails closed: returns null (never a fallback identity, never OWNER by
 * default) if the row's `role` is missing/unrecognized or the account is
 * inactive. Callers must treat null exactly like "no valid session".
 */
export function identityFromUser(user: {
  id: string;
  email: string;
  role: unknown;
  active?: boolean;
}): Identity | null {
  if (user.active === false) return null;
  if (!isIdentityKind(user.role)) return null;

  const label = `${user.role.toLowerCase()}:${user.email}`;
  return { kind: user.role, id: user.id, label };
}

/** Renders an Identity to the flat string stored in AuditLog.actor / logs. Never round-tripped back into an Identity. */
export function identityToActorString(identity: Identity): string {
  return identity.label;
}

/**
 * Phase 5 (Autonomous Worker): the fixed, non-human identity the standing
 * worker loop runs its actions as. A dedicated SERVICE identity (rather than
 * reusing SYSTEM_IDENTITY) so the audit trail can tell "the scheduler/boot
 * code did this" apart from "the autonomous worker loop did this" - both are
 * internal, non-HTTP callers with the same non-bypass guarantee
 * (serviceIdentity()/SYSTEM_IDENTITY are never mintable via any HTTP
 * endpoint). This does NOT grant the worker any capability the enforcement
 * gate wouldn't otherwise allow - core/enforcement and core/authz apply to it
 * exactly as they would to any other caller.
 */
export const WORKER_IDENTITY: Identity = serviceIdentity("worker");
