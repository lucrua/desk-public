/**
 * Distribution overview — read-only, admin-only.
 *
 * Three lenses over the "who can see what" question (Gen-2: space-scoped):
 *
 *   bySpace  — per space: its members (display name + role) + the docs in it.
 *   byUser   — per active user: which SPACES they can see + how many docs.
 *   links    — all live (non-deleted) shares (doc + directory) with copy/status.
 *
 * Read access is SPACE-SCOPED (Gen-2 consolidation): a viewer sees a doc iff
 * they are a member of its space, OR the space.visibility ∈ {public, unlisted},
 * OR a capability share grants it. The Gen-1 audience model is fully REMOVED
 * (its tables + docs.audience were dropped in Slice 6). Mirrors the
 * space-scoping logic in docs.ts (memberVisibleSpaceIds).
 *
 * Deleted docs (docs.deleted_at IS NOT NULL) are excluded from all three lenses.
 *
 * NOTE: the first export is still named `distributionByAudience` for backward
 * compatibility with src/lib/mcp/tools.ts (distribution_overview tool), which
 * passes the result straight through as JSON. The shape is now space-oriented
 * (SpaceDistEntry). A `distributionBySpace` alias is exported for clarity.
 */

import { eq, and, sql, isNull, desc } from "drizzle-orm";
import { db } from "@/db";
import {
  docs,
  spaces,
  spaceMembers,
  users,
  userEmails,
  shares,
  shareViews,
} from "@/db/schema";

// ── bySpace (exported as distributionByAudience for tools.ts compat) ───────────

export type SpaceMemberEntry = { displayName: string; role: string };

export type SpaceDistEntry = {
  slug: string;
  visibility: "private" | "unlisted" | "public";
  /** true when the space is discoverable by any signed-in user (public/unlisted). */
  openVisible: boolean;
  memberCount: number;
  members: SpaceMemberEntry[];
  docCount: number;
  docs: Array<{ slug: string; title: string; path: string }>;
};

/**
 * Per-space distribution: which live docs live in each space, and which active
 * users are members of it (with their space-local role). Only live (not deleted,
 * not unpublished) docs are counted.
 *
 * Exported under the legacy name `distributionByAudience` (see file header) AND
 * as `distributionBySpace`; both resolve to the same implementation.
 */
export async function distributionBySpace(): Promise<SpaceDistEntry[]> {
  // Load all spaces.
  const spaceRows = await db
    .select({ id: spaces.id, slug: spaces.slug, visibility: spaces.visibility })
    .from(spaces)
    .orderBy(spaces.slug);

  if (spaceRows.length === 0) return [];

  // Load live docs (not deleted, not unpublished) with their owning space.
  const docRows = await db
    .select({ slug: docs.slug, title: docs.title, path: docs.path, spaceId: docs.spaceId })
    .from(docs)
    .where(and(isNull(docs.deletedAt), isNull(docs.unpublishedAt)));

  // Load all space members (active users only) with display name + role.
  const memberRows = await db
    .select({
      spaceId: spaceMembers.spaceId,
      role: spaceMembers.role,
      displayName: users.displayName,
    })
    .from(spaceMembers)
    .innerJoin(users, eq(users.id, spaceMembers.userId))
    .where(eq(users.active, 1));

  // Build lookups keyed by spaceId.
  const membersBySpaceId = new Map<number, SpaceMemberEntry[]>();
  for (const m of memberRows) {
    const arr = membersBySpaceId.get(m.spaceId) ?? [];
    arr.push({ displayName: m.displayName, role: m.role });
    membersBySpaceId.set(m.spaceId, arr);
  }

  const docsBySpaceId = new Map<number, Array<{ slug: string; title: string; path: string }>>();
  for (const d of docRows) {
    const arr = docsBySpaceId.get(d.spaceId) ?? [];
    arr.push({ slug: d.slug, title: d.title, path: d.path });
    docsBySpaceId.set(d.spaceId, arr);
  }

  return spaceRows.map((s) => {
    const members = membersBySpaceId.get(s.id) ?? [];
    const spaceDocs = docsBySpaceId.get(s.id) ?? [];
    return {
      slug: s.slug,
      visibility: s.visibility,
      openVisible: s.visibility === "public" || s.visibility === "unlisted",
      memberCount: members.length,
      members,
      docCount: spaceDocs.length,
      docs: spaceDocs,
    };
  });
}

/**
 * Backward-compatible export name for src/lib/mcp/tools.ts (distribution_overview).
 * Returns SPACE-based data (SpaceDistEntry[]); the audience model is retired.
 */
export const distributionByAudience = distributionBySpace;

// ── byUser ────────────────────────────────────────────────────────────────────

export type UserDistEntry = {
  id: number;
  displayName: string;
  emails: string[];
  role: string;
  /** Space slugs this user can see (member-of ∪ public/unlisted; admins see all). */
  visibleSpaces: string[];
  visibleDocCount: number;
};

/**
 * Per-user distribution: for each active user, which SPACES they can see and how
 * many live docs they can see.
 *
 * Visibility rule (Gen-2, space-scoped — mirrors docs.ts):
 *   - Admins see ALL live docs in ALL spaces (flagged in the response).
 *   - Members see docs in spaces they belong to (a space_members row) UNION
 *     spaces whose visibility is public/unlisted.
 *
 * "Visible doc count" = distinct live (not deleted, not unpublished) docs in any
 * space the user can see.
 */
