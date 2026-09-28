// agents/phase11-bi-safety.test.ts - Phase 11's explicit sections 54-56 /
// 75E/F/G architectural verification, in the same style as
// agents/no-trading.test.ts and agents/no-browser-financial-bypass.test.ts.
//
// (E) The outbound provider-send call-site count is unchanged at exactly 3
//     (email/WhatsApp/voice) after this phase - Phase 11 added NO new send
//     path.
// (F) No BI file (tools/businessIntelligence.ts, core/business/intelligence/*)
//     contains a financial-execution-shaped identifier - reusing
//     agents/no-trading.test.ts's own SUSPICIOUS_PATTERNS list rather than a
//     second, divergent list.
// (G) No BI file calls a browser action directly (bypassing
//     toolRegistry.execute("browser", ...)'s normal enforcement path) - BI
//     never invokes the browser tool at all in this phase (Market/Competitor
//     Intelligence's browser-based research, section 24-25, was deferred -
//     see docs/PHASE11_BUSINESS_INTELLIGENCE.md).
// (Query safety, section 46): tools/businessIntelligence.ts's execute() has
// no code path reaching a send/call function, proven by the same grep.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..");

// Same comment-stripping helper agents/no-browser-financial-bypass.test.ts
// already established - a grep for a real call site must not be fooled by a
// doc comment that merely NAMES the call site (as many files in this repo
// deliberately do, to document where the one real call happens).
function stripLineComments(source: string): string {
  return source
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("//");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

function readAllTs(dir: string, files: string[] = []): string[] {
  const full = path.join(REPO_ROOT, dir);
  if (!fs.existsSync(full)) return files;
  for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      readAllTs(entryPath, files);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(entryPath);
    }
  }
  return files;
}

describe("(E) outbound provider-send call-site count is unchanged at exactly 3", () => {
  it("exactly 3 `.sendMessage(`/`.createCall(` call sites to a real provider exist repo-wide, all inside the three existing outbound tools", () => {
    const scanDirs = ["core", "agents", "tools", "apps", "scheduler"];
    let files: string[] = [];
    for (const d of scanDirs) files = readAllTs(d, files);

    const callSites: string[] = [];
    for (const relPath of files) {
      const full = path.join(REPO_ROOT, relPath);
      const source = stripLineComments(fs.readFileSync(full, "utf8"));
      // Only count a call on a `provider.` receiver (the real
      // AIProvider/EmailProvider/WhatsAppProvider/VoiceProvider send call),
      // not an unrelated `.sendMessage(`/`.createCall(` on some other object
      // - matching how tools/whatsapp/whatsappTool.ts's own header describes
      // the sole call site (`provider.sendMessage()`).
      const matches = source.match(/\bprovider\.(sendMessage|createCall)\(/g);
      if (matches) {
        for (const m of matches) callSites.push(`${relPath}: ${m}`);
      }
    }

    expect(callSites.length).toBe(3);
    const files_ = callSites.map((c) => c.split(":")[0]);
    expect(files_.sort()).toEqual(["tools/email/emailTool.ts", "tools/voice/voiceTool.ts", "tools/whatsapp/whatsappTool.ts"].sort());
  });
});

describe("(F) no Phase 11 BI file contains a financial/trading-execution-shaped identifier", () => {
  const SUSPICIOUS_PATTERNS = [
    /place[_-]?order/i,
    /place[_-]?trade/i,
    /executeTrade/i,
    /submitOrder/i,
    /broker[_-]?api/i,
    /binance/i,
    /coinbase[_-]?pro/i,
    /metatrader/i,
    /oanda/i,
    /alpaca[_-]?trade/i,
    /interactive[_-]?brokers/i,
    /wire[_-]?transfer/i,
    /moveFunds/i,
    /withdrawFunds/i,
  ];

  it("scans every Phase 11 BI file", () => {
    const biFiles = [
      ...readAllTs("core/business/intelligence"),
      "tools/businessIntelligence.ts",
    ];
    expect(biFiles.length).toBeGreaterThan(5);
    for (const relPath of biFiles) {
      const full = path.join(REPO_ROOT, relPath);
      const source = stripLineComments(fs.readFileSync(full, "utf8"));
      for (const pattern of SUSPICIOUS_PATTERNS) {
        expect(source, `${relPath} matched suspicious pattern ${pattern}`).not.toMatch(pattern);
      }
    }
  });
});

describe("(G) no Phase 11 BI file calls a browser action directly", () => {
  it("no BI file references a browser-execute call outside the normal toolRegistry.execute('browser', ...) path", () => {
    const biFiles = [
      ...readAllTs("core/business/intelligence"),
      "tools/businessIntelligence.ts",
    ];
    for (const relPath of biFiles) {
      const full = path.join(REPO_ROOT, relPath);
      const source = fs.readFileSync(full, "utf8");
      expect(source, `${relPath} references PlaywrightBrowserProvider directly`).not.toMatch(/PlaywrightBrowserProvider/);
      expect(source, `${relPath} calls browser session/provider methods directly`).not.toMatch(/\b(browserSession|BrowserProvider)\b/);
      expect(source, `${relPath} imports the browser tool`).not.toMatch(/from\s+["'].*\/browser\/browserTool["']/);
    }
  });
});

describe("query safety (section 46): tools/businessIntelligence.ts's execute() has no send/call/browser code path", () => {
  it("the tool file itself contains no send/call/browser call site", () => {
    const source = stripLineComments(fs.readFileSync(path.join(REPO_ROOT, "tools/businessIntelligence.ts"), "utf8"));
    expect(source).not.toMatch(/\.(sendMessage|createCall)\(/);
    expect(source).not.toMatch(/toolRegistry\.execute\(\s*["']browser["']/);
  });
});
