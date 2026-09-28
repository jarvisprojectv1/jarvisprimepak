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

/** Renders an Identity to the flat string stored in AuditLog.actor / logs. Never round-tripped back into an Identity. */
export function identityToActorString(identity: Identity): string {
  return identity.label;
}
