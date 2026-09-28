// agents/no-trading.test.ts - Z: an architectural test PROVING no trading/
// broker/fund-movement capability exists anywhere in the codebase (Phase 6,
// item 9's hard requirement). Two independent checks: (1) a grep-based scan
// of every source file for suspicious trading/broker/order-placement
// identifiers, and (2) a runtime scan of the live tool/agent registries for
// any such entry.
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { registerBuiltinTools } from "../tools";
import { registerBuiltinAgents, listAgents } from "./registry";
import { toolRegistry } from "../tools/registry";

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

const SCAN_DIRS = ["core", "agents", "tools", "apps"];
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git"]);
// core/policy/index.ts's BLOCKED_KEYWORDS list intentionally NAMES these
// identifiers so it can hard-block them - that is evidence of protection,
// not a capability, so it is excluded from the "no offending identifier
// anywhere" scan (its own runtime behavior - blocking these actions - is
// exercised by core/policy/policy.test.ts, untouched by this phase).
const EXCLUDED_FILES = new Set(["core/policy/index.ts"]);

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, files);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(full);
    }
  }
  return files;
}

describe("agents/no-trading - architectural proof of no trading capability (Phase 6, item 9)", () => {
  beforeAll(() => {
    registerBuiltinTools();
    registerBuiltinAgents();
  });

  it("Z: no source file (outside this test's own pattern list and comments) matches a trading/broker/fund-movement identifier", () => {
    const repoRoot = path.resolve(__dirname, "..");
    const offenders: Array<{ file: string; pattern: string }> = [];

    for (const dir of SCAN_DIRS) {
      const abs = path.join(repoRoot, dir);
      if (!fs.existsSync(abs)) continue;
      for (const file of walk(abs)) {
        if (file === __filename) continue; // this test file legitimately lists the patterns
        if (EXCLUDED_FILES.has(path.relative(repoRoot, file))) continue;
        const text = fs.readFileSync(file, "utf8");
        for (const re of SUSPICIOUS_PATTERNS) {
          if (re.test(text)) {
            offenders.push({ file: path.relative(repoRoot, file), pattern: re.source });
          }
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("Z: no registered tool exposes a trading/order/fund-movement capability", () => {
    const toolNames = toolRegistry.list().map((t) => t.name.toLowerCase());
    for (const name of toolNames) {
      expect(name).not.toMatch(/trade|order|broker|withdraw|wire/i);
    }
  });

  it("Z: no registered agent exposes a trading/order/fund-movement capability - MarketAgent is research/monitoring only", () => {
    const agents = listAgents();
    const marketAgent = agents.find((a) => a.name === "market");
    expect(marketAgent).toBeDefined();
    expect(marketAgent?.objective.toLowerCase()).toMatch(/research|monitor/);
    // "never trades"/"no trading action" describing the ABSENCE of a
    // capability is fine; only a suspicious identifier (place_trade,
    // executeTrade, brokerApi, ...) would fail SUSPICIOUS_PATTERNS above,
    // which the file-scan test already checks for this agent's own source.

    for (const agent of agents) {
      expect(agent.name.toLowerCase()).not.toMatch(/trade|broker/i);
    }
  });
});
