import { describe, it, expect } from "vitest";
import { merge3 } from "./diff3.mjs";

describe("merge3 — clean merges", () => {
  it("identical a and b → clean, unchanged", () => {
    const r = merge3("x\ny\n", "x\ny\n", "x\ny\n");
    expect(r.clean).toBe(true);
    expect(r.merged).toBe("x\ny\n");
  });

  it("only ours changed → take ours", () => {
    const base = "a\nb\nc\n";
    const ours = "a\nB\nc\n";
    const r = merge3(ours, base, base);
    expect(r.clean).toBe(true);
    expect(r.merged).toBe("a\nB\nc\n");
  });

  it("only theirs changed → take theirs", () => {
    const base = "a\nb\nc\n";
    const theirs = "a\nb\nC\n";
    const r = merge3(base, base, theirs);
    expect(r.clean).toBe(true);
    expect(r.merged).toBe("a\nb\nC\n");
  });

  it("non-overlapping edits on different lines → clean union", () => {
    const base = "line1\nline2\nline3\nline4\n";
    const ours = "LINE1\nline2\nline3\nline4\n";
    const theirs = "line1\nline2\nline3\nLINE4\n";
    const r = merge3(ours, base, theirs);
    expect(r.clean).toBe(true);
    expect(r.merged).toBe("LINE1\nline2\nline3\nLINE4\n");
  });

  it("both sides made the IDENTICAL change → clean, applied once", () => {
    const base = "a\nb\nc\n";
    const same = "a\nX\nc\n";
    const r = merge3(same, base, same);
    expect(r.clean).toBe(true);
    expect(r.merged).toBe("a\nX\nc\n");
  });

  it("ours appends at end, theirs untouched → clean", () => {
    const base = "a\nb\n";
    const ours = "a\nb\nc\n";
    const r = merge3(ours, base, base);
    expect(r.clean).toBe(true);
    expect(r.merged).toBe("a\nb\nc\n");
  });

  it("ours inserts at top, theirs inserts at bottom → clean union", () => {
    const base = "mid\n";
    const ours = "top\nmid\n";
    const theirs = "mid\nbot\n";
    const r = merge3(ours, base, theirs);
    expect(r.clean).toBe(true);
    expect(r.merged).toBe("top\nmid\nbot\n");
  });

  it("both delete the same line → clean", () => {
    const base = "a\nb\nc\n";
    const cut = "a\nc\n";
    const r = merge3(cut, base, cut);
    expect(r.clean).toBe(true);
    expect(r.merged).toBe("a\nc\n");
  });
});

describe("merge3 — conflicts", () => {
  it("overlapping edits on the same line → conflict with markers", () => {
    const base = "a\nb\nc\n";
    const ours = "a\nOURS\nc\n";
    const theirs = "a\nTHEIRS\nc\n";
    const r = merge3(ours, base, theirs, { labelA: "local", labelB: "cloud" });
    expect(r.clean).toBe(false);
    expect(r.merged).toContain("<<<<<<< local");
    expect(r.merged).toContain("OURS");
    expect(r.merged).toContain("=======");
    expect(r.merged).toContain("THEIRS");
    expect(r.merged).toContain(">>>>>>> cloud");
  });

  it("ours deletes a line, theirs edits the same line → conflict", () => {
    const base = "a\nb\nc\n";
    const ours = "a\nc\n";
    const theirs = "a\nB-EDIT\nc\n";
    const r = merge3(ours, base, theirs);
    expect(r.clean).toBe(false);
    expect(r.merged).toContain("<<<<<<<");
  });

  it("conflict preserves surrounding stable context", () => {
    const base = "h1\nbody\nfoot\n";
    const ours = "h1\nMINE\nfoot\n";
    const theirs = "h1\nYOURS\nfoot\n";
    const r = merge3(ours, base, theirs);
    expect(r.clean).toBe(false);
    expect(r.merged.startsWith("h1\n")).toBe(true);
    expect(r.merged.endsWith("foot\n")).toBe(true);
  });
});

describe("merge3 — edge cases", () => {
  it("empty base, both add same content → clean", () => {
    const r = merge3("hello\n", "", "hello\n");
    expect(r.clean).toBe(true);
    expect(r.merged).toBe("hello\n");
  });

  it("empty base, both add different content → conflict", () => {
    const r = merge3("foo\n", "", "bar\n");
    expect(r.clean).toBe(false);
  });

  it("no trailing newline anywhere is preserved", () => {
    const base = "a\nb";
    const ours = "A\nb";
    const r = merge3(ours, base, base);
    expect(r.clean).toBe(true);
    expect(r.merged).toBe("A\nb");
  });

  it("a equals base equals b (no-op) → clean", () => {
    const r = merge3("same\n", "same\n", "same\n");
    expect(r.clean).toBe(true);
    expect(r.merged).toBe("same\n");
  });
});
