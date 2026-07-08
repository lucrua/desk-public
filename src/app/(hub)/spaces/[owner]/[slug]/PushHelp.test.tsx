// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import PushHelp from "./PushHelp";

/**
 * Fix #1 (BLOCKER): the generated push snippet MUST target `main` explicitly —
 * Desk indexes only the `main` ref, so a bare `git push desk HEAD` from a local
 * `master` branch is accepted but renders nothing (silent failure). The snippet
 * has to read `git push desk HEAD:main`, and the block carries the visible
 * "Desk renders the `main` branch" note.
 */
const URL = "https://desk.example.com/api/git/owner/proj.git";

describe("PushHelp snippet", () => {
  it("pushes to HEAD:main (not bare HEAD) for a pusher", () => {
    const html = renderToStaticMarkup(<PushHelp repoUrl={URL} canPush={true} />);
    expect(html).toContain("git push desk HEAD:main");
    // The dangerous bare form must not appear.
    expect(html).not.toMatch(/git push desk HEAD(?!:main)/);
    // remote add + the URL are still present (clone-equivalent setup).
    expect(html).toContain(`git remote add desk ${URL}`);
  });

  it("surfaces the visible 'Desk renders the main branch' note to a pusher", () => {
    const html = renderToStaticMarkup(<PushHelp repoUrl={URL} canPush={true} />);
    expect(html).toContain("Desk renders the");
    expect(html).toContain("HEAD:main");
    expect(html).toContain('data-testid="push-render-note"');
  });

  it("shows the clone command for a reader (no push, no HEAD:main)", () => {
    const html = renderToStaticMarkup(<PushHelp repoUrl={URL} canPush={false} />);
    expect(html).toContain(`git clone ${URL}`);
    expect(html).not.toContain("git push");
  });
});
