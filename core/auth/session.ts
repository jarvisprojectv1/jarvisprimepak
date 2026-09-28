// core/auth/session.ts - server-side, revocable session tokens (Phase 3).
//
// The raw token is a cryptographically random string, returned to the
// caller exactly once (at creation). Only a SHA-256 hash of it is stored in
// the `sessions` table (Session.tokenHash), so a leaked DB row alone can
// never be replayed as a valid session, and the raw token is never logged
// (redact() also treats "token"/"tokenHash" as secret key names).
//
// SHA-256 (not bcrypt) is used for the token hash deliberately: sessions are
// looked up by exact hash equality on every request, which requires a fast,
// deterministic digest, not a slow, salted one - the token itself already
// has 256 bits of entropy from crypto.randomBytes, so a fast hash is safe
// here (this is the standard pattern for opaque session/API tokens,
// distinct from password hashing which must be slow and salted).
import crypto from "node:crypto";
import { prisma } from "../../database/client";
import { log } from "../../security/logger";
import type { Identity } from "./identity";
import { identityFromUser } from "./identity";

const DEFAULT_SESSION_TTL_HOURS = 24 * 7; // 7 days

function sessionTtlHours(): number {
  const raw = process.env.SESSION_TTL_HOURS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SESSION_TTL_HOURS;
}

function hashToken(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

export interface CreatedSession {
  token: string; // the RAW token - return this to the client, never persist it
  sessionId: string;
  expiresAt: Date;
}

/** Creates a new session for `userId` and returns the raw token exactly once. */
export async function createSession(userId: string): Promise<CreatedSession> {
  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + sessionTtlHours() * 60 * 60 * 1000);

  const row = await prisma.session.create({
    data: { userId, tokenHash, expiresAt },
  });

  log("SECURITY", "auth.session_created", { userId, sessionId: row.id });
  return { token: rawToken, sessionId: row.id, expiresAt };
}

/**
 * Validates a raw token: looks it up by its hash, checks it hasn't been
 * revoked or expired, confirms the owning User still exists and is active,
 * then derives the Identity from that User's stored `role` column (the
 * authoritative source - see identityFromUser). Updates lastUsedAt and
 * returns the Identity, or null if the token is missing/invalid/expired/
 * revoked, the user is inactive, or the stored role is not a recognized
 * IdentityKind. The role is re-read from the database on every call (the
 * session itself carries no cached identity), so changing User.role takes
 * effect on the very next request - there is no identity cache to go stale.
 * Never throws on a bad token/role; either is just "not authenticated".
 */
export async function validateSession(rawToken: string | undefined | null): Promise<Identity | null> {
  if (!rawToken || typeof rawToken !== "string" || rawToken.trim() === "") return null;

  const tokenHash = hashToken(rawToken);
  const session = await prisma.session.findUnique({
    where: { tokenHash },
    include: { user: true },
  });

  if (!session) return null;
  if (session.revokedAt) return null;
  if (session.expiresAt.getTime() <= Date.now()) return null;
  if (!session.user) return null;

  const identity = identityFromUser(session.user);
  if (!identity) {
    log("SECURITY", "auth.session_rejected_invalid_role_or_inactive", {
      userId: session.user.id,
      role: session.user.role,
      active: session.user.active,
    });
    return null;
  }

  await prisma.session.update({
    where: { id: session.id },
    data: { lastUsedAt: new Date() },
  });

  return identity;
}

/** Revokes the session identified by its raw token (logout). Idempotent - revoking an already-revoked/unknown token is a no-op. */
export async function revokeSession(rawToken: string): Promise<void> {
  const tokenHash = hashToken(rawToken);
  const session = await prisma.session.findUnique({ where: { tokenHash } });
  if (!session || session.revokedAt) return;
  await prisma.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
  log("SECURITY", "auth.session_revoked", { sessionId: session.id, userId: session.userId });
}

/** Revokes every active session for a user (e.g. on password change or account lock). */
export async function revokeAllSessionsForUser(userId: string): Promise<number> {
  const result = await prisma.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  log("SECURITY", "auth.all_sessions_revoked", { userId, count: result.count });
  return result.count;
}
