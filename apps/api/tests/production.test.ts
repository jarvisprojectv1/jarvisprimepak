// apps/api/tests/production.test.ts - Phase 12 (items 6, 7, 11): API-level
// proofs for the new liveness/readiness endpoints, the request-id
// middleware, and webhook rate limiting.
import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";

describe("Phase 12 - production integration API surface", () => {
  it("GET /health/live responds instantly with no DB dependency", async () => {
    const app = createApp();
    const res = await request(app).get("/health/live");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("HEALTHY");
  });

  it("GET /health/ready reports database connectivity and provider configuration state, unauthenticated", async () => {
    const app = createApp();
    const res = await request(app).get("/health/ready");
    expect(res.status).toBe(200);
    expect(res.body.ready).toBe(true);
    expect(res.body.database.status).toBe("HEALTHY");
    expect(res.body.providers).toBeDefined();
    expect(Array.isArray(res.body.providers.configurationRequired)).toBe(true);
  });

  it("every response carries an X-Request-Id header, generated when the client doesn't supply one", async () => {
    const app = createApp();
    const res = await request(app).get("/health/live");
    expect(res.headers["x-request-id"]).toBeTruthy();
    expect(res.headers["x-request-id"].length).toBeGreaterThan(10);
  });

  it("an incoming X-Request-Id is echoed back verbatim (distributed trace correlation)", async () => {
    const app = createApp();
    const res = await request(app).get("/health/live").set("X-Request-Id", "phase12-test-trace-id-123");
    expect(res.headers["x-request-id"]).toBe("phase12-test-trace-id-123");
  });

  it("a 404 still carries a request id (set before routing, not inside a specific route handler)", async () => {
    const app = createApp();
    const res = await request(app).get("/this-route-does-not-exist");
    expect(res.status).toBe(404);
    expect(res.headers["x-request-id"]).toBeTruthy();
  });

  it("HTTPS enforcement is OFF by default (FORCE_HTTPS unset) - a plain HTTP-shaped request still succeeds, since most deployments terminate TLS at a reverse proxy in front of this process", async () => {
    delete process.env.FORCE_HTTPS;
    const app = createApp();
    const res = await request(app).get("/health/live");
    expect(res.status).toBe(200);
  });

  it("HTTPS enforcement, when explicitly turned on (FORCE_HTTPS=true) and TRUST_PROXY_HOPS configured, rejects a request whose forwarded proto is not https", async () => {
    const savedForce = process.env.FORCE_HTTPS;
    const savedHops = process.env.TRUST_PROXY_HOPS;
    process.env.FORCE_HTTPS = "true";
    process.env.TRUST_PROXY_HOPS = "1";
    try {
      const app = createApp();
      const insecure = await request(app).get("/health/live").set("X-Forwarded-Proto", "http").set("X-Forwarded-For", "1.2.3.4");
      expect(insecure.status).toBe(403);

      const secure = await request(app).get("/health/live").set("X-Forwarded-Proto", "https").set("X-Forwarded-For", "1.2.3.4");
      expect(secure.status).toBe(200);
    } finally {
      if (savedForce === undefined) delete process.env.FORCE_HTTPS;
      else process.env.FORCE_HTTPS = savedForce;
      if (savedHops === undefined) delete process.env.TRUST_PROXY_HOPS;
      else process.env.TRUST_PROXY_HOPS = savedHops;
    }
  });

  it("webhook rate limiting: a burst well past the per-minute cap on POST /webhooks/whatsapp eventually returns 429, not an unbounded stream of 401/503s", async () => {
    const app = createApp();
    const results: number[] = [];
    // 125 requests > the 120/min cap configured in
    // apps/api/src/routes/webhooks.ts. Each individual request is otherwise
    // invalid (no signature/secret configured in this test env) and would
    // normally 401/503 - the point here is proving SOME of them get
    // rate-limited (429) before ever reaching that logic, not re-testing
    // signature verification (already covered by whatsapp/voice webhook
    // suites elsewhere).
    for (let i = 0; i < 125; i++) {
      const res = await request(app).post("/webhooks/whatsapp").send({});
      results.push(res.status);
    }
    expect(results).toContain(429);
  }, 30_000);
});
