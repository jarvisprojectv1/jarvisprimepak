// apps/api/src/routes/auth.ts - login/logout/me. /auth/login and /health are
// the only unauthenticated routes in the API (you can't log in if login
// requires auth).
import { Router } from "express";
import { prisma } from "../../../../database/client";
import { verifyPassword } from "../../../../core/auth/password";
import { createSession, revokeSession } from "../../../../core/auth/session";
import { identityFromUser } from "../../../../core/auth/identity";
import { checkLoginRate } from "../../../../core/limits";
import { log } from "../../../../security/logger";
import { requireAuth } from "../middleware/auth";

export const authRouter = Router();

function clientIp(req: { ip?: string; socket?: { remoteAddress?: string } }): string {
  return req.ip ?? req.socket?.remoteAddress ?? "unknown";
}

authRouter.post("/login", async (req, res) => {
  const { email, password } = (req.body ?? {}) as Record<string, unknown>;
  if (typeof email !== "string" || typeof password !== "string" || !email.trim() || !password) {
    // Generic message - never reveal which field was the problem.
    res.status(400).json({ error: "Invalid credentials." });
    return;
  }

  const rateKey = `${email.toLowerCase()}:${clientIp(req)}`;
  const rate = await checkLoginRate(rateKey);
  if (!rate.allowed) {
    res.status(429).json({ error: "Too many login attempts. Try again shortly." });
    return;
  }

  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });

  // Always run a bcrypt comparison, even for an unknown user, against a
  // fixed dummy hash - this keeps the response time (and code path)
  // indistinguishable between "no such user" and "wrong password", so
  // neither timing nor response shape reveals which one failed.
  const DUMMY_HASH = "$2b$12$CwTycUXWue0Thq9StjUM0uJ8O.tk6cJUOOQ7iZBb1V.PSKgLxJP8y";
  const hashToCheck = user?.passwordHash ?? DUMMY_HASH;
  const valid = await verifyPassword(password, hashToCheck);

  if (!user || !user.passwordHash || !valid) {
    log("SECURITY", "auth.login_failed", { email: email.toLowerCase() });
    res.status(401).json({ error: "Invalid credentials." });
    return;
  }

  // The identity a login grants is derived the SAME way validateSession()
  // derives it later (from the User row's real `role`/`active` columns) -
  // never hardcoded. An inactive account or a corrupted/unrecognized role
  // fails closed as a generic "invalid credentials", not a different error,
  // so login never reveals account state to an unauthenticated caller.
  const identity = identityFromUser(user);
  if (!identity) {
    log("SECURITY", "auth.login_rejected_invalid_role_or_inactive", {
      userId: user.id,
      role: user.role,
      active: user.active,
    });
    res.status(401).json({ error: "Invalid credentials." });
    return;
  }

  const session = await createSession(user.id);
  log("SECURITY", "auth.login_success", { userId: user.id, role: identity.kind });
  res.json({
    token: session.token,
    expiresAt: session.expiresAt,
    identity,
  });
});

authRouter.post("/logout", requireAuth, async (req, res) => {
  const header = req.header("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (match) {
    await revokeSession(match[1]);
  }
  res.json({ ok: true });
});

authRouter.get("/me", requireAuth, (req, res) => {
  res.json({ identity: req.identity });
});
