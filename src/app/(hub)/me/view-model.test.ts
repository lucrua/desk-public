import { describe, it, expect } from "vitest";
import { maskToken } from "./view-model";

describe("maskToken", () => {
  it("masks a long token to first 8 chars + ellipsis", () => {
    expect(maskToken("ci-publisher-abcdef")).toBe("ci-publi…");
  });

  it("shows a token of exactly 8 chars whole", () => {
    expect(maskToken("12345678")).toBe("12345678");
  });

  it("shows a short token whole", () => {
    expect(maskToken("abc")).toBe("abc");
  });

  it("renders an em-dash for null / undefined / empty", () => {
    expect(maskToken(null)).toBe("—");
    expect(maskToken(undefined)).toBe("—");
    expect(maskToken("")).toBe("—");
  });
});
