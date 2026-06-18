import { describe, it, expect } from "vitest";
import { mintToken, hashToken } from "./tokens";

describe("capability tokens", () => {
  it("mints url-safe tokens with ≥128 bits entropy", () => {
    const t = mintToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes base64url
    expect(mintToken()).not.toBe(t);
  });
  it("hashes deterministically, hex sha256", () => {
    const t = mintToken();
    expect(hashToken(t)).toBe(hashToken(t));
    expect(hashToken(t)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashToken(t)).not.toContain(t);
  });
});
