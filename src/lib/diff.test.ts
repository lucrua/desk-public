import { describe, it, expect } from "vitest";
import { unifiedDiff, type DiffLine } from "./diff";

describe("unifiedDiff", () => {
  it("identical input → all context lines", () => {
    const text = "alpha\nbeta\ngamma";
    expect(unifiedDiff(text, text)).toEqual<DiffLine[]>([
      { type: "ctx", text: "alpha" },
      { type: "ctx", text: "beta" },
      { type: "ctx", text: "gamma" },
    ]);
  });

  it("pure addition appended at the end", () => {
    expect(unifiedDiff("a\nb", "a\nb\nc")).toEqual<DiffLine[]>([
      { type: "ctx", text: "a" },
      { type: "ctx", text: "b" },
      { type: "add", text: "c" },
    ]);
  });

  it("pure addition in the middle", () => {
    expect(unifiedDiff("a\nc", "a\nb\nc")).toEqual<DiffLine[]>([
      { type: "ctx", text: "a" },
      { type: "add", text: "b" },
      { type: "ctx", text: "c" },
    ]);
  });

  it("pure deletion", () => {
    expect(unifiedDiff("a\nb\nc", "a\nc")).toEqual<DiffLine[]>([
      { type: "ctx", text: "a" },
      { type: "del", text: "b" },
      { type: "ctx", text: "c" },
    ]);
  });

  it("mixed change — replaced line shows del then add, anchored by context", () => {
    expect(unifiedDiff("a\nb\nc", "a\nX\nc")).toEqual<DiffLine[]>([
      { type: "ctx", text: "a" },
      { type: "del", text: "b" },
      { type: "add", text: "X" },
      { type: "ctx", text: "c" },
    ]);
  });

  it("whole-document replacement — all del then all add", () => {
    expect(unifiedDiff("a\nb", "x\ny")).toEqual<DiffLine[]>([
      { type: "del", text: "a" },
      { type: "del", text: "b" },
      { type: "add", text: "x" },
      { type: "add", text: "y" },
    ]);
  });

  it("empty old → all additions", () => {
    expect(unifiedDiff("", "a\nb")).toEqual<DiffLine[]>([
      { type: "add", text: "a" },
      { type: "add", text: "b" },
    ]);
  });

  it("empty new → all deletions", () => {
    expect(unifiedDiff("a\nb", "")).toEqual<DiffLine[]>([
      { type: "del", text: "a" },
      { type: "del", text: "b" },
    ]);
  });

  it("both empty → no lines", () => {
    expect(unifiedDiff("", "")).toEqual<DiffLine[]>([]);
  });

  it("trailing newline does not create a spurious empty line at the tail", () => {
    // "a\nb\n" and "a\nb" should be identical for diff purposes.
    expect(unifiedDiff("a\nb\n", "a\nb")).toEqual<DiffLine[]>([
      { type: "ctx", text: "a" },
      { type: "ctx", text: "b" },
    ]);
  });

  it("preserves blank interior lines as content", () => {
    expect(unifiedDiff("a\n\nb", "a\n\nb")).toEqual<DiffLine[]>([
      { type: "ctx", text: "a" },
      { type: "ctx", text: "" },
      { type: "ctx", text: "b" },
    ]);
  });
});
