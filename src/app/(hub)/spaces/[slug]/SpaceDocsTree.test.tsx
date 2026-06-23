// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import SpaceDocsTree, { type SpaceTreeDoc } from "./SpaceDocsTree";

const d = (
  slug: string,
  path: string,
  title = slug,
  unpublished = false,
): SpaceTreeDoc => ({ slug, path, title, format: "md", unpublished });

// A space whose docs span nested folders + a root doc — exercises grouping,
// deep nesting, and the empty-path root case.
const DOCS: SpaceTreeDoc[] = [
  d("welcome", "", "Welcome"),
  d("quarterly-report", "finance", "Quarterly report"),
  d("incident-response", "ops/runbooks", "Incident response"),
  d("backup-restore", "ops/runbooks", "Backup & restore"),
  d("onboarding-guide", "ops", "Onboarding guide"),
];

function render(docs: SpaceTreeDoc[]): string {
  return renderToStaticMarkup(<SpaceDocsTree docs={docs} />);
}

describe("SpaceDocsTree", () => {
  it("renders a tree container with the right ARIA roles", () => {
    const html = render(DOCS);
    expect(html).toContain('role="tree"');
    expect(html).toContain('role="treeitem"');
    expect(html).toContain('aria-label="Docs in this space"');
  });

  it("renders a folder header per derived folder (incl. nested) as a button", () => {
    const html = render(DOCS);
    // Top-level folders.
    expect(html).toContain("finance/");
    expect(html).toContain("ops/");
    // Nested folder (ops/runbooks) shows its last segment as the label.
    expect(html).toContain("runbooks/");
    // Folders are real toggle buttons (accessible + collapsible).
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("Collapse folder");
  });

  it("groups docs into the right folders by path — deep nesting under ops/runbooks", () => {
    const html = render(DOCS);
    // The two runbooks docs link to their viewer route.
    expect(html).toContain('href="/docs/incident-response"');
    expect(html).toContain('href="/docs/backup-restore"');
    // The single ops doc and the finance doc too.
    expect(html).toContain('href="/docs/onboarding-guide"');
    expect(html).toContain('href="/docs/quarterly-report"');
  });

  it("renders an empty-path doc at the space root (no folder needed)", () => {
    const html = render([d("welcome", "")]);
    expect(html).toContain('href="/docs/welcome"');
    // A root-only set implies no folders.
    expect(html).not.toContain("/</span>"); // no "<name>/" folder label
  });

  it("flags unpublished docs in the leaf meta line", () => {
    const html = render([d("draft", "ops", "Draft", true)]);
    expect(html).toContain("unpublished");
  });

  it("shows a recursive doc count on a folder header", () => {
    const html = render(DOCS);
    // ops contains 3 docs recursively (onboarding-guide + 2 runbooks).
    // Assert the count text appears somewhere in an ops folder header context.
    expect(html).toMatch(/ops\/<\/span>[\s\S]*?>3</);
  });
});
