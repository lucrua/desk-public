// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import TokenSetupPromptView from "./TokenSetupPromptView";
import { renderTokenSetupPrompt } from "@/lib/tokens/setup-prompt";

/**
 * The global-setup prompt block renders the (live-credential) prompt verbatim in
 * a copy-able code block. This guards the wiring: the rendered prompt — bare host,
 * both credential commands, the token in password= — reaches the DOM, and a copy
 * control is present.
 */
describe("TokenSetupPromptView", () => {
  const prompt = renderTokenSetupPrompt({
    gitHostBase: "https://desk.example.com",
    token: "TKN123",
  });

  it("renders the prompt body (bare host, both commands, token) in the code block", () => {
    const html = renderToStaticMarkup(<TokenSetupPromptView prompt={prompt} />);
    expect(html).toContain('data-testid="token-setup-prompt"');
    expect(html).toContain("git config --global credential.helper store");
    expect(html).toContain("git credential approve");
    expect(html).toContain("host=desk.example.com");
    expect(html).toContain("password=TKN123");
    expect(html).not.toContain("host=https://");
  });

  it("offers a copy control", () => {
    const html = renderToStaticMarkup(<TokenSetupPromptView prompt={prompt} />);
    expect(html.toLowerCase()).toContain("copy");
  });
});
