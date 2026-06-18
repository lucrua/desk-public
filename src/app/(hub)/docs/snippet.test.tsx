// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { splitSnippet, snippetToMarkdown } from "./view-model";
import { SNIPPET_START, SNIPPET_STOP } from "@/lib/docs";

const START = SNIPPET_START;
const STOP = SNIPPET_STOP;

describe("splitSnippet", () => {
  it("returns [] for an empty snippet", () => {
    expect(splitSnippet("")).toEqual([]);
  });

  it("splits plain + match runs in order", () => {
    const snip = `before ${START}match${STOP} after`;
    expect(splitSnippet(snip)).toEqual([
      { text: "before ", match: false },
      { text: "match", match: true },
      { text: " after", match: false },
    ]);
  });

  it("handles multiple matches", () => {
    const snip = `${START}a${STOP} mid ${START}b${STOP}`;
    expect(splitSnippet(snip)).toEqual([
      { text: "a", match: true },
      { text: " mid ", match: false },
      { text: "b", match: true },
    ]);
  });

  it("treats text that looks like an HTML tag as plain DATA, not markup", () => {
    const snip = `lead <img src=x onerror=alert(1)> ${START}hit${STOP} tail`;
    const runs = splitSnippet(snip);
    // The <img …> chunk is a single plain run — never interpreted.
    expect(runs[0]).toEqual({ text: "lead <img src=x onerror=alert(1)> ", match: false });
    expect(runs.find((r) => r.match)).toEqual({ text: "hit", match: true });
  });
});

describe("snippetToMarkdown (MCP channel)", () => {
  it("wraps matches in ** and passes plain text through", () => {
    const snip = `intro ${START}term${STOP} outro`;
    expect(snippetToMarkdown(snip)).toBe("intro **term** outro");
  });

  it("leaves a body's <img …> as inert text (no markup injected)", () => {
    const snip = `x <img onerror=alert(1)> ${START}y${STOP}`;
    const md = snippetToMarkdown(snip);
    expect(md).toBe("x <img onerror=alert(1)> **y**");
    // No delimiter control chars leak.
    expect(md).not.toMatch(/[\x02\x03]/);
  });
});

// The UI renders runs as React text + <mark> nodes. React escapes text, so a
// doc body that contains an injection payload becomes inert text in the DOM.
// We render the same run shape the SnippetLine component uses and assert no
// raw <img …> tag survives — the `<` from content is escaped to `&lt;`.
function renderRuns(snippet: string) {
  const runs = splitSnippet(snippet);
  return renderToStaticMarkup(
    <p>
      {runs.map((r, i) =>
        r.match ? <mark key={i}>{r.text}</mark> : <span key={i}>{r.text}</span>,
      )}
    </p>,
  );
}

describe("snippet UI render — XSS", () => {
  it("a body containing <img onerror=…> renders escaped, with no executable tag", () => {
    const snip = `prefix <img src=x onerror=alert(1)> ${START}target${STOP} suffix`;
    const html = renderRuns(snip);
    // The match is a real <mark> element.
    expect(html).toContain("<mark>target</mark>");
    // The injected payload is escaped — it must NOT appear as a raw <img tag.
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    // No onerror handler reaches the DOM as an attribute.
    expect(html).not.toMatch(/<[a-z]+[^>]*onerror=/i);
  });
});
