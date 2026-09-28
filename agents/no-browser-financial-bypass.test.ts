// agents/no-browser-financial-bypass.test.ts - Phase 10's central
// architectural proof, in the same style as agents/no-trading.test.ts and
// agents/no-autonomous-highrisk-send.test.ts: (1) a source-level check that
// isFinancialHardBlock() is checked BEFORE approval lookup in
// tools/browser/browserTool.ts, and (2) a runtime behavioral proof that no
// combination of inputs - including a genuinely APPROVED ApprovalRequest -
// lets a financial-transaction-shaped browser action reach the provider.
import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "../database/client";
import { createBrowserTool } from "../tools/browser/browserTool";
import { PlaywrightBrowserProvider } from "../tools/browser/playwrightProvider";
import { _shutdownForTests } from "../core/browser/session";
import { approveRequest, createApprovalRequest } from "../core/approvals";
import { startTestServer, type TestServerHandle } from "../tools/web/testServer";

let server: TestServerHandle;

beforeAll(async () => {
  server = await startTestServer({
    "/checkout": (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" }).end(`<html><head><title>Checkout</title></head><body><button id="pay">Confirm Payment</button></body></html>`);
    },
  });
});

afterAll(async () => {
  await server.close();
  await _shutdownForTests();
});

beforeEach(async () => {
  await prisma.browserTask.deleteMany();
  await prisma.approvalRequest.deleteMany();
});

describe("agents/no-browser-financial-bypass - source-level proof: the financial hard block is checked before approval lookup", () => {
  function stripLineComments(source: string): string {
    return source
      .split("\n")
      .map((line) => {
        const idx = line.indexOf("//");
        return idx === -1 ? line : line.slice(0, idx);
      })
      .join("\n");
  }

  it("isFinancialHardBlock( is called, and its BLOCKED branch returns, before getApprovalRequest( is ever reached in the same function", async () => {
    const raw = await fs.readFile(path.join(__dirname, "..", "tools", "browser", "browserTool.ts"), "utf-8");
    const source = stripLineComments(raw);
    const hardBlockIndex = source.indexOf("isFinancialHardBlock(");
    const hardBlockReturnIndex = source.indexOf('return { status: "BLOCKED", message: `BLOCKED (financial hard block');
    const approvalLookupIndex = source.indexOf("getApprovalRequest(");
    expect(hardBlockIndex).toBeGreaterThan(-1);
    expect(hardBlockReturnIndex).toBeGreaterThan(-1);
    expect(approvalLookupIndex).toBeGreaterThan(-1);
    expect(hardBlockIndex).toBeLessThan(approvalLookupIndex);
    expect(hardBlockReturnIndex).toBeLessThan(approvalLookupIndex);
  });

  it("the real provider action (ctx.run()) is only ever called after both the financial hard block AND the approval gate", async () => {
    const raw = await fs.readFile(path.join(__dirname, "..", "tools", "browser", "browserTool.ts"), "utf-8");
    const source = stripLineComments(raw);
    const runCallIndex = source.lastIndexOf("await ctx.run()");
    const hardBlockIndex = source.indexOf("isFinancialHardBlock(");
    const approvalGateIndex = source.indexOf("if (risk.requiresApproval)");
    expect(runCallIndex).toBeGreaterThan(-1);
    expect(hardBlockIndex).toBeLessThan(runCallIndex);
    expect(approvalGateIndex).toBeLessThan(runCallIndex);
  });
});

describe("agents/no-browser-financial-bypass - runtime proof: no input combination reaches a completed financial action", () => {
  it("a financial-shaped click with NO approval is blocked", async () => {
    const tool = createBrowserTool(new PlaywrightBrowserProvider());
    const created = await tool.execute({ action: "create_session" });
    const sessionId = (created.data as { sessionId: string }).sessionId;
    await tool.execute({ action: "navigate", sessionId, url: `${server.url}/checkout` });
    const result = await tool.execute({ action: "click", sessionId, selector: "#pay", text: "Confirm Payment" });
    expect(result.status).toBe("BLOCKED");
    await tool.execute({ action: "close_session", sessionId });
  }, 30000);

  it("a financial-shaped click with a FORGED approvalRequestId is blocked", async () => {
    const tool = createBrowserTool(new PlaywrightBrowserProvider());
    const created = await tool.execute({ action: "create_session" });
    const sessionId = (created.data as { sessionId: string }).sessionId;
    await tool.execute({ action: "navigate", sessionId, url: `${server.url}/checkout` });
    const result = await tool.execute({ action: "click", sessionId, selector: "#pay", text: "Confirm Payment", approvalRequestId: "not-a-real-id" });
    expect(result.status).toBe("BLOCKED");
    await tool.execute({ action: "close_session", sessionId });
  }, 30000);

  it("a financial-shaped click with a GENUINELY APPROVED ApprovalRequest for this exact target STILL never reaches the provider - the hard block has no approval escape hatch", async () => {
    const tool = createBrowserTool(new PlaywrightBrowserProvider());
    const created = await tool.execute({ action: "create_session" });
    const sessionId = (created.data as { sessionId: string }).sessionId;
    await tool.execute({ action: "navigate", sessionId, url: `${server.url}/checkout` });

    // Create and genuinely APPROVE a request for exactly this domain/action -
    // the closest thing to "best case for a legitimate bypass attempt".
    const approval = await createApprovalRequest({
      action: "browser.click",
      reason: "test: attempt to pre-approve a financial action",
      target: "127.0.0.1",
      proposedContent: { domain: "127.0.0.1", actionType: "click", targetText: "Confirm Payment" },
      riskClassification: "HIGH",
      createdBy: "test",
    });
    await approveRequest(approval.id, "owner-test", "approved for test");

    const result = await tool.execute({ action: "click", sessionId, selector: "#pay", text: "Confirm Payment", approvalRequestId: approval.id });
    expect(result.status).toBe("BLOCKED");
    expect(result.message).toMatch(/financial hard block/i);
    expect((result.data as { hardBlocked?: boolean }).hardBlocked).toBe(true);

    // No BrowserTask row from this attempt was ever recorded DONE.
    const rows = await prisma.browserTask.findMany({ where: { sessionId, action: "click" } });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.status !== "DONE")).toBe(true);

    await tool.execute({ action: "close_session", sessionId });
  }, 30000);
});
