// apps/api/tests/testAuth.ts - shared test helper: creates a throwaway OWNER
// user + session for tests that need an authenticated request. Not exported
// from any production module.
import { prisma } from "../../../database/client";
import { hashPassword } from "../../../core/auth/password";
import { createSession } from "../../../core/auth/session";

let counter = 0;

export async function createTestOwner(): Promise<{ userId: string; email: string; token: string }> {
  counter += 1;
  const email = `test-owner-${Date.now()}-${counter}@example.com`;
  const passwordHash = await hashPassword("Str0ngPassw0rd!");
  const user = await prisma.user.create({ data: { email, role: "OWNER", passwordHash } });
  const session = await createSession(user.id);
  return { userId: user.id, email, token: session.token };
}

export function authHeader(token: string): [string, string] {
  return ["Authorization", `Bearer ${token}`];
}
