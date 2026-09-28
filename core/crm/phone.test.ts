// core/crm/phone.test.ts - Phase 8, item 9/47: phone normalization, tested
// against the exact variant shapes the WhatsApp channel must tolerate
// (spaces/hyphens/parens, +92/0092/92/bare-leading-zero variants), plus the
// "reject rather than guess" requirement for unparseable input.
import { describe, it, expect } from "vitest";
import { normalizePhone } from "./dedup";

describe("normalizePhone", () => {
  it("passes through an already-E.164 Pakistani number", () => {
    const r = normalizePhone("+923001234567");
    expect(r).toEqual({ normalized: "+923001234567", valid: true, reason: "Normalized to E.164-style canonical form." });
  });

  it("handles the 0092 international prefix", () => {
    expect(normalizePhone("0092 300 1234567").normalized).toBe("+923001234567");
  });

  it("handles a bare country code with no leading +", () => {
    expect(normalizePhone("923001234567").normalized).toBe("+923001234567");
  });

  it("handles a local mobile number with leading 0", () => {
    expect(normalizePhone("03001234567").normalized).toBe("+923001234567");
  });

  it("handles a local number with hyphens", () => {
    expect(normalizePhone("0300-1234567").normalized).toBe("+923001234567");
  });

  it("handles a bare 10-digit mobile number with no leading 0 and no country code", () => {
    expect(normalizePhone("3001234567").normalized).toBe("+923001234567");
  });

  it("is tolerant of spaces, hyphens, and parentheses together", () => {
    expect(normalizePhone(" (+92) 300-1234-567 ").normalized).toBe("+923001234567");
  });

  it("strips a stray local leading 0 that follows the country code (+92 0300...)", () => {
    expect(normalizePhone("+92 0300 1234567").normalized).toBe("+923001234567");
    expect(normalizePhone("0092-0300-1234567").normalized).toBe("+923001234567");
  });

  it("handles a Pakistani landline (10-digit, leading 0)", () => {
    expect(normalizePhone("021-34567890").normalized).toBe("+922134567890");
  });

  it("passes through a non-Pakistani E.164 number unchanged (country-agnostic when + is given)", () => {
    expect(normalizePhone("+14155552671").normalized).toBe("+14155552671");
  });

  it("rejects empty/whitespace-only input", () => {
    expect(normalizePhone("").valid).toBe(false);
    expect(normalizePhone("   ").valid).toBe(false);
    expect(normalizePhone(null).valid).toBe(false);
    expect(normalizePhone(undefined).valid).toBe(false);
  });

  it("rejects input with no digits at all", () => {
    const r = normalizePhone("call me maybe");
    expect(r.valid).toBe(false);
    expect(r.normalized).toBeNull();
  });

  it("rejects a too-short number rather than guessing", () => {
    expect(normalizePhone("12345").valid).toBe(false);
  });

  it("rejects a too-long digit string rather than guessing", () => {
    expect(normalizePhone("+9230012345671234567890").valid).toBe(false);
  });

  it("rejects a leading-zero number it cannot confidently resolve to Pakistan's national format", () => {
    // 6-digit local-looking number with a leading 0 - too short to be a real
    // PK local number, must not be guessed into a country code.
    const r = normalizePhone("0123456");
    expect(r.valid).toBe(false);
  });

  it("never merges two genuinely different numbers into the same canonical form", () => {
    const a = normalizePhone("+923001234567");
    const b = normalizePhone("+923009999999");
    expect(a.normalized).not.toBe(b.normalized);
  });
});
