// Section model for the /help page.
//
// The page is a single document split into anchored sections. Each section
// declares an `audience`: who it is *for*. The reader's role (admin | member)
// decides whether a section renders, and — for admin-only operational steps
// shown to nobody-but-admins — whether it is omitted entirely vs. surfaced with
// an "admin" tag.
//
// Keeping this as a pure data + predicate module (no React) means the
// visibility logic is unit-testable without rendering, and the page component
// stays a thin mapper over `visibleSections(role)`.

export type Role = "admin" | "member";

/**
 * Who a section is for:
 *   - "all"        — everyone (admins and members) sees it, no tag.
 *   - "admin"      — admin-only. Members never see it; admins see it tagged
 *                    "admin" so the operator knows it's a privileged action.
 *   - "member-info"— framed for members ("what you can see"), but admins also
 *                    see it (no tag) since it's read-model context, not a gate.
 */
export type SectionAudience = "all" | "admin" | "member-info";

export type HelpSection = {
  /** Stable anchor id (used for the URL fragment and the on-page nav). */
  id: string;
  /** Nav label + section heading text. */
  title: string;
  /** Visibility / framing class. */
  audience: SectionAudience;
};

/**
 * Ordered table of contents for the help page. Order here is the order on the
 * page and in the nav. Titles double as the `<h2>` text and the nav link label.
 */
export const HELP_SECTIONS: readonly HelpSection[] = [
  { id: "what-is-desk", title: "What is Desk", audience: "all" },
  { id: "reading", title: "Reading & visibility", audience: "member-info" },
  { id: "search", title: "Search", audience: "all" },
  { id: "publishing", title: "Publishing", audience: "admin" },
  { id: "ownership", title: "Doc ownership", audience: "all" },
  { id: "sharing", title: "Sharing", audience: "admin" },
  { id: "link-lifecycle", title: "Link lifecycle", audience: "admin" },
  { id: "doc-lifecycle", title: "Doc lifecycle", audience: "admin" },
  { id: "distribution", title: "Distribution view", audience: "admin" },
  { id: "comments", title: "Comments", audience: "all" },
  { id: "editing", title: "Editing & approvals", audience: "all" },
  { id: "board", title: "Board", audience: "all" },
  { id: "catalog", title: "Catalog", audience: "all" },
  { id: "users", title: "Users & access", audience: "admin" },
  { id: "spaces", title: "Spaces & git", audience: "admin" },
  { id: "mcp", title: "Connecting an agent (MCP)", audience: "all" },
  { id: "cli", title: "CLI", audience: "all" },
  { id: "syncing", title: "Syncing local files", audience: "all" },
  { id: "recipes", title: "Recipes", audience: "all" },
] as const;

/**
 * Should this section render at all for `role`?
 * Admins see everything; members see everything except admin-only sections.
 */
export function isSectionVisible(section: HelpSection, role: Role): boolean {
  if (role === "admin") return true;
  return section.audience !== "admin";
}

/**
 * Does this section carry an "admin" tag for `role`?
 * Only admin-audience sections, and only when shown to an admin (members never
 * see admin sections, so the tag never reaches them).
 */
export function isSectionAdminTagged(section: HelpSection, role: Role): boolean {
  return role === "admin" && section.audience === "admin";
}

/** The sections visible to `role`, in page order. */
export function visibleSections(role: Role): HelpSection[] {
  return HELP_SECTIONS.filter((s) => isSectionVisible(s, role));
}
