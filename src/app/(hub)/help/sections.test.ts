import { describe, it, expect } from "vitest";
import {
  HELP_SECTIONS,
  isSectionVisible,
  isSectionAdminTagged,
  visibleSections,
  type HelpSection,
} from "./sections";

const find = (id: string): HelpSection => {
  const s = HELP_SECTIONS.find((x) => x.id === id);
  if (!s) throw new Error(`no section ${id}`);
  return s;
};

describe("help section visibility", () => {
  it("shows every section to an admin", () => {
    expect(visibleSections("admin")).toHaveLength(HELP_SECTIONS.length);
  });

  it("hides admin-only sections from members", () => {
    const memberIds = visibleSections("member").map((s) => s.id);
    expect(memberIds).not.toContain("publishing");
    expect(memberIds).not.toContain("sharing");
    expect(memberIds).not.toContain("users");
  });

  it("keeps shared + member-info sections for members", () => {
    const memberIds = visibleSections("member").map((s) => s.id);
    expect(memberIds).toContain("what-is-desk");
    expect(memberIds).toContain("reading");
    expect(memberIds).toContain("comments");
    expect(memberIds).toContain("editing");
    expect(memberIds).toContain("mcp");
    expect(memberIds).toContain("cli");
    expect(memberIds).toContain("syncing");
  });

  it("preserves page order in the visible subset", () => {
    const order = visibleSections("member").map((s) => s.id);
    const sorted = [...order].sort(
      (a, b) =>
        HELP_SECTIONS.findIndex((s) => s.id === a) -
        HELP_SECTIONS.findIndex((s) => s.id === b),
    );
    expect(order).toEqual(sorted);
  });

  it("tags admin-only sections as admin only for the admin reader", () => {
    expect(isSectionAdminTagged(find("publishing"), "admin")).toBe(true);
    expect(isSectionAdminTagged(find("sharing"), "admin")).toBe(true);
    expect(isSectionAdminTagged(find("users"), "admin")).toBe(true);
  });

  it("does not tag shared sections as admin", () => {
    expect(isSectionAdminTagged(find("what-is-desk"), "admin")).toBe(false);
    expect(isSectionAdminTagged(find("mcp"), "admin")).toBe(false);
    expect(isSectionAdminTagged(find("reading"), "admin")).toBe(false);
  });

  it("never tags anything for a member (admin sections are already hidden)", () => {
    for (const s of HELP_SECTIONS) {
      expect(isSectionAdminTagged(s, "member")).toBe(false);
    }
  });

  it("isSectionVisible agrees with visibleSections", () => {
    for (const role of ["admin", "member"] as const) {
      const viaPredicate = HELP_SECTIONS.filter((s) => isSectionVisible(s, role));
      expect(viaPredicate).toEqual(visibleSections(role));
    }
  });
});
