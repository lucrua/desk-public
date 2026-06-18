import { describe, it, expect } from "vitest";
import { slugFromFilename, isValidSlug, titleFromContent, randomSlug } from "./slug";

describe("slugFromFilename", () => {
  it("lowercases and strips extension", () => {
    expect(slugFromFilename("My File.MD")).toBe("my-file");
  });

  it("collapses non-alphanumeric runs and drops accented chars", () => {
    expect(slugFromFilename("Relatório Q2.html")).toBe("relat-rio-q2");
  });

  it("collapses repeated separators into one dash", () => {
    expect(slugFromFilename("a   b___c.md")).toBe("a-b-c");
  });

  it("trims leading and trailing dashes", () => {
    expect(slugFromFilename("--Hello--.md")).toBe("hello");
  });

  it("only strips the final extension (keeps inner dots as separators)", () => {
    expect(slugFromFilename("notes.v2.final.md")).toBe("notes-v2-final");
  });

  it("handles a filename with no extension", () => {
    expect(slugFromFilename("README")).toBe("readme");
  });

  it("treats a leading-dot dotfile as having no extension to strip", () => {
    // ".env" → no stem before the dot, so the whole name is slugified.
    expect(slugFromFilename(".env")).toBe("env");
  });

  it("returns empty string when nothing slug-like remains", () => {
    expect(slugFromFilename("___.md")).toBe("");
    expect(slugFromFilename("   .md")).toBe("");
  });

  it("returns empty string for an empty input", () => {
    expect(slugFromFilename("")).toBe("");
  });

  it("strips unicode entirely when no ascii-alphanumerics remain", () => {
    expect(slugFromFilename("日本語.md")).toBe("");
  });

  it("preserves digits and existing valid slugs", () => {
    expect(slugFromFilename("q3-2026-deck.html")).toBe("q3-2026-deck");
  });
});

describe("isValidSlug", () => {
  it("accepts lowercase alphanumeric with dashes", () => {
    expect(isValidSlug("my-doc-2")).toBe(true);
    expect(isValidSlug("a")).toBe(true);
  });

  it("rejects uppercase, leading dash, and empty", () => {
    expect(isValidSlug("My-Doc")).toBe(false);
    expect(isValidSlug("-my-doc")).toBe(false);
    expect(isValidSlug("")).toBe(false);
  });

  it("rejects spaces and unicode", () => {
    expect(isValidSlug("my doc")).toBe(false);
    expect(isValidSlug("relatório")).toBe(false);
  });
});

describe("randomSlug", () => {
  it("returns a 9-char string of [a-z0-9] only", () => {
    const s = randomSlug();
    expect(s).toHaveLength(9);
    expect(/^[a-z0-9]{9}$/.test(s)).toBe(true);
  });

  it("matches SLUG_RE (starts with a-z0-9, no dashes since chars are a-z0-9 only)", () => {
    const s = randomSlug();
    expect(/^[a-z0-9][a-z0-9-]*$/.test(s)).toBe(true);
  });

  it("two calls return different slugs (collision extremely unlikely)", () => {
    // 36^9 ≈ 1e14 possibilities; probability of collision < 1e-12
    expect(randomSlug()).not.toBe(randomSlug());
  });
});

describe("titleFromContent", () => {
  it("returns the first level-1 heading, stripped", () => {
    expect(titleFromContent("# Hello World\n\nbody", "fallback")).toBe("Hello World");
  });

  it("ignores headings deeper into the doc when an h1 exists earlier", () => {
    expect(titleFromContent("intro\n\n# Real Title\n## sub", "fallback")).toBe("Real Title");
  });

  it("falls back when there is no h1", () => {
    expect(titleFromContent("## only an h2\n\nbody", "My File")).toBe("My File");
    expect(titleFromContent("<html><body>hi</body></html>", "artifact.html")).toBe("artifact.html");
  });

  it("does not treat a hash without a space as a heading (atx requires space)", () => {
    expect(titleFromContent("#nospace\n\nbody", "fallback")).toBe("fallback");
  });

  it("falls back when the heading text is whitespace only", () => {
    expect(titleFromContent("#    \n\nbody", "fallback")).toBe("fallback");
  });

  it("accepts a tab after the hash", () => {
    expect(titleFromContent("#\tTabbed", "fallback")).toBe("Tabbed");
  });
});
