import { describe, it, expect } from "vitest";
import { normalizePath, isValidPath, MAX_PATH_DEPTH } from "./path";

describe("normalizePath", () => {
  it("'' and whitespace and '/' all canonicalize to root ''", () => {
    expect(normalizePath("")).toBe("");
    expect(normalizePath("   ")).toBe("");
    expect(normalizePath("/")).toBe("");
    expect(normalizePath("///")).toBe("");
  });

  it("accepts single + nested segments", () => {
    expect(normalizePath("os")).toBe("os");
    expect(normalizePath("os/canon")).toBe("os/canon");
    expect(normalizePath("a/b/c/d/e/f")).toBe("a/b/c/d/e/f"); // depth 6 = max
  });

  it("strips surrounding slashes and whitespace", () => {
    expect(normalizePath("/os/")).toBe("os");
    expect(normalizePath("  os/canon  ")).toBe("os/canon");
    expect(normalizePath("/os/canon/")).toBe("os/canon");
  });

  it("rejects depth > MAX_PATH_DEPTH", () => {
    const tooDeep = Array.from({ length: MAX_PATH_DEPTH + 1 }, (_, i) => `s${i}`).join("/");
    expect(normalizePath(tooDeep)).toBeNull();
  });

  it("rejects empty interior segments", () => {
    expect(normalizePath("os//canon")).toBeNull();
    expect(normalizePath("os/ /canon")).toBeNull();
  });

  it("rejects segments that fail the alphabet", () => {
    expect(normalizePath("OS")).toBeNull(); // uppercase
    expect(normalizePath("os/Canon")).toBeNull();
    expect(normalizePath("-leading")).toBeNull(); // must start with [a-z0-9]
    expect(normalizePath("os/under_score")).toBeNull();
    expect(normalizePath("os/space bar")).toBeNull();
    expect(normalizePath("os/a.b")).toBeNull();
  });

  it("accepts digits + dashes inside segments", () => {
    expect(normalizePath("2026/q2-review")).toBe("2026/q2-review");
  });

  it("non-string input → null", () => {
    expect(normalizePath(42 as unknown)).toBeNull();
    expect(normalizePath(null)).toBeNull();
    expect(normalizePath(undefined)).toBeNull();
    expect(normalizePath({} as unknown)).toBeNull();
  });
});

describe("isValidPath", () => {
  it("mirrors normalizePath != null", () => {
    expect(isValidPath("")).toBe(true);
    expect(isValidPath("os/canon")).toBe(true);
    expect(isValidPath("OS")).toBe(false);
    expect(isValidPath("os//x")).toBe(false);
  });
});
