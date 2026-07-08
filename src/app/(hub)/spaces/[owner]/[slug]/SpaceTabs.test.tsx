// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import SpaceTabs from "./SpaceTabs";

afterEach(cleanup);

const content = <div>the-content-body</div>;
const settings = <div>the-settings-body</div>;

describe("SpaceTabs (Content / Settings shell)", () => {
  it("lands on Content by default; the Settings panel exists but is hidden", () => {
    render(<SpaceTabs content={content} settings={settings} hasSettings={true} />);

    const contentTab = screen.getByRole("tab", { name: "Content" });
    const settingsTab = screen.getByRole("tab", { name: "Settings" });
    expect(contentTab.getAttribute("aria-selected")).toBe("true");
    expect(settingsTab.getAttribute("aria-selected")).toBe("false");

    // Content is the live panel; the Settings panel is hidden (excluded from the
    // a11y tree while `hidden`), so config is present but not shown up front.
    expect(screen.getByText("the-content-body")).not.toBeNull();
    expect(screen.getByRole("tabpanel", { name: "Content" })).not.toBeNull();
    expect(screen.queryByRole("tabpanel", { name: "Settings" })).toBeNull();
  });

  it("switching to Settings reveals config and hides Content", () => {
    render(<SpaceTabs content={content} settings={settings} hasSettings={true} />);

    fireEvent.click(screen.getByRole("tab", { name: "Settings" }));

    expect(screen.getByRole("tab", { name: "Settings" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "Content" }).getAttribute("aria-selected")).toBe("false");
    // The Settings panel is now the live one; Content is hidden.
    const settingsPanel = screen.getByRole("tabpanel", { name: "Settings" });
    expect(settingsPanel.textContent).toContain("the-settings-body");
    expect(screen.queryByRole("tabpanel", { name: "Content" })).toBeNull();
  });

  it("a viewer with no settings (hasSettings=false) sees NO Settings tab or panel", () => {
    render(<SpaceTabs content={content} settings={settings} hasSettings={false} />);

    expect(screen.getByRole("tab", { name: "Content" })).not.toBeNull();
    expect(screen.queryByRole("tab", { name: "Settings" })).toBeNull();
    // The settings group is not rendered at all — nothing is newly exposed.
    expect(screen.queryByText("the-settings-body")).toBeNull();
    expect(screen.getByText("the-content-body")).not.toBeNull();
  });
});
