// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import HelpNav from "./HelpNav";
import { visibleSections } from "./sections";

// Render smoke: the on-page nav reflects the role-filtered section list it is
// handed. The page server-component derives `visibleSections(role)` and passes
// it in; here we exercise the two role shapes directly. (Visibility *logic* is
// unit-tested in sections.test.ts; this asserts it reaches the DOM.)

describe("HelpNav render", () => {
  it("renders a nav link per visible section for an admin", () => {
    const sections = visibleSections("admin");
    const html = renderToStaticMarkup(<HelpNav sections={sections} />);
    expect(html).toContain('aria-label="On this page"');
    for (const s of sections) {
      expect(html).toContain(`href="#${s.id}"`);
      // Titles render as escaped HTML text (e.g. "&" → "&amp;").
      expect(html).toContain(s.title.replace(/&/g, "&amp;"));
    }
    // admin sees the admin-only sections in the TOC
    expect(html).toContain('href="#publishing"');
    expect(html).toContain('href="#users"');
  });

  it("omits admin-only sections from the member nav", () => {
    const html = renderToStaticMarkup(<HelpNav sections={visibleSections("member")} />);
    expect(html).not.toContain('href="#publishing"');
    expect(html).not.toContain('href="#sharing"');
    expect(html).not.toContain('href="#users"');
    // but keeps the shared ones
    expect(html).toContain('href="#what-is-desk"');
    expect(html).toContain('href="#mcp"');
    expect(html).toContain('href="#cli"');
  });

  it("renders nothing-breaking for an empty section list", () => {
    const html = renderToStaticMarkup(<HelpNav sections={[]} />);
    expect(html).toContain('aria-label="On this page"');
  });
});

// Fix #1 (BLOCKER): the Help "Spaces & git" section must teach the CORRECT push
// — `HEAD:main` (Desk indexes only `main`) — and show a push example, not just a
// clone. The page is a server component (depends on headers()/getPrincipal), so
// we assert against its source: the push example + the "renders the main branch"
// guidance must be present.
describe("Help — spaces push guidance", () => {
  const source = readFileSync(
    resolve(process.cwd(), "src/app/(hub)/help/page.tsx"),
    "utf8",
  );

  it("shows a push example targeting HEAD:main", () => {
    expect(source).toContain("git push desk HEAD:main");
  });

  it("states Desk renders the main branch", () => {
    expect(source).toContain("Desk renders the");
    // the {code("main")} ref note is present
    expect(source).toMatch(/renders the \{code\("main"\)\} branch/);
  });

  it("keeps a clone example too", () => {
    expect(source).toContain("git clone https://git:<token>");
  });
});
