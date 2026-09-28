// apps/api/src/middleware/auth.ts - AUTHENTICATION + IDENTITY layer.
//
// Reads a bearer token from the `Authorization: Bearer <token>` header (the
// chosen transport for this phase - documented here rather than a cookie so
// the same session mechanism trivially works for a future non-browser client,
// e.g. a desktop app or CLI, without needing cookie jars). Calls
// validateSession(), attaches the resulting Identity to `req.identity`, and
// rejects with 401 if missing/invalid/expired. `requireRole` is a separate,
// coarser role-gate for routes that only some IdentityKinds may reach at all
// (finer-grained per-action authorization lives in core/authz).
import type { NextFunction, Request, Response } from "express";
import { validateSession } from "../../../../core/auth/session";
import { SYSTEM_IDENTITY, type Identity, type IdentityKind } from "../../../../core/auth/identity";
import { authorize, type AuthzAction } from "../../../../core/authz";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      identity?: Identity;
    }
  }
}

function extractBearerToken(req: Request): string | undefined {
  const header = req.header("authorization") ?? req.header("Authorization");
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : undefined;
}

/** Requires a valid session; attaches req.identity or responds 401. */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = extractBearerToken(req);
  const identity = await validateSession(token);
  if (!identity) {
    res.status(401).json({ error: "Unauthorized: missing or invalid session." });
    return;
  }
  req.identity = identity;
  next();
}

/** Requires the authenticated identity's kind to be one of `kinds`. Use after requireAuth. */
export function requireRole(...kinds: IdentityKind[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.identity) {
      res.status(401).json({ error: "Unauthorized: missing or invalid session." });
      return;
    }
    if (!kinds.includes(req.identity.kind)) {
      res.status(403).json({ error: `Forbidden: requires role ${kinds.join(" or ")}.` });
      return;
    }
    next();
  };
}

/**
 * Requires the authenticated identity to be authorized (core/authz) for
 * `action`. This is the coarse-grained "is this identity allowed to request
 * this kind of action at all" check, run AFTER authentication and BEFORE
 * core/enforcement's state/limits/policy gate. Use after requireAuth.
 */
export function requireAuthz(action: AuthzAction) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = authorize(req.identity, action);
    if (!result.allowed) {
      res.status(403).json({ error: `Forbidden: ${result.reason}` });
      return;
    }
    next();
  };
}

/** Convenience: SYSTEM_IDENTITY, for non-HTTP internal callers (the scheduler, etc). */
export { SYSTEM_IDENTITY };
