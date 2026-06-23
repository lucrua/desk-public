// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import SandboxedHtml from "./SandboxedHtml";

describe("SandboxedHtml (artifact sandbox policy)", () => {
  it("sandboxes with allow-scripts and NEVER allow-same-origin", () => {
    const html = renderToStaticMarkup(
      <SandboxedHtml content="<script>parent.document.cookie</script>" title="t" />,
    );
    expect(html).toContain('sandbox="allow-scripts"');
    // The combination allow-scripts + allow-same-origin lets a frame remove its
    // own sandbox. Guard against anyone ever widening the policy.
    expect(html).not.toContain("allow-same-origin");
  });

  it("passes content via srcDoc (opaque origin), not a src URL", () => {
    const html = renderToStaticMarkup(
      <SandboxedHtml content="<p>hi</p>" title="t" />,
    );
    expect(html).toMatch(/srcdoc=/i);
    expect(html).not.toMatch(/\ssrc=/i);
  });
});
