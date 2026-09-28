import { describe, it, expect, afterEach } from "vitest";
import { webFetchTool } from "./fetchTool";
import { startTestServer, type TestServerHandle } from "./testServer";
import { __resetResearchLimitsForTests } from "../../core/research/limits";

let handle: TestServerHandle | undefined;

afterEach(async () => {
  await handle?.close();
  handle = undefined;
  __resetResearchLimitsForTests();
});

describe("tools/web/fetchTool - WebFetchTool (against a local mock HTTP server)", () => {
  it("fetches an HTML page and extracts title + text, stripping scripts/styles", async () => {
    handle = await startTestServer({
      "/page": (_req, res) => {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html><head><title>Hello Page</title><style>.x{color:red}</style></head><body><script>evil()</script><p>Real content here.</p></body></html>");
      },
    });
    const result = await webFetchTool.execute({ url: `${handle.url}/page` });
    expect(result.status).toBe("OK");
    const data = result.data as any;
    expect(data.title).toBe("Hello Page");
    expect(data.text).toContain("Real content here.");
    expect(data.text).not.toContain("evil()");
    expect(data.text).not.toContain("color:red");
  });

  it("F: rejects an invalid/disallowed-protocol URL before ever attempting a fetch", async () => {
    const result = await webFetchTool.execute({ url: "file:///etc/passwd" });
    expect(result.status).toBe("ERROR");
    expect(result.message).toMatch(/protocol/i);
  });

  it("F: rejects a malformed URL", async () => {
    const result = await webFetchTool.execute({ url: "not a url" });
    expect(result.status).toBe("ERROR");
  });

  it("E: reports a timeout honestly rather than hanging or fabricating a result", async () => {
    handle = await startTestServer({
      "/slow": (_req, res) => {
        // Never respond - the tool's own timeout must fire.
        void res;
      },
    });
    process.env.WEB_FETCH_TIMEOUT_MS = "300";
    try {
      const result = await webFetchTool.execute({ url: `${handle.url}/slow` });
      expect(result.status).toBe("ERROR");
      expect(result.message).toMatch(/timed out/i);
    } finally {
      delete process.env.WEB_FETCH_TIMEOUT_MS;
    }
  }, 10000);

  it("G: rejects once the redirect limit is exceeded", async () => {
    handle = await startTestServer({
      "/r0": (_req, res) => res.writeHead(302, { location: "/r1" }).end(),
      "/r1": (_req, res) => res.writeHead(302, { location: "/r2" }).end(),
      "/r2": (_req, res) => res.writeHead(302, { location: "/r3" }).end(),
      "/r3": (_req, res) => res.writeHead(302, { location: "/r4" }).end(),
      "/r4": (_req, res) => res.writeHead(302, { location: "/r5" }).end(),
      "/r5": (_req, res) => res.writeHead(302, { location: "/r6" }).end(),
      "/r6": (_req, res) => res.writeHead(200, { "content-type": "text/plain" }).end("ok"),
    });
    process.env.WEB_FETCH_MAX_REDIRECTS = "3";
    try {
      const result = await webFetchTool.execute({ url: `${handle.url}/r0` });
      expect(result.status).toBe("ERROR");
      expect(result.message).toMatch(/redirect/i);
    } finally {
      delete process.env.WEB_FETCH_MAX_REDIRECTS;
    }
  });

  it("H: truncates/rejects an oversized response rather than buffering it unbounded", async () => {
    handle = await startTestServer({
      "/big": (_req, res) => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("x".repeat(5000));
      },
    });
    process.env.WEB_FETCH_MAX_BYTES = "100";
    try {
      const result = await webFetchTool.execute({ url: `${handle.url}/big` });
      expect(result.status).toBe("OK");
      const data = result.data as any;
      expect(data.truncated).toBe(true);
      expect(data.text.length).toBeLessThanOrEqual(200);
    } finally {
      delete process.env.WEB_FETCH_MAX_BYTES;
    }
  });

  it("rejects an unsupported content-type", async () => {
    handle = await startTestServer({
      "/bin": (_req, res) => {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(Buffer.from([0, 1, 2, 3]));
      },
    });
    const result = await webFetchTool.execute({ url: `${handle.url}/bin` });
    expect(result.status).toBe("ERROR");
    expect(result.message).toMatch(/content-type/i);
  });

  it("reports BLOCKED (never bypasses) on a 403/CAPTCHA-shaped response", async () => {
    handle = await startTestServer({
      "/blocked": (_req, res) => {
        res.writeHead(403, { "content-type": "text/html" });
        res.end("<html><body>Access Denied - please complete a CAPTCHA</body></html>");
      },
    });
    const result = await webFetchTool.execute({ url: `${handle.url}/blocked` });
    expect(result.status).toBe("BLOCKED");
  });

  it("resolves a canonical URL from a <link rel=canonical> tag when present", async () => {
    handle = await startTestServer({
      "/dup": (_req, res) => {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<html><head><link rel="canonical" href="${handle!.url}/real"></head><body>content</body></html>`);
      },
    });
    const result = await webFetchTool.execute({ url: `${handle.url}/dup` });
    expect(result.status).toBe("OK");
    expect((result.data as any).canonicalUrl).toContain("/real");
  });

  it("S: enforces the per-task fetch budget", async () => {
    handle = await startTestServer({
      "/x": (_req, res) => res.writeHead(200, { "content-type": "text/plain" }).end("ok"),
    });
    const { setResearchLimitsConfig } = await import("../../core/research/limits");
    await setResearchLimitsConfig({ maxFetchesPerTask: 1 });
    const taskId = `fetch-budget-${Date.now()}`;
    const first = await webFetchTool.execute({ url: `${handle.url}/x`, taskId });
    expect(first.status).toBe("OK");
    const second = await webFetchTool.execute({ url: `${handle.url}/x`, taskId });
    expect(second.status).toBe("BLOCKED");
  });
});
