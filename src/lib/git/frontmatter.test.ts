import { describe, it, expect } from "vitest";
import { parseFrontmatter } from "./frontmatter";

describe("parseFrontmatter", () => {
  it("returns no frontmatter when absent", () => {
    const r = parseFrontmatter("# Title\nbody");
    expect(r.hasFrontmatter).toBe(false);
    expect(r.frontmatter).toEqual({});
    expect(r.body).toBe("# Title\nbody");
  });

  it("parses scalar keys with type coercion", () => {
    const r = parseFrontmatter(
      ["---", "title: Hello", "count: 42", "ratio: 1.5", "draft: true", "missing: null", "---", "# Body"].join("\n"),
    );
    expect(r.hasFrontmatter).toBe(true);
    expect(r.frontmatter).toEqual({
      title: "Hello",
      count: 42,
      ratio: 1.5,
      draft: true,
      missing: null,
    });
    expect(r.body).toBe("# Body");
  });

  it("unquotes quoted scalars and keeps them strings", () => {
    const r = parseFrontmatter(['---', 'a: "42"', "b: 'hi: there'", "---", "x"].join("\n"));
    expect(r.frontmatter.a).toBe("42");
    expect(r.frontmatter.b).toBe("hi: there");
  });

  it("parses inline flow arrays", () => {
    const r = parseFrontmatter(["---", "tags: [a, b, c]", "nums: [1, 2]", "---", ""].join("\n"));
    expect(r.frontmatter.tags).toEqual(["a", "b", "c"]);
    expect(r.frontmatter.nums).toEqual([1, 2]);
  });

  it("parses block arrays", () => {
    const r = parseFrontmatter(["---", "tags:", "  - one", "  - two", "---", "body"].join("\n"));
    expect(r.frontmatter.tags).toEqual(["one", "two"]);
  });

  it("ignores comments + blank lines", () => {
    const r = parseFrontmatter(["---", "# a comment", "", "k: v", "---", ""].join("\n"));
    expect(r.frontmatter).toEqual({ k: "v" });
  });

  it("treats an unclosed block as no frontmatter (keeps body intact)", () => {
    const content = "---\ntitle: x\nno closing fence\nmore body";
    const r = parseFrontmatter(content);
    expect(r.hasFrontmatter).toBe(false);
    expect(r.body).toBe(content);
  });

  it("handles CRLF line endings", () => {
    const r = parseFrontmatter("---\r\ntitle: X\r\n---\r\nbody");
    expect(r.frontmatter.title).toBe("X");
    expect(r.body).toBe("body");
  });
});
