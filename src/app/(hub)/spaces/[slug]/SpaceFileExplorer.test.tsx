// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import type { AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import SpaceFileExplorer, { type FileEntry } from "./SpaceFileExplorer";

afterEach(cleanup);

// next/link reads the app-router context in a client (jsdom) render.
const stubRouter = {
  back: () => {},
  forward: () => {},
  refresh: () => {},
  push: () => {},
  replace: () => {},
  prefetch: () => {},
} as unknown as AppRouterInstance;

// A space whose files span a root doc, a root raw upload, and a nested doc under
// a folder — exercises collapse, doc-vs-raw linking, and folder nesting.
const FULL: FileEntry[] = [
  { path: "readme.md", isDoc: true, docSlug: "readme-slug" },
  { path: "logo.png", isDoc: false },
  { path: "finance/q3.md", isDoc: true, docSlug: "q3-slug" },
];

// What the page feeds a viewer OUTSIDE the raw-files gate: DOCS ONLY, no raw
// non-doc entry (mirrors the page's `explorerFiles` fallback).
const DOCS_ONLY: FileEntry[] = [
  { path: "readme.md", isDoc: true, docSlug: "readme-slug" },
  { path: "guide.md", isDoc: true, docSlug: "guide-slug" },
];

function html(files: FileEntry[]): string {
  return renderToStaticMarkup(<SpaceFileExplorer slug="acme" files={files} />);
}

describe("SpaceFileExplorer", () => {
  it("renders a tree with the right ARIA roles", () => {
    const out = html(FULL);
    expect(out).toContain('role="tree"');
    expect(out).toContain('role="treeitem"');
    expect(out).toContain('aria-label="Files in this space"');
  });

  it("folders start COLLAPSED by default (aria-expanded=false, children hidden)", () => {
    const out = html(FULL);
    // The one folder (finance) renders its header, collapsed.
    expect(out).toContain("finance/");
    expect(out).toContain('aria-expanded="false"');
    expect(out).not.toContain('aria-expanded="true"');
    expect(out).toContain("Expand folder finance");
    // Its nested doc is NOT rendered while collapsed.
    expect(out).not.toContain("/docs/q3-slug");
  });

  it("links a doc leaf to its rendered page and a raw leaf to the raw route", () => {
    const out = html(FULL);
    // Root-level leaves always render (no enclosing folder).
    expect(out).toContain('href="/docs/readme-slug"');
    expect(out).toContain('href="/api/spaces/acme/raw/logo.png"');
    // Raw leaves carry the "raw" badge; doc leaves the "doc" badge.
    expect(out).toContain(">raw<");
    expect(out).toContain(">doc<");
  });

  it("expands a folder on toggle, revealing its nested doc leaf", () => {
    render(
      <AppRouterContext.Provider value={stubRouter}>
        <SpaceFileExplorer slug="acme" files={FULL} />
      </AppRouterContext.Provider>,
    );
    // Collapsed: nested doc absent.
    expect(screen.queryByRole("link", { name: /q3\.md/i })).toBeNull();
    // Toggle the folder open.
    fireEvent.click(screen.getByRole("button", { name: /expand folder finance/i }));
    // Now the nested doc leaf links to its rendered page.
    const link = screen.getByRole("link", { name: /q3\.md/i });
    expect(link.getAttribute("href")).toBe("/docs/q3-slug");
  });

  it("BOUNDARY: a docs-only feed never renders a raw non-doc file or the raw route", () => {
    const out = html(DOCS_ONLY);
    // No raw route link, no "raw" badge — nothing outside the projected docs.
    expect(out).not.toContain("/api/spaces/");
    expect(out).not.toContain(">raw<");
    // The docs themselves still link to their rendered pages.
    expect(out).toContain('href="/docs/readme-slug"');
    expect(out).toContain('href="/docs/guide-slug"');
  });

  it("empty file list shows a friendly empty state, not an empty tree", () => {
    const out = html([]);
    expect(out).not.toContain('role="tree"');
    expect(out).toContain("No files yet");
  });
});
