// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import type { AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import AddUser from "./AddUser";

// Feature B: the token field must tell the admin to paste the Cloudflare Access
// Client ID (the `…access` value), NOT the Client Secret, and link to the MCP
// help. AddUser uses useRouter, so render under a stub router context.

const stubRouter = {
  back: () => {},
  forward: () => {},
  refresh: () => {},
  push: () => {},
  replace: () => {},
  prefetch: () => {},
} as unknown as AppRouterInstance;

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(
    <AppRouterContext.Provider value={stubRouter}>{node}</AppRouterContext.Provider>,
  );
}

describe("AddUser token-field clarity", () => {
  it("placeholder uses the <client-id>.access shape", () => {
    const html = render(<AddUser />);
    expect(html).toContain("&lt;client-id&gt;.access");
  });

  it("hint names Client ID, warns against the Client Secret, and links to /help#mcp", () => {
    const html = render(<AddUser />);
    expect(html).toContain("Client ID");
    expect(html).toContain("Client Secret");
    expect(html).toContain('href="/help#mcp"');
  });
});
