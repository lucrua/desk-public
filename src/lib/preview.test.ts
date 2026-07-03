import { describe, it, expect } from "vitest";
import { docPreviewDescription } from "./preview";

describe("docPreviewDescription — frontmatter", () => {
  it("returns the frontmatter description when present (wins over body)", () => {
    expect(
      docPreviewDescription({
        parsedFrontmatter: { description: "A crisp hand-written summary." },
        renderedCache: "# Body\n\nSome other body text that should be ignored.",
      }),
    ).toBe("A crisp hand-written summary.");
  });

  it("prefers description over summary when both are present", () => {
    expect(
      docPreviewDescription({
        parsedFrontmatter: { description: "The description.", summary: "The summary." },
        renderedCache: "body",
      }),
    ).toBe("The description.");
  });

  it("falls back to summary when there is no description", () => {
    expect(
      docPreviewDescription({
        parsedFrontmatter: { summary: "Summary standing in." },
        renderedCache: "body",
      }),
    ).toBe("Summary standing in.");
  });

  it("trims surrounding whitespace on a frontmatter value", () => {
    expect(
      docPreviewDescription({
        parsedFrontmatter: { description: "  padded description  " },
        renderedCache: "body",
      }),
    ).toBe("padded description");
  });

  it("ignores an empty / whitespace-only frontmatter description and falls through to body", () => {
    expect(
      docPreviewDescription({
        parsedFrontmatter: { description: "   " },
        renderedCache: "The body wins.",
      }),
    ).toBe("The body wins.");
  });

  it("ignores a non-string frontmatter description and falls through to body", () => {
    expect(
      docPreviewDescription({
        parsedFrontmatter: { description: 123 },
        renderedCache: "The body wins.",
      }),
    ).toBe("The body wins.");
  });

  it("tolerates a null / non-object frontmatter", () => {
    expect(
      docPreviewDescription({ parsedFrontmatter: null, renderedCache: "Body only." }),
    ).toBe("Body only.");
    expect(
      docPreviewDescription({ parsedFrontmatter: undefined, renderedCache: "Body only." }),
    ).toBe("Body only.");
  });
});

describe("docPreviewDescription — body snippet", () => {
  it("strips markdown syntax (headings, emphasis, inline code, links, list markers)", () => {
    expect(
      docPreviewDescription({
        parsedFrontmatter: {},
        renderedCache:
          "# Heading\n\nThis is **bold** and *italic* and `code` and a [link](https://x.com).\n\n- item one\n- item two",
      }),
    ).toBe("Heading This is bold and italic and code and a link. item one item two");
  });

  it("strips HTML tags and decodes common entities", () => {
    expect(
      docPreviewDescription({
        parsedFrontmatter: {},
        renderedCache:
          "<p>Hello &amp; welcome to <strong>Desk</strong>. Q&amp;A&nbsp;time.</p>",
      }),
    ).toBe("Hello & welcome to Desk. Q&A time.");
  });

  it("drops fenced code blocks entirely", () => {
    expect(
      docPreviewDescription({
        parsedFrontmatter: {},
        renderedCache: "Intro line.\n\n```js\nconst secret = 42;\n```\n\nOutro line.",
      }),
    ).toBe("Intro line. Outro line.");
  });

  it("collapses runs of whitespace and trims", () => {
    expect(
      docPreviewDescription({
        parsedFrontmatter: {},
        renderedCache: "   lots\n\n\n   of    whitespace\t\there   ",
      }),
    ).toBe("lots of whitespace here");
  });

  it("returns a short body unchanged, without an ellipsis", () => {
    const out = docPreviewDescription({
      parsedFrontmatter: {},
      renderedCache: "Short and sweet.",
    });
    expect(out).toBe("Short and sweet.");
    expect(out.endsWith("…")).toBe(false);
  });

  it("truncates a long body to ≤200 chars with a trailing ellipsis", () => {
    const out = docPreviewDescription({
      parsedFrontmatter: {},
      renderedCache: "word ".repeat(80), // ~400 chars after collapse
    });
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.endsWith("…")).toBe(true);
    expect(out.startsWith("word")).toBe(true);
  });

  it("truncates a single unbroken long token to ≤200 chars with an ellipsis", () => {
    const out = docPreviewDescription({
      parsedFrontmatter: {},
      renderedCache: "x".repeat(500),
    });
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("docPreviewDescription — empty / edge inputs", () => {
  it("returns an empty string when there is no frontmatter description and no body", () => {
    expect(docPreviewDescription({ parsedFrontmatter: {}, renderedCache: null })).toBe("");
    expect(docPreviewDescription({ parsedFrontmatter: {}, renderedCache: "" })).toBe("");
    expect(docPreviewDescription({})).toBe("");
  });

  it("returns an empty string when the body is only markdown/HTML noise", () => {
    expect(
      docPreviewDescription({ parsedFrontmatter: {}, renderedCache: "<br/><hr>\n\n---" }),
    ).toBe("");
  });
});
