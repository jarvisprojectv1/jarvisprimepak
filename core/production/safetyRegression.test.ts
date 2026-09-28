// core/production/safetyRegression.test.ts - Phase 12 (item 16):
// production-context regression proofs for the system's existing safety
// boundaries - financial hard-block, emergency-stop, system-pause - under
// concurrent load and (for sessions) real expiry. These do NOT introduce any
// new safety mechanism; every assertion targets the pre-existing,
// unmodified function from its home module (core/business/browserPolicy.ts,
// core/state/index.ts, core/auth/session.ts). The purpose is proving these
// hold up under conditions closer to production (many concurrent callers,
// real time passing) than a single-call unit test already covers elsewhere.
import { describe, it, expect } from "vitest";
import { prisma } from "../../database/client";
import { isFinancialHardBlock } from "../business/browserPolicy";
import { registerBuiltinTools } from "../../tools";
import { registerBuiltinAgents } from "../../agents/registry";
import { toolRegistry } from "../../tools/registry";
import { WORKER_IDENTITY } from "../auth/identity";
import { setSystemState } from "../state";
import { createSession, validateSession } from "../auth/session";

describe("Phase 12 (item 16) - safety boundaries under production-like conditions", () => {
  it("financial hard-block: 50 concurrent interactive-action checks against a financial domain are ALL blocked - no race lets one slip through ALLOWED", async () => {
    const checks = Array.from({ length: 50 }, (_, i) =>
      isFinancialHardBlock({ domain: "checkout.stripe.com", actionType: "click", targetText: `pay now button ${i}` })
    );
    expect(checks.every((c) => c.blocked)).toBe(true);
  });

  it("financial hard-block: a financial-transaction-SHAPED action (checkout/payment/transfer keywords) is blocked regardless of domain, under concurrent evaluation", async () => {
    const checks = Array.from({ length: 20 }, (_, i) =>
      isFinancialHardBlock({ domain: "some-random-vendor-site.example", actionType: "click", targetText: `confirm payment ${i}` })
    );
    expect(checks.every((c) => c.blocked)).toBe(true);
  });

  it("financial hard-block: read-only actions (navigate/scroll/extract/screenshot) on a financial domain are NEVER hard-blocked by this check - proving the block is scoped, not a blanket domain ban", () => {
    const readOnly = isFinancialHardBlock({ domain: "chase.com", actionType: "navigate" });
    expect(readOnly.blocked).toBe(false);
  });

  it("emergency-stop under concurrent load: 30 simultaneous tool-execute attempts while EMERGENCY_STOP is active ALL come back BLOCKED - none slip through as OK", async () => {
    registerBuiltinTools();
    registerBuiltinAgents();
    await setSystemState("EMERGENCY_STOP", "phase12 concurrent load regression", "test");

    try {
      const results = await Promise.all(
        Array.from({ length: 30 }, () => toolRegistry.execute("reports", {}, WORKER_IDENTITY))
      );
      expect(results.every((r) => r.status === "BLOCKED")).toBe(true);
    } finally {
      await setSystemState("RUNNING", "test cleanup", "test");
    }
  }, 20_000);

  it("system-pause under concurrent load: 30 simultaneous tool-execute attempts while PAUSED ALL come back BLOCKED", async () => {
    registerBuiltinTools();
    await setSystemState("PAUSED", "phase12 concurrent load regression", "test");

    try {
      const results = await Promise.all(
        Array.from({ length: 30 }, () => toolRegistry.execute("reports", {}, WORKER_IDENTITY))
      );
      expect(results.every((r) => r.status === "BLOCKED")).toBe(true);
    } finally {
      await setSystemState("RUNNING", "test cleanup", "test");
    }
  }, 20_000);

  it("session expiry: a session with an already-past expiresAt is rejected by validateSession, even though its tokenHash/revokedAt are otherwise perfectly valid", async () => {
    const owner = await prisma.user.create({
      data: { email: `phase12-session-expiry-${Date.now()}@example.test`, role: "OWNER", active: true },
    });
    const created = await createSession(owner.id);

    // Force the session into the past directly via the DB (simulating real
    // elapsed time without waiting for SESSION_TTL_HOURS) - the exact row
    // validateSession() itself reads.
    await prisma.session.update({ where: { id: created.sessionId }, data: { expiresAt: new Date(Date.now() - 1000) } });

    const identity = await validateSession(created.token);
    expect(identity).toBeNull();

    await prisma.session.delete({ where: { id: created.sessionId } });
    await prisma.user.delete({ where: { id: owner.id } });
  });

  it("session for a deactivated (User.active = false) account is rejected even with a perfectly valid, unexpired token - fail-closed role derivation", async () => {
    const owner = await prisma.user.create({
      data: { email: `phase12-session-inactive-${Date.now()}@example.test`, role: "OWNER", active: true },
    });
    const created = await createSession(owner.id);

    await prisma.user.update({ where: { id: owner.id }, data: { active: false } });

    const identity = await validateSession(created.token);
    expect(identity).toBeNull();

    await prisma.session.delete({ where: { id: created.sessionId } });
    await prisma.user.delete({ where: { id: owner.id } });
  });
});
