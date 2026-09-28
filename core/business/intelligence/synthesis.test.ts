// core/business/intelligence/synthesis.test.ts - Phase 11, sections 49-52,
// 61 (scenario 5): AI narrative synthesis + grounding enforcement, cost
// control, bounded-context, and no-tools guarantees.
import { describe, it, expect, afterEach } from "vitest";
import { setCostControlConfig, DEFAULT_COST_CONTROL } from "../../ai/costControl";
import type { AIProvider, AICompletionOutcome, AIMessage, CompleteOptions } from "../../ai/provider";
import { synthesizeBusinessNarrative, buildBiSynthesisPrompt } from "./synthesis";
import type { IntelligenceStatement } from "./types";

class FakeProvider implements AIProvider {
  name = "fake";
  calls: { messages: AIMessage[]; options?: CompleteOptions }[] = [];
  constructor(private responses: AICompletionOutcome[]) {}
  async complete(messages: AIMessage[], options?: CompleteOptions): Promise<AICompletionOutcome> {
    this.calls.push({ messages, options });
    const next = this.responses.shift();
    if (!next) throw new Error("FakeProvider ran out of scripted responses");
    return next;
  }
}

function textOk(content: string): AICompletionOutcome {
  return { ok: true, content, toolUses: [], model: "fake-model", usage: { inputTokens: 10, outputTokens: 10, estimatedCostUsd: 0.001 } };
}

function statement(overrides: Partial<IntelligenceStatement> = {}): IntelligenceStatement {
  return {
    id: "s1",
    type: "FACT",
    label: "Open leads",
    value: 5,
    narrative: "There are 5 open leads.",
    provenance: { sourceIds: [], calculationMethod: "COUNT(*)" },
    ...overrides,
  };
}

afterEach(async () => {
  await setCostControlConfig(DEFAULT_COST_CONTROL);
});

describe("buildBiSynthesisPrompt - bounded context, no raw CRM rows", () => {
  it("only includes the given statement narratives/ids, in four labeled zones", () => {
    const messages = buildBiSynthesisPrompt({ requestDescription: "Weekly briefing", statements: [statement()] });
    const all = messages.map((m) => m.content).join("\n---\n");
    expect(all).toContain("=== TRUSTED SYSTEM INSTRUCTIONS ===");
    expect(all).toContain("=== JARVIS INTERNAL DATA ===");
    expect(all).toContain("=== TRUSTED USER REQUEST ===");
    expect(all).toContain("id=s1");
    expect(all).toContain("There are 5 open leads.");
  });
});

describe("synthesizeBusinessNarrative - no tools ever passed", () => {
  it("never passes an options.tools array to the provider", async () => {
    const provider = new FakeProvider([textOk('```json\n{"narrative":"n","claims":[{"id":"c1","statement":"5 open leads.","statementIds":["s1"]}]}\n```')]);
    await synthesizeBusinessNarrative({ aiProvider: provider, requestDescription: "test", statements: [statement()] });
    expect(provider.calls[0].options).not.toHaveProperty("tools");
  });
});

describe("synthesizeBusinessNarrative - cost control", () => {
  it("refuses the call when the cost limit is already exceeded", async () => {
    await setCostControlConfig({ dailyLimitUsd: 0, monthlyLimitUsd: 0 });
    const provider = new FakeProvider([]);
    const outcome = await synthesizeBusinessNarrative({ aiProvider: provider, requestDescription: "test", statements: [statement()] });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("COST_LIMIT_EXCEEDED");
    expect(provider.calls.length).toBe(0);
  });
});

describe("synthesizeBusinessNarrative - grounding enforcement (scenario 5: inject an unsupported claim)", () => {
  it("rejects a claim citing an invented statement id that was never given to the model", async () => {
    const provider = new FakeProvider([
      textOk('```json\n{"narrative":"n","claims":[{"id":"c1","statement":"Revenue grew 300%.","statementIds":["s-invented-not-real"]}]}\n```'),
    ]);
    const outcome = await synthesizeBusinessNarrative({ aiProvider: provider, requestDescription: "test", statements: [statement()] });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok && outcome.code === "NO_VALID_CLAIMS") {
      expect(outcome.rejectedClaims.length).toBe(1);
      expect(outcome.rejectedClaims[0].reason).toMatch(/unknown statementId/);
    } else {
      throw new Error(`Expected NO_VALID_CLAIMS, got ${JSON.stringify(outcome)}`);
    }
  });

  it("accepts a real, grounded claim and keeps only it when mixed with a fabricated one", async () => {
    const provider = new FakeProvider([
      textOk(
        '```json\n{"narrative":"n","claims":[' +
          '{"id":"c1","statement":"There are 5 open leads.","statementIds":["s1"]},' +
          '{"id":"c2","statement":"Fabricated unsupported claim.","statementIds":[]}' +
          "]}\n```"
      ),
    ]);
    const outcome = await synthesizeBusinessNarrative({ aiProvider: provider, requestDescription: "test", statements: [statement()] });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.claims.length).toBe(1);
      expect(outcome.result.claims[0].id).toBe("c1");
      expect(outcome.result.rejectedClaims.length).toBe(1);
    }
  });
});
