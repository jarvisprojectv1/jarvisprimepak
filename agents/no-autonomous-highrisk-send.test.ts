// agents/no-autonomous-highrisk-send.test.ts - item 16's central architectural
// proof, in the same style as agents/no-trading.test.ts: (1) a source-level
// check that provider.sendMessage() in tools/email/emailTool.ts is only
// reachable after the outbound-risk/approval gate, and (2) a runtime
// behavioral proof that no combination of inputs lets a HIGH-RISK send reach
// the provider without a prior APPROVED ApprovalRequest.
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "../database/client";
import { createEmailTool } from "../tools/email/emailTool";
import { MockEmailProvider } from "../tools/email/mockProvider";

beforeEach(async () => {
  await prisma.outboundSendLog.deleteMany();
  await prisma.approvalRequest.deleteMany();
  await prisma.email.deleteMany();
});

describe("architectural proof: provider.sendMessage() is unreachable for a HIGH-RISK email without a prior APPROVED ApprovalRequest", () => {
  /** Strips // line comments (not perfect for every edge case, but this file has no // inside string literals near the relevant calls). */
  function stripLineComments(source: string): string {
    return source
      .split("\n")
      .map((line) => {
        const idx = line.indexOf("//");
        return idx === -1 ? line : line.slice(0, idx);
      })
      .join("\n");
  }

  it("source-level (code only, comments stripped): sendMessage( is only called after classifyOutboundEmail/risk gating in emailTool.ts", async () => {
    const raw = await fs.readFile(path.join(__dirname, "..", "tools", "email", "emailTool.ts"), "utf-8");
    const source = stripLineComments(raw);
    const sendCallIndex = source.indexOf("provider.sendMessage(");
    const riskGateIndex = source.indexOf("classifyOutboundEmail(");
    const approvalCheckIndex = source.indexOf('approval.status !== "APPROVED"');
    expect(sendCallIndex).toBeGreaterThan(-1);
    expect(riskGateIndex).toBeGreaterThan(-1);
    expect(approvalCheckIndex).toBeGreaterThan(-1);
    // The risk classification and the approval-status check must both occur
    // (in actual code, not comments) BEFORE the one real send call.
    expect(riskGateIndex).toBeLessThan(sendCallIndex);
    expect(approvalCheckIndex).toBeLessThan(sendCallIndex);
    // There is exactly ONE actual call to provider.sendMessage in this file -
    // no second, alternate code path that skips the gate.
    const occurrences = source.match(/provider\.sendMessage\(/g) ?? [];
    expect(occurrences.length).toBe(1);
  });

  it("runtime: a HIGH-RISK send with no approvalRequestId never reaches the provider", async () => {
    const provider = new MockEmailProvider();
    const tool = createEmailTool(provider);
    const result = await tool.execute({ action: "send", to: "buyer@brand.example", subject: "Quote", body: "Price: $1000 per unit, payment link: pay.example.com" });
    expect(result.status).toBe("BLOCKED");
    expect(provider.getSentMessages().length).toBe(0);
  });

  it("runtime: a HIGH-RISK send with a FORGED/nonexistent approvalRequestId still never reaches the provider", async () => {
    const provider = new MockEmailProvider();
    const tool = createEmailTool(provider);
    const result = await tool.execute({
      action: "send",
      to: "buyer@brand.example",
      subject: "Quote",
      body: "Price: $1000 per unit.",
      approvalRequestId: "nonexistent-id-12345",
    });
    expect(result.status).toBe("BLOCKED");
    expect(provider.getSentMessages().length).toBe(0);
  });

  it("runtime: a HIGH-RISK send referencing a REJECTED approval still never reaches the provider", async () => {
    const provider = new MockEmailProvider();
    const tool = createEmailTool(provider);
    const first = await tool.execute({ action: "send", to: "buyer@brand.example", subject: "Quote", body: "Price: $1000 per unit." });
    const approvalId = (first.data as { approvalRequestId: string }).approvalRequestId;
    await prisma.approvalRequest.update({ where: { id: approvalId }, data: { status: "REJECTED", decidedBy: "owner:test", decidedAt: new Date() } });

    const result = await tool.execute({ action: "send", to: "buyer@brand.example", subject: "Quote", body: "Price: $1000 per unit.", approvalRequestId: approvalId });
    expect(result.status).toBe("BLOCKED");
    expect(provider.getSentMessages().length).toBe(0);
  });

  it("runtime: an EXPIRED approval still never reaches the provider", async () => {
    const provider = new MockEmailProvider();
    const tool = createEmailTool(provider);
    const first = await tool.execute({ action: "send", to: "buyer@brand.example", subject: "Quote", body: "Price: $1000 per unit." });
    const approvalId = (first.data as { approvalRequestId: string }).approvalRequestId;
    await prisma.approvalRequest.update({ where: { id: approvalId }, data: { status: "EXPIRED" } });

    const result = await tool.execute({ action: "send", to: "buyer@brand.example", subject: "Quote", body: "Price: $1000 per unit.", approvalRequestId: approvalId });
    expect(result.status).toBe("BLOCKED");
    expect(provider.getSentMessages().length).toBe(0);
  });

  it("no other tool/module in the codebase makes an ACTUAL (non-comment) call to an EmailProvider's sendMessage (only emailTool.ts does)", async () => {
    const { execSync } = await import("node:child_process");
    const grepRoot = path.join(__dirname, "..");
    // -v filters out lines that are (after trimming) a // comment - so a
    // docstring merely MENTIONING provider.sendMessage() doesn't count as a
    // real call site.
    const output = execSync(
      `grep -rn "\\.sendMessage(" --include=*.ts core agents tools apps 2>/dev/null | grep -v "^[^:]*:[0-9]*: *//" || true`,
      { cwd: grepRoot }
    ).toString();
    const files = [
      ...new Set(
        output
          .split("\n")
          .map((line) => line.split(":")[0]?.trim())
          .filter(Boolean)
          .filter((f) => !f.endsWith(".test.ts"))
      ),
    ];
    expect(files).toEqual(["tools/email/emailTool.ts"]);
  });
});
