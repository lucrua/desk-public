// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "./Markdown";

const patterns = [
  { kind: "finding", idPattern: "F-\\d+" },
  { kind: "rfc", idPattern: "RFC-\\d+" },
];

describe("Markdown catalog auto-linking", () => {
  it("links a catalog ref in body prose for staff readers", () => {
    const html = renderToStaticMarkup(
      <Markdown content={"The fix relates to F-012 closely."} catalogPatterns={patterns} />,
    );
    expect(html).toContain('href="/catalog/finding/F-012"');
    expect(html).toContain("catalog-ref");
    expect(html).toContain(">F-012<");
  });

  it("renders the same body as plain text when no patterns are passed (share page rule)", () => {
    const html = renderToStaticMarkup(<Markdown content={"The fix relates to F-012 closely."} />);
    expect(html).not.toContain("/catalog/");
    expect(html).not.toContain("catalog-ref");
    expect(html).toContain("F-012");
  });

  it("does not link an id inside an inline code span", () => {
    const html = renderToStaticMarkup(
      <Markdown content={"call `F-012` literally"} catalogPatterns={patterns} />,
    );
    // The id stays inside <code>, not turned into an anchor.
    expect(html).not.toContain('href="/catalog/finding/F-012"');
    expect(html).toContain("<code");
  });

  it("does not break out of the href even for a permissive/odd id pattern (encoded)", () => {
    const html = renderToStaticMarkup(
      <Markdown
        content={`ref X-a"b here`}
        catalogPatterns={[{ kind: "x", idPattern: 'X-[\\w"]+' }]}
      />,
    );
    // The quote is percent-encoded in the href, so it can't terminate the attr.
    expect(html).toContain("/catalog/x/X-a%22b");
    expect(html).not.toContain('href="/catalog/x/X-a"b"');
  });

  it("links multiple refs across kinds", () => {
    const html = renderToStaticMarkup(
      <Markdown content={"F-1 implements RFC-7"} catalogPatterns={patterns} />,
    );
    expect(html).toContain('href="/catalog/finding/F-1"');
    expect(html).toContain('href="/catalog/rfc/RFC-7"');
  });
});
