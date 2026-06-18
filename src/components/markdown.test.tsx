// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "./Markdown";

const fixture = `# Heading one

## Heading two

Some prose with a [link](https://example.com) and \`F-012\` inline code.

| Col A | Col B |
|---|---|
| 1 | 2 |

> a quoted line

\`\`\`ts
const x: number = 1;
\`\`\`

\`\`\`mermaid
flowchart LR
  A --> B
\`\`\`
`;

describe("Markdown", () => {
  it("renders h1 and h2", () => {
    const html = renderToStaticMarkup(<Markdown content={fixture} />);
    expect(html).toContain("<h1>Heading one</h1>");
    expect(html).toContain("<h2>Heading two</h2>");
  });

  it("renders a GFM table", () => {
    const html = renderToStaticMarkup(<Markdown content={fixture} />);
    expect(html).toContain("<table>");
    expect(html).toContain("<th>Col A</th>");
  });

  it("applies hljs token classes to non-mermaid code fences", () => {
    const html = renderToStaticMarkup(<Markdown content={fixture} />);
    expect(html).toMatch(/class="hljs/);
    // a keyword token should be classed
    expect(html).toContain("hljs-keyword");
  });

  it("renders mermaid fences as the MermaidBlock placeholder, not a code block", () => {
    const html = renderToStaticMarkup(<Markdown content={fixture} />);
    expect(html).toContain('data-mermaid=""');
    // the mermaid source should NOT be highlighted as a normal code block
    expect(html).not.toContain("language-mermaid");
  });

  it("defaults to the partner wrapper and switches to operator", () => {
    const partner = renderToStaticMarkup(<Markdown content="# hi" />);
    expect(partner).toContain('class="md-partner"');

    const operator = renderToStaticMarkup(
      <Markdown content="# hi" register="operator" />,
    );
    expect(operator).toContain('class="md-operator"');
    expect(operator).not.toContain('class="md-partner"');
  });
});
