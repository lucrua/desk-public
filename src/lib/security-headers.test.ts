import { describe, it, expect } from "vitest";
import { SECURITY_HEADERS } from "./security-headers";

const valueOf = (key: string) =>
  SECURITY_HEADERS.find((h) => h.key.toLowerCase() === key.toLowerCase())?.value;

describe("security headers", () => {
  it("sets a frame-ancestors CSP (clickjacking backstop)", () => {
    const csp = valueOf("Content-Security-Policy");
    expect(csp).toBeDefined();
    expect(csp).toContain("frame-ancestors 'self'");
  });

  it("CSP is frame-ancestors-only (no app-breaking default/script/style-src)", () => {
    const csp = valueOf("Content-Security-Policy") ?? "";
    expect(csp).not.toContain("default-src");
    expect(csp).not.toContain("script-src");
    expect(csp).not.toContain("style-src");
  });

  it("sets the companion hardening headers", () => {
    expect(valueOf("X-Frame-Options")).toBe("SAMEORIGIN");
    expect(valueOf("X-Content-Type-Options")).toBe("nosniff");
    expect(valueOf("Referrer-Policy")).toBeTruthy();
  });
});