export async function distributionByUser(): Promise<UserDistEntry[]> {
  // All active users.
  const userRows = await db
    .select({ id: users.id, displayName: users.displayName, role: users.role })
    .from(users)
    .where(eq(users.active, 1))
    .orderBy(users.id);

  if (userRows.length === 0) return [];

  // All user emails.
  const emailRows = await db
    .select({ userId: userEmails.userId, email: userEmails.email })
    .from(userEmails);

  const emailsByUserId = new Map<number, string[]>();
  for (const e of emailRows) {
    const arr = emailsByUserId.get(e.userId) ?? [];
    arr.push(e.email);
    emailsByUserId.set(e.userId, arr);
  }

  // All spaces.
  const spaceRows = await db
    .select({ id: spaces.id, slug: spaces.slug, visibility: spaces.visibility })
    .from(spaces);

  const slugBySpaceId = new Map(spaceRows.map((s) => [s.id, s.slug]));

  // Spaces discoverable by any signed-in user (public/unlisted).
  const openSpaceIds = new Set(
    spaceRows.filter((s) => s.visibility === "public" || s.visibility === "unlisted").map((s) => s.id),
  );

  // Space memberships for active users.
  const membershipRows = await db
    .select({ userId: spaceMembers.userId, spaceId: spaceMembers.spaceId })
    .from(spaceMembers)
    .innerJoin(users, eq(users.id, spaceMembers.userId))
    .where(eq(users.active, 1));

  const membershipsByUserId = new Map<number, Set<number>>();
  for (const m of membershipRows) {
    const set = membershipsByUserId.get(m.userId) ?? new Set<number>();
    set.add(m.spaceId);
    membershipsByUserId.set(m.userId, set);
  }

  // Count live docs per space id.
  const docCountBySpaceId = new Map<number, number>();
  const liveDocRows = await db
    .select({ spaceId: docs.spaceId, cnt: sql<number>`cast(count(*) as int)` })
    .from(docs)
    .where(and(isNull(docs.deletedAt), isNull(docs.unpublishedAt)))
    .groupBy(docs.spaceId);
  for (const r of liveDocRows) {
    docCountBySpaceId.set(r.spaceId, r.cnt);
  }

  const totalLiveDocs = liveDocRows.reduce((s, r) => s + r.cnt, 0);

  return userRows.map((u) => {
    // Admins see everything.
    if (u.role === "admin") {
      return {
        id: u.id,
        displayName: u.displayName,
        emails: emailsByUserId.get(u.id) ?? [],
        role: u.role,
        visibleSpaces: spaceRows.map((s) => s.slug),
        visibleDocCount: totalLiveDocs,
      };
    }

    // Member: open spaces ∪ membership.
    const membership = membershipsByUserId.get(u.id) ?? new Set<number>();
    const visibleSpaceIds = new Set<number>([...openSpaceIds, ...membership]);

    let visibleDocCount = 0;
    const visibleSpaces: string[] = [];
    for (const id of visibleSpaceIds) {
      visibleDocCount += docCountBySpaceId.get(id) ?? 0;
      const slug = slugBySpaceId.get(id);
      if (slug) visibleSpaces.push(slug);
    }
    visibleSpaces.sort();

    return {
      id: u.id,
      displayName: u.displayName,
      emails: emailsByUserId.get(u.id) ?? [],
      role: u.role,
      visibleSpaces,
      visibleDocCount,
    };
  });
}

// ── links (UNCHANGED — already reports shares, not audiences) ──────────────────

export type LinkDistEntry = {
  id: number;
  mode: "doc" | "dir";
  target: { slug: string; title: string } | { pathPrefix: string };
  label: string;
  status: "active" | "revoked" | "expired";
  views: number;
  createdBy: string;
  createdAt: Date;
  expiresAt: Date | null;
  canCopy: boolean;
};

/**
 * All live (non-deleted) shares — doc and directory — with their status and
 * copy availability. The capability-link lens for the distribution view.
 */
export async function distributionLinks(): Promise<LinkDistEntry[]> {
  const rows = await db
    .select({
      id: shares.id,
      tokenEnc: shares.tokenEnc,
      docId: shares.docId,
      docSlug: docs.slug,
      docTitle: docs.title,
      pathPrefix: shares.pathPrefix,
      label: shares.label,
      createdBy: shares.createdBy,
      createdAt: shares.createdAt,
      expiresAt: shares.expiresAt,
      revokedAt: shares.revokedAt,
      viewCount: sql<number>`cast(count(${shareViews.id}) as int)`,
    })
    .from(shares)
    .leftJoin(docs, eq(docs.id, shares.docId))
    .leftJoin(shareViews, eq(shareViews.shareId, shares.id))
    .where(isNull(shares.deletedAt))
    .groupBy(shares.id, docs.slug, docs.title)
    .orderBy(desc(shares.createdAt), desc(shares.id));

  const now = new Date();

  return rows.map((r) => {
    const isExpired = r.expiresAt !== null && r.expiresAt <= now;
    const isRevoked = r.revokedAt !== null;
    const status: "active" | "revoked" | "expired" = isExpired
      ? "expired"
      : isRevoked
        ? "revoked"
        : "active";
    const canCopy = r.tokenEnc !== null && status === "active";

    const mode: "doc" | "dir" = r.pathPrefix !== null ? "dir" : "doc";
    const target =
      mode === "dir"
        ? { pathPrefix: r.pathPrefix! }
        : { slug: r.docSlug ?? "", title: r.docTitle ?? "" };

    return {
      id: r.id,
      mode,
      target,
      label: r.label,
      status,
      views: r.viewCount,
      createdBy: r.createdBy,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      canCopy,
    };
  });
}
