/**
 * Distribution overview — read-only, admin-only.
 *
 * Three lenses over the "who can see what" question:
 *
 *   byAudience  — per audience: members + docs visible to that audience.
 *   byUser      — per active user: which audiences + how many docs they can see.
 *   links       — all live (non-deleted) shares (doc + directory) with copy/status.
 *
 * Reuses the audiences-v2 scoping logic from docs.ts without reinventing it.
 * Deleted docs (docs.deleted_at IS NOT NULL) are excluded from all three lenses.
 */

import { eq, and, sql, isNull, desc } from "drizzle-orm";
import { db } from "@/db";
import {
  docs,
  docVersions,
  audiences,
  audienceMembers,
  users,
  userEmails,
  shares,
  shareViews,
} from "@/db/schema";
import { decryptToken } from "@/lib/crypto";

const SHARE_BASE_URL = process.env.SHARE_BASE_URL ?? "http://localhost:3000";

// ── byAudience ────────────────────────────────────────────────────────────────

export type AudienceDistEntry = {
  key: string;
  label: string;
  memberVisible: boolean;
  memberCount: number;
  members: string[];       // display names
  docCount: number;
  docs: Array<{ slug: string; title: string; path: string }>;
};

/**
 * Per-audience distribution: which docs live under each audience, and which
 * users are members of it. Only live (non-deleted) docs are counted.
 */
export async function distributionByAudience(): Promise<AudienceDistEntry[]> {
  // Load all audiences.
  const audRows = await db
    .select()
    .from(audiences)
    .orderBy(audiences.key);

  if (audRows.length === 0) return [];

  // Load live docs (not deleted, not unpublished).
  const docRows = await db
    .select({ slug: docs.slug, title: docs.title, path: docs.path, audience: docs.audience })
    .from(docs)
    .where(and(isNull(docs.deletedAt), isNull(docs.unpublishedAt)));

  // Load all audience members with their display names.
  const memberRows = await db
    .select({
      audienceId: audienceMembers.audienceId,
      displayName: users.displayName,
    })
    .from(audienceMembers)
    .innerJoin(users, eq(users.id, audienceMembers.userId))
    .where(eq(users.active, 1));

  // Build a lookup: audienceId → members
  const membersByAudId = new Map<number, string[]>();
  for (const m of memberRows) {
    const arr = membersByAudId.get(m.audienceId) ?? [];
    arr.push(m.displayName);
    membersByAudId.set(m.audienceId, arr);
  }

  return audRows.map((aud) => {
    const members = membersByAudId.get(aud.id) ?? [];
    const audDocs = docRows.filter((d) => d.audience === aud.key);
    return {
      key: aud.key,
      label: aud.label,
      memberVisible: aud.memberVisible === 1,
      memberCount: members.length,
      members,
      docCount: audDocs.length,
      docs: audDocs.map((d) => ({ slug: d.slug, title: d.title, path: d.path })),
    };
  });
}

// ── byUser ────────────────────────────────────────────────────────────────────

export type UserDistEntry = {
  id: number;
  displayName: string;
  emails: string[];
  role: string;
  audienceKeys: string[];
  visibleDocCount: number;
};

/**
 * Per-user distribution: for each active user, which audiences they can see
 * and how many live docs they can see.
 *
 * Visibility rule (audiences-v2):
 *   - Admins see ALL live docs (flagged in the response).
 *   - Members see docs whose audience is member_visible=1 (flag-visible) OR
 *     whose audience they are explicitly a member of.
 *
 * "Visible doc count" = distinct live (not deleted, not unpublished) docs in
 * any audience the user can see.
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

  // All audiences.
  const audRows = await db
    .select({ id: audiences.id, key: audiences.key, memberVisible: audiences.memberVisible })
    .from(audiences);

  // Flag-visible audience keys (member_visible = 1).
  const flagVisibleKeys = new Set(
    audRows.filter((a) => a.memberVisible === 1).map((a) => a.key),
  );
  const flagVisibleKeysList = [...flagVisibleKeys];

  // All audience memberships for active users.
  const membershipRows = await db
    .select({ userId: audienceMembers.userId, audienceId: audienceMembers.audienceId })
    .from(audienceMembers)
    .innerJoin(users, eq(users.id, audienceMembers.userId))
    .where(eq(users.active, 1));

  const audKeyById = new Map(audRows.map((a) => [a.id, a.key]));
  const membershipsByUserId = new Map<number, Set<string>>();
  for (const m of membershipRows) {
    const key = audKeyById.get(m.audienceId);
    if (!key) continue;
    const set = membershipsByUserId.get(m.userId) ?? new Set<string>();
    set.add(key);
    membershipsByUserId.set(m.userId, set);
  }

  // Count live docs per audience key.
  const docCountByAudKey = new Map<string, number>();
  const liveDocRows = await db
    .select({ audience: docs.audience, cnt: sql<number>`cast(count(*) as int)` })
    .from(docs)
    .where(and(isNull(docs.deletedAt), isNull(docs.unpublishedAt)))
    .groupBy(docs.audience);
  for (const r of liveDocRows) {
    docCountByAudKey.set(r.audience, r.cnt);
  }

  const totalLiveDocs = liveDocRows.reduce((s, r) => s + r.cnt, 0);

  return userRows.map((u) => {
    // Admins see everything.
    if (u.role === "admin") {
      const allAudienceKeys = audRows.map((a) => a.key);
      return {
        id: u.id,
        displayName: u.displayName,
        emails: emailsByUserId.get(u.id) ?? [],
        role: u.role,
        audienceKeys: allAudienceKeys,
        visibleDocCount: totalLiveDocs,
      };
    }

    // Member: flag-visible union membership.
    const membership = membershipsByUserId.get(u.id) ?? new Set<string>();
    const visibleKeys = new Set<string>([...flagVisibleKeysList, ...membership]);
    const audienceKeys = [...visibleKeys].sort();

    let visibleDocCount = 0;
    for (const key of visibleKeys) {
      visibleDocCount += docCountByAudKey.get(key) ?? 0;
    }

    return {
      id: u.id,
      displayName: u.displayName,
      emails: emailsByUserId.get(u.id) ?? [],
      role: u.role,
      audienceKeys,
      visibleDocCount,
    };
  });
}

// ── links ────────────────────────────────────────────────────────────────────

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
