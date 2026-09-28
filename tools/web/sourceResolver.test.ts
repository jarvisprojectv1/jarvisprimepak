import { describe, it, expect } from "vitest";
import { validateUrl, canonicalizeUrl, domainOf } from "./sourceResolver";

describe("tools/web/sourceResolver", () => {
  it("F: accepts http/https, rejects other protocols", () => {
    expect(validateUrl("https://example.com").valid).toBe(true);
    expect(validateUrl("http://example.com").valid).toBe(true);
    expect(validateUrl("ftp://example.com").valid).toBe(false);
    expect(validateUrl("file:///etc/passwd").valid).toBe(false);
    expect(validateUrl("javascript:alert(1)").valid).toBe(false);
  });

  it("F: rejects a malformed URL string", () => {
    expect(validateUrl("not a url at all").valid).toBe(false);
  });

  it("J: canonicalizes away tracking params, casing, and trailing slash for dedup", () => {
    const a = canonicalizeUrl("https://Example.com/Page/?utm_source=twitter&b=2&a=1");
    const b = canonicalizeUrl("https://example.com/Page?a=1&b=2");
    expect(a).toBe(b);
  });

  it("J: distinct paths remain distinct after canonicalization", () => {
    const a = canonicalizeUrl("https://example.com/page-one");
    const b = canonicalizeUrl("https://example.com/page-two");
    expect(a).not.toBe(b);
  });

  it("extracts a lowercased domain", () => {
    expect(domainOf("https://Example.COM/x")).toBe("example.com");
  });
});
