// core/business/emailDraft.test.ts - items M (draft generation) and N
// (hallucination-rejection).
import { describe, it, expect } from "vitest";
import { generateDraft, validateDraftGrounding } from "./emailDraft";
import type { ProductCategoryData } from "../crm/businessConfig";

const category: ProductCategoryData = {
  id: "pc-1",
  name: "Corrugated Packaging",
  description: "Corrugated cartons for shipping.",
  positioning: "Core Prime Pak line.",
  certifications: ["ISO 9001"],
  minOrderQuantity: "500 units",
  productionTimeNotes: "2-3 weeks",
  costingRules: { unit: "carton", baseUnitCost: 1.2, currency: "USD" },
};

describe("M: email draft generation", () => {
  it("generates a subject/body citing only configured facts when a product category is fully configured", () => {
    const draft = generateDraft({ contactFirstName: "Priya", companyName: "Acme Co", productCategory: category, category: "PRICING_REQUEST" });
    expect(draft.body).toContain("USD 1.2 per carton");
    expect(draft.body).toContain("ISO 9001");
    expect(draft.placeholders.length).toBe(0);
  });

  it("uses explicit placeholders, never invented values, when business data is missing", () => {
    const draft = generateDraft({ contactFirstName: "Priya", companyName: "Acme Co", productCategory: null, category: "PRICING_REQUEST" });
    expect(draft.body).toContain("[PRICE TO BE CONFIRMED]");
    expect(draft.body).toContain("[CERTIFICATION TO BE CONFIRMED]");
    expect(draft.body).not.toMatch(/\$\d/); // no fabricated dollar figure anywhere
  });

  it("is grounded when generated from configured data", () => {
    const draft = generateDraft({ contactFirstName: "Priya", productCategory: category, category: "PRICING_REQUEST" });
    const result = validateDraftGrounding(draft.body, draft.citedFacts);
    expect(result.grounded).toBe(true);
  });

  it("is grounded (no false positives) when generated with placeholders only", () => {
    const draft = generateDraft({ contactFirstName: "Priya", productCategory: null, category: "PRICING_REQUEST" });
    const result = validateDraftGrounding(draft.body, draft.citedFacts);
    expect(result.grounded).toBe(true);
  });
});

describe("N: hallucination-rejection", () => {
  it("flags a price mentioned in draft text that is NOT in allowedFacts", () => {
    const fabricated = "Our price is $999 per carton and we are ISO 9001 certified.";
    const result = validateDraftGrounding(fabricated, ["ISO 9001"]);
    expect(result.grounded).toBe(false);
    expect(result.ungroundedClaims.some((c) => c.includes("999"))).toBe(true);
  });

  it("flags a certification claim not present in allowedFacts", () => {
    const fabricated = "We are FSC certified and GOTS certified.";
    const result = validateDraftGrounding(fabricated, ["ISO 9001"]);
    expect(result.grounded).toBe(false);
    expect(result.ungroundedClaims.length).toBeGreaterThan(0);
  });

  it("does not flag a claim that IS present in allowedFacts", () => {
    const text = "We are ISO 9001 certified and pricing is USD 1.2 per carton.";
    const result = validateDraftGrounding(text, ["ISO 9001", "USD 1.2 per carton"]);
    expect(result.grounded).toBe(true);
  });
});
