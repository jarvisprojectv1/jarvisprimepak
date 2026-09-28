import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword } from "./password";
import { createSession, validateSession, revokeSession, revokeAllSessionsForUser } from "./session";
import { prisma } from "../../database/client";

async function makeUser(email: string, role = "OWNER", active = true) {
  const passwordHash = await hashPassword("correct-horse-battery-staple");
  return prisma.user.create({ data: { email, role, passwordHash, active } });
}

describe("core/auth/password", () => {
  it("hashes and verifies a password", async () => {
    const hash = await hashPassword("hunter2");
    expect(hash).not.toBe("hunter2");
    expect(await verifyPassword("hunter2", hash)).toBe(true);
    expect(await verifyPassword("wrong", hash)).toBe(false);
  });
});

describe("core/auth/session", () => {
  it("creates a session and validates it back to the right identity", async () => {
    const user = await makeUser(`session-${Date.now()}@example.com`);
    const created = await createSession(user.id);
    expect(created.token).toBeTruthy();

    const identity = await validateSession(created.token);
    expect(identity).not.toBeNull();
    expect(identity?.kind).toBe("OWNER");
    expect(identity?.id).toBe(user.id);
  });

  it("never persists the raw token - only a hash", async () => {
    const user = await makeUser(`session-hash-${Date.now()}@example.com`);
    const created = await createSession(user.id);
    const row = await prisma.session.findFirst({ where: { userId: user.id }, orderBy: { createdAt: "desc" } });
    expect(row?.tokenHash).not.toBe(created.token);
  });

  it("rejects an unknown token", async () => {
    const identity = await validateSession("not-a-real-token");
    expect(identity).toBeNull();
  });

  it("rejects an expired session", async () => {
    const user = await makeUser(`expired-${Date.now()}@example.com`);
    const created = await createSession(user.id);
    // Force it into the past.
    await prisma.session.updateMany({
      where: { userId: user.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const identity = await validateSession(created.token);
    expect(identity).toBeNull();
  });

  it("revokeSession (logout) invalidates the token immediately", async () => {
    const user = await makeUser(`logout-${Date.now()}@example.com`);
    const created = await createSession(user.id);
    expect(await validateSession(created.token)).not.toBeNull();
    await revokeSession(created.token);
    expect(await validateSession(created.token)).toBeNull();
  });

  it("revokeAllSessionsForUser invalidates every active session", async () => {
    const user = await makeUser(`revoke-all-${Date.now()}@example.com`);
    const s1 = await createSession(user.id);
    const s2 = await createSession(user.id);
    await revokeAllSessionsForUser(user.id);
    expect(await validateSession(s1.token)).toBeNull();
    expect(await validateSession(s2.token)).toBeNull();
  });

  it("derives the Identity kind from the User row's role - not hardcoded to OWNER", async () => {
    for (const role of ["OWNER", "SYSTEM", "AGENT", "SERVICE"] as const) {
      const user = await makeUser(`role-${role}-${Date.now()}@example.com`, role);
      const created = await createSession(user.id);
      const identity = await validateSession(created.token);
      expect(identity).not.toBeNull();
      expect(identity?.kind).toBe(role);
      expect(identity?.id).toBe(user.id);
      expect(identity?.label).toBe(`${role.toLowerCase()}:${user.email}`);
    }
  });

  it("fails closed (returns null, never OWNER) for an unrecognized role", async () => {
    const user = await makeUser(`bad-role-${Date.now()}@example.com`, "SUPERADMIN");
    const created = await createSession(user.id);
    const identity = await validateSession(created.token);
    expect(identity).toBeNull();
  });

  it("fails closed for an inactive user even with a valid, unexpired token", async () => {
    const user = await makeUser(`inactive-${Date.now()}@example.com`, "OWNER", false);
    const created = await createSession(user.id);
    const identity = await validateSession(created.token);
    expect(identity).toBeNull();
  });

  it("re-derives the role from the database on every call - changing User.role takes effect immediately, no cache", async () => {
    const user = await makeUser(`role-flip-unit-${Date.now()}@example.com`, "AGENT");
    const created = await createSession(user.id);

    const first = await validateSession(created.token);
    expect(first?.kind).toBe("AGENT");

    await prisma.user.update({ where: { id: user.id }, data: { role: "OWNER" } });

    const second = await validateSession(created.token);
    expect(second?.kind).toBe("OWNER");
  });

  it("a revoked session remains rejected regardless of the user's role", async () => {
    const user = await makeUser(`revoked-role-${Date.now()}@example.com`, "SYSTEM");
    const created = await createSession(user.id);
    await revokeSession(created.token);
    expect(await validateSession(created.token)).toBeNull();
  });
});
