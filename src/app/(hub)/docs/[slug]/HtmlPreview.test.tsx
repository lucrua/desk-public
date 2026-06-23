// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import HtmlPreview from "./HtmlPreview";

afterEach(cleanup);

describe("HtmlPreview (operator Rendered/Source toggle)", () => {
  const content = "<h1>Artifact body</h1><script>1</script>";

  it("defaults to the rendered sandboxed iframe", () => {
    const { container } = render(<HtmlPreview content={content} title="t" />);
    const iframe = container.querySelector("iframe");
    expect(iframe).not.toBeNull();
    // Inherits SandboxedHtml's policy — scripts only, never same-origin.
    expect(iframe?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(container.querySelector("pre")).toBeNull();
  });

  it("toggles to a raw (inert) source view and back", () => {
    const { container } = render(<HtmlPreview content={content} title="t" />);

    fireEvent.click(screen.getByRole("button", { name: /source/i }));
    const pre = container.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre?.textContent).toContain(content); // shown as text, not executed
    expect(container.querySelector("iframe")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /rendered/i }));
    expect(container.querySelector("iframe")).not.toBeNull();
    expect(container.querySelector("pre")).toBeNull();
  });
});
