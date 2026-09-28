// core/business/emailClassification.test.ts - item D (email classification).
import { describe, it, expect } from "vitest";
import { classifyEmailDeterministic } from "./emailClassification";

describe("D: email classification", () => {
  it("classifies a pricing request", () => {
    const result = classifyEmailDeterministic("Quotation request", "Could you send a quote for 1000 cartons?");
    expect(result.category).toBe("PRICING_REQUEST");
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it("classifies an unsubscribe request", () => {
    const result = classifyEmailDeterministic("Please stop", "Please unsubscribe me from your list.");
    expect(result.category).toBe("UNSUBSCRIBE_REQUEST");
  });

  it("classifies a sample request", () => {
    const result = classifyEmailDeterministic("Sample please", "Can we get a sample of your corrugated boxes?");
    expect(result.category).toBe("SAMPLE_REQUEST");
  });

  it("classifies a complaint", () => {
    const result = classifyEmailDeterministic("Very unhappy", "This is unacceptable, I am extremely disappointed.");
    expect(result.category).toBe("COMPLAINT");
  });

  it("falls back to GENERAL_REPLY with a lower confidence when nothing matches", () => {
    const result = classifyEmailDeterministic("Hi", "Just saying hello.");
    expect(result.category).toBe("GENERAL_REPLY");
    expect(result.confidence).toBeLessThan(0.75);
  });

  it("never itself performs an action - it only returns a label and reasons", () => {
    const result = classifyEmailDeterministic("Quote", "Send me a quote for 500 units.");
    expect(typeof result.category).toBe("string");
    expect(Array.isArray(result.reasons)).toBe(true);
    // No side-effecting fields (no "sent", no "executed") - purely a classification result.
    expect(Object.keys(result).sort()).toEqual(["category", "confidence", "reasons"]);
  });
});
