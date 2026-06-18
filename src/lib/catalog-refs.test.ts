import { describe, it, expect } from "vitest";
import {
  segmentRefs,
  hasRef,
  idPatternGuard,
  MAX_ID_PATTERN_CHARS,
  type CatalogPattern,
} from "./catalog-refs";

const patterns: CatalogPattern[] = [
  { kind: "finding", idPattern: "F-\\d+" },
  { kind: "rfc", idPattern: "RFC-\\d+" },
];

describe("catalog-refs segmentRefs", () => {
  it("returns a single text segment when no patterns are given (share-page rule)", () => {
    expect(segmentRefs("see F-12", null)).toEqual([{ type: "text", value: "see F-12" }]);
    expect(segmentRefs("see F-12", [])).toEqual([{ type: "text", value: "see F-12" }]);
  });

  it("links a single ref with the right kind + href", () => {
    const segs = segmentRefs("see F-12 today", patterns);
    expect(segs).toEqual([
      { type: "text", value: "see " },
      { type: "ref", kind: "finding", itemId: "F-12", href: "/catalog/finding/F-12" },
      { type: "text", value: " today" },
    ]);
  });

  it("links multiple refs across kinds", () => {
    const segs = segmentRefs("F-1 and RFC-7", patterns);
    const refs = segs.filter((s) => s.type === "ref");
    expect(refs.map((r) => (r.type === "ref" ? `${r.kind}:${r.itemId}` : ""))).toEqual([
      "finding:F-1",
      "rfc:RFC-7",
    ]);
  });

  it("does not match inside a larger token (boundary)", () => {
    expect(hasRef("XF-9 and F-99x", patterns)).toBe(false);
  });

  it("ignores an uncompilable pattern without breaking the rest", () => {
    const bad: CatalogPattern[] = [
      { kind: "broken", idPattern: "F-(\\d+" },
      { kind: "finding", idPattern: "F-\\d+" },
    ];
    const segs = segmentRefs("see F-3", bad);
    expect(segs.some((s) => s.type === "ref")).toBe(true);
  });

  it("an XSS-shaped itemId pattern produces an encoded href (can't break out)", () => {
    // Pattern-validated ids only contain what the pattern allows; even a
    // permissive pattern goes through encodeURIComponent in the href.
    const xss: CatalogPattern[] = [{ kind: "x", idPattern: "X-[\\w\"'<>]+" }];
    const segs = segmentRefs(`X-a"b`, xss);
    const ref = segs.find((s) => s.type === "ref");
    expect(ref && ref.type === "ref" ? ref.href : "").toBe("/catalog/x/X-a%22b");
  });
});

describe("idPatternGuard (ReDoS)", () => {
  it("accepts the simple id shapes catalogs use", () => {
    expect(idPatternGuard("F-\\d+").ok).toBe(true);
    expect(idPatternGuard("RFC-\\d+").ok).toBe(true);
    expect(idPatternGuard("[A-Z]+-\\d+").ok).toBe(true);
    expect(idPatternGuard("(?:F|BLK)-\\d+").ok).toBe(true);
  });

  it("rejects nested unbounded quantifiers (the (a+)+ family)", () => {
    expect(idPatternGuard("(a+)+").ok).toBe(false);
    expect(idPatternGuard("(a*)*").ok).toBe(false);
    expect(idPatternGuard("(a+)+$").ok).toBe(false);
    expect(idPatternGuard("(?:\\d+)+").ok).toBe(false);
    expect(idPatternGuard("(\\w*){2,}").ok).toBe(false);
  });

  it("does not false-positive on a literal + inside a character class", () => {
    expect(idPatternGuard("([+x])+").ok).toBe(true);
    expect(idPatternGuard("(\\+)+").ok).toBe(true);
  });

  it("rejects empty and over-long patterns", () => {
    expect(idPatternGuard("").ok).toBe(false);
    expect(idPatternGuard("a".repeat(MAX_ID_PATTERN_CHARS + 1)).ok).toBe(false);
  });

  it("segmentRefs skips an unsafe pattern instead of running it (stays fast)", () => {
    const evil: CatalogPattern[] = [
      { kind: "evil", idPattern: "(a+)+$" },
      { kind: "finding", idPattern: "F-\\d+" },
    ];
    const body = "a".repeat(40) + "b plus F-3";
    const t0 = Date.now();
    const segs = segmentRefs(body, evil);
    expect(Date.now() - t0).toBeLessThan(1000); // would be minutes if it ran
    // The safe pattern still links; the unsafe one contributed nothing.
    expect(segs.some((s) => s.type === "ref" && s.kind === "finding")).toBe(true);
    expect(segs.some((s) => s.type === "ref" && s.kind === "evil")).toBe(false);
  });
});

