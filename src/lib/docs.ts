import { createHash } from "node:crypto";
import { eq, and, desc, ilike, or, sql, inArray, like, isNull } from "drizzle-orm";
import { db, schema } from "@/db";
import { docs, docVersions, audiences, audienceMembers, comments, shares, users } from "@/db/schema";
import { emitEvent } from "@/lib/events";
import { resolveMemberUserId } from "@/lib/cards";
import type { Principal } from "@/lib/auth";
import { normalizePath } from "@/lib/path";
import { SNIPPET_START, SNIPPET_STOP } from "@/lib/snippet-delim";

/**
 * Audience visibility (Audiences v2 — audiences are real GROUPS). Admins see
 * every doc. A member sees a doc iff:
 *
 *   audience.member_visible = 1            (the "all members" switch)
 *   OR the member's user row is in that audience's membership list.
 *
 * Both halves are admin-configurable. Anonymous never reaches this layer (routes
 * gate them first). The predicate is computed ONCE — `memberVisibleAudienceKeys`
 * resolves the full set of audience keys a given member may see (flag-visible ∪
 * keys-they're-a-member-of) and every read surface (listDocs / searchDocs /
 * getDocBySlug / canSeeAudience / the events feed) scopes through it.
 *
 * Fail-closed: a member with no users row (dev mode / brand-new principal) has
 * `userId == null` → no memberships → only the flag-visible keys (the v1
 * behaviour), never another member's targeted docs.
 */

/**
 * The set of audience keys a member may see: keys marked member_visible=1 UNION
 * keys whose audience has the member (userId) in its membership list. Used to
 * scope member queries DB-side rather than per-row. `userId` null → membership
 * half is empty (fail-closed to flag-only). Admins never call this.
 */
async function memberVisibleAudienceKeys(
  userId: number | null | undefined,
): Promise<string[]> {
  // Flag-visible keys (everyone signed in).
  const flagRows = await db
    .select({ key: audiences.key })
    .from(audiences)
    .where(eq(audiences.memberVisible, 1));

  // Membership-visible keys (this specific member belongs to the audience).
  // Skip the query entirely when there's no user row — nothing can match.
  const memberRows =
    userId != null
      ? await db
          .select({ key: audiences.key })
          .from(audienceMembers)
          .innerJoin(audiences, eq(audiences.id, audienceMembers.audienceId))
          .where(eq(audienceMembers.userId, userId))
      : [];

  // Dedup (a key can be both flag-visible AND have an explicit membership).
  const keys = new Set<string>();
  for (const r of flagRows) keys.add(r.key);
  for (const r of memberRows) keys.add(r.key);
  return [...keys];
}

/**
 * DB-driven audience check for a single doc. Admins see everything; a member
 * sees a doc iff its audience is flag-visible OR the member belongs to it.
 * `userId` is the member's resolved users-row id (null → flag-only). Async
 * because the answer lives in the audiences / audience_members tables.
 */
export async function canSeeAudience(
  viewer: "admin" | "member",
  audience: string,
  userId?: number | null,
): Promise<boolean> {
  if (viewer === "admin") return true;
  // Flag-visible?
  const flag = await db.query.audiences.findFirst({
    where: and(eq(audiences.key, audience), eq(audiences.memberVisible, 1)),
  });
  if (flag != null) return true;
  // Membership-visible? (only when we resolved a user row)
  if (userId == null) return false;
  const member = await db
    .select({ id: audienceMembers.id })
    .from(audienceMembers)
    .innerJoin(audiences, eq(audiences.id, audienceMembers.audienceId))
    .where(and(eq(audiences.key, audience), eq(audienceMembers.userId, userId)))
    .limit(1);
  return member.length > 0;
}

/**
 * Viewer scope passed to service functions that enforce audience visibility.
 * `userId` is the member's resolved users-row id (Audiences v2) — it decides
 * which membership-targeted audiences this viewer can see. Absent/null on
 * admins (they see all) and on members with no users row (flag-only, fail-
 * closed). Build it with `scopeForPrincipal`.
 */
export type ViewerScope = { viewer: "admin" | "member"; userId?: number | null };

/**
 * Resolve a request principal to the ViewerScope the read surfaces expect.
 * Admin → { viewer: "admin" } (sees everything; userId irrelevant). Member →
 * { viewer: "member", userId } with userId resolved via resolveMemberUserId
 * (null when there's no users row — fail-closed to flag-only visibility).
 *
 * This is the ONE place that turns a principal into a membership-aware scope, so
 * every call site stays a single `await scopeForPrincipal(principal)`.
 */
export async function scopeForPrincipal(
  principal: Principal,
): Promise<ViewerScope> {
  if (principal.kind === "admin") return { viewer: "admin" };
  if (principal.kind === "member") {
    return { viewer: "member", userId: await resolveMemberUserId(principal) };
  }
  // Anonymous never reaches a scoped read (routes gate first), but be explicit:
  // treat as a member with no memberships (flag-only). Callers gate anonymous
  // before this anyway.
  return { viewer: "member", userId: null };
}

export type PublishInput = {
  slug: string;
  title: string;
  sourcePath: string;
  audience: string;
  format: "md" | "html";
  content: string;
  by: string;
  /**
   * Optional folder path (already validated/canonicalized by the caller via
   * normalizePath). Omitted → on a NEW doc the column default ('') applies; on
   * an EXISTING doc the path is left unchanged (publish never silently moves a
   * doc — use setDocPath for that).
   */
  path?: string;
  /**
   * Optimistic-concurrency guard. When provided on an EXISTING doc and it does
   * not equal the doc's current version id, publishDoc returns a `conflict`
   * result instead of appending (the caller maps it to 409). Absent → current
   * append-anyway behaviour (back-compat). Ignored on a brand-new doc (nothing
   * to conflict with).
   */
  baseVersionId?: number;
  /**
   * The creating user's id (from principal.userId). Set on CREATE as the doc's
   * initial owner; ignored on UPDATE (owner never changes via publish).
   */
  ownerUserId?: number;
};

export type PublishResult =
  | { ok: true; slug: string; versionId: number; versionNumber: number; isNewDoc: boolean; isNewVersion: boolean; ownerUserId: number | null }
  | {
      ok: false;
      conflict: true;
      currentVersionId: number;
      currentContentHash: string;
    };

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Recompute docs.search_tsv for one doc from its title + CURRENT version
 * content (title weight 'A', content weight 'B'). Runs INSIDE publishDoc's
 * transaction so the FTS vector commits atomically with the version it
 * indexes. `content` is the body of the version that just became current.
 * Title comes from the row (already updated to the new title by the caller's
 * mutableSet). We pass both as bound params so to_tsvector parses them as
 * data, never as SQL.
 */
async function refreshSearchTsv(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  docId: number,
  title: string,
  content: string,
): Promise<void> {
  await tx.execute(sql`
    update ${docs}
    set search_tsv =
      setweight(to_tsvector('english', ${title}), 'A') ||
      setweight(to_tsvector('english', ${content}), 'B')
    where ${docs.id} = ${docId}
  `);
}

export async function publishDoc(input: PublishInput): Promise<PublishResult> {
  return db.transaction(async (tx) => {
    const { slug, title, sourcePath, audience, format, content, by } = input;
    const contentHash = sha256(content);

    // Look up the LIVE doc (deleted_at IS NULL) by slug.
    // A deleted doc's slug is free — publishing at that slug creates a brand-new
    // doc_id (slug reuse: the partial unique index only covers live rows).
    const existing = await tx
      .select()
      .from(docs)
      .where(and(eq(docs.slug, slug), isNull(docs.deletedAt)))
      .limit(1);

    let docId: number;
    let currentVersionId: number | null;
    const isNewDoc = existing.length === 0;

    if (existing.length === 0) {
      // Insert new doc — apply path if supplied (else column default '').
      // On CREATE, set owner_user_id = the creating user (input.ownerUserId).
      // Never change the owner on update.
      const [inserted] = await tx
        .insert(docs)
        .values({
          slug,
          title,
          sourcePath,
          audience,
          format,
          ...(input.path !== undefined ? { path: input.path } : {}),
          ...(input.ownerUserId !== undefined ? { ownerUserId: input.ownerUserId } : {}),
        })
        .returning();
      docId = inserted.id;
      currentVersionId = null;
    } else {
      docId = existing[0].id;
      currentVersionId = existing[0].currentVersionId;
    }

    // Optimistic concurrency: only meaningful on an existing doc that has a
    // current version. A mismatch is a conflict — return without mutating.
    if (
      input.baseVersionId !== undefined &&
      currentVersionId !== null &&
      input.baseVersionId !== currentVersionId
    ) {
      const [cur] = await tx
        .select({ hash: docVersions.contentHash })
        .from(docVersions)
        .where(eq(docVersions.id, currentVersionId))
        .limit(1);
      return {
        ok: false,
        conflict: true,
        currentVersionId,
        currentContentHash: cur?.hash ?? "",
      };
    }

    // Mutable-field set, optionally including path when the caller passed one.
    const mutableSet = (extra: Record<string, unknown>) => ({
      title,
      sourcePath,
      audience,
      format,
      ...(input.path !== undefined ? { path: input.path } : {}),
      ...extra,
    });

    // Check if current version hash matches
    if (currentVersionId !== null) {
      const [currentVersion] = await tx
        .select()
        .from(docVersions)
        .where(eq(docVersions.id, currentVersionId))
        .limit(1);

      if (currentVersion && currentVersion.contentHash === contentHash) {
        // Same content — NO-OP, but still update mutable fields and clear
        // unpublishedAt. A no-op publish is NOT a new version → no event.
        await tx
          .update(docs)
          .set(mutableSet({ unpublishedAt: null }))
          .where(eq(docs.id, docId));

        // The title may have changed even when content didn't, so the FTS
        // vector (title weight 'A') must be refreshed here too. Content is
        // unchanged (this branch is the equal-hash case).
        await refreshSearchTsv(tx, docId, title, content);

        const [countRow] = await tx
          .select({ count: sql<number>`cast(count(*) as int)` })
          .from(docVersions)
          .where(eq(docVersions.docId, docId));
        const versionNumber = countRow?.count ?? 1;

        // Reload the owner from the existing row (it's not in existing[] before the update).
        const [ownerRow] = await tx.select({ ownerUserId: docs.ownerUserId }).from(docs).where(eq(docs.id, docId)).limit(1);
        return { ok: true, slug, versionId: currentVersionId, versionNumber, isNewDoc: false, isNewVersion: false, ownerUserId: ownerRow?.ownerUserId ?? null };
      }
    }

    // New version — insert
    const [newVersion] = await tx
      .insert(docVersions)
      .values({ docId, content, contentHash, publishedBy: by })
      .returning();

    // Update doc: new currentVersionId, clear unpublishedAt, update mutable fields
    await tx
      .update(docs)
      .set(mutableSet({ currentVersionId: newVersion.id, unpublishedAt: null }))
      .where(eq(docs.id, docId));

    // Maintain the FTS vector from the new current version's title + content,
    // inside the same transaction (rollback ⇒ no stale index).
    await refreshSearchTsv(tx, docId, title, content);

    // Event appended INSIDE the same transaction — a rolled-back publish emits
    // nothing. Payload carries references only (slug + versionId + audience),
    // never the doc content.
    await emitEvent(tx, {
      kind: "doc.published",
      docId,
      payload: {
        slug,
        versionId: newVersion.id,
        contentHash,
        audience,
        format,
      },
      actorName: by,
    });

    const [countRow] = await tx
      .select({ count: sql<number>`cast(count(*) as int)` })
      .from(docVersions)
      .where(eq(docVersions.docId, docId));
    const versionNumber = countRow?.count ?? 1;

    // Reload the owner: on a new doc it's what we just inserted; on an update
    // it's the existing owner (we never change it). Pull from the freshly-updated row.
    const [ownerRow] = await tx.select({ ownerUserId: docs.ownerUserId }).from(docs).where(eq(docs.id, docId)).limit(1);
    return { ok: true, slug, versionId: newVersion.id, versionNumber, isNewDoc, isNewVersion: true, ownerUserId: ownerRow?.ownerUserId ?? null };
  });
}

export async function unpublishDoc(slug: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    // Only LIVE docs can be unpublished. Deleted docs are invisible.
    const existing = await tx
      .select()
      .from(docs)
      .where(and(eq(docs.slug, slug), isNull(docs.deletedAt)))
      .limit(1);

    if (existing.length === 0) return false;
    const doc = existing[0];

    // Idempotency: only emit when the doc actually transitions to unpublished.
    const wasPublished = doc.unpublishedAt === null;

    await tx
      .update(docs)
      .set({ unpublishedAt: new Date() })
      .where(eq(docs.id, doc.id));

    if (wasPublished) {
      await emitEvent(tx, {
        kind: "doc.unpublished",
        docId: doc.id,
        payload: { slug: doc.slug, audience: doc.audience },
        actorName: "system",
      });
    }

    return true;
  });
}

/**
 * Stage-2 delete a doc (admin action). In one transaction:
 *   1. Sets docs.deleted_at (tombstone).
 *   2. Purges version content: UPDATE doc_versions SET content = '' WHERE doc_id = ...
 *      (rows kept so comments/revisions/share_views/pinned FKs stay valid).
 *   3. Stage-2 deletes every doc-share of this doc (sets revoked_at + deleted_at).
 *   4. Emits doc.deleted event (payload: docId, slug, path — no content).
 *
 * Works whether the doc was published or already unpublished. Returns false
 * for an unknown slug OR a doc that is already deleted (treat as not-found).
 *
 * This is DESTRUCTIVE and terminal: content is irrecoverable (purged in-place),
 * the slug is freed for reuse, and there is no undo.
 */
export async function deleteDoc(slug: string, actor: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    // Must be a LIVE doc (deleted_at IS NULL).
    const [doc] = await tx
      .select()
      .from(docs)
      .where(and(eq(docs.slug, slug), isNull(docs.deletedAt)))
      .limit(1);

    if (!doc) return false;

    const now = new Date();

    // 1. Tombstone the doc row.
    await tx
      .update(docs)
      .set({ deletedAt: now })
      .where(eq(docs.id, doc.id));

    // 2. Purge all version content (keep rows for FK integrity).
    await tx
      .update(docVersions)
      .set({ content: "" })
      .where(eq(docVersions.docId, doc.id));

    // 3. Stage-2 delete every doc-share of this doc (revoke + delete).
    // Use ISO string for the COALESCE arg so postgres.js doesn't reject a Date object
    // inside a raw sql template.
    const nowIso = now.toISOString();
    await tx
      .update(shares)
      .set({
        deletedAt: now,
        revokedAt: sql`COALESCE(${shares.revokedAt}, ${nowIso}::timestamp)`,
      })
      .where(and(eq(shares.docId, doc.id), isNull(shares.deletedAt)));

    // 4. Emit doc.deleted event inside the transaction.
    await emitEvent(tx, {
      kind: "doc.deleted",
      docId: doc.id,
      payload: { slug: doc.slug, path: doc.path },
      actorName: actor,
    });

    return true;
  });
}

/**
 * Move a doc to a new folder path (organizational only — identity stays the
 * slug, audience/visibility unchanged). `path` must already be canonicalized
 * via normalizePath. Returns:
 *   - "ok" when the move applied (and a doc.moved event was emitted).
 *   - "noop" when the new path equals the current one (no event).
 *   - "not-found" when the slug is unknown.
 *
 * Emits doc.moved {slug, from_path, to_path} in the same transaction.
 */
export type SetDocPathResult = "ok" | "noop" | "not-found";

export async function setDocPath(
  slug: string,
  path: string,
  by: string,
): Promise<SetDocPathResult> {
  return db.transaction(async (tx) => {
    const [doc] = await tx
      .select()
      .from(docs)
      .where(and(eq(docs.slug, slug), isNull(docs.deletedAt)))
      .limit(1);
    if (!doc) return "not-found";

    const fromPath = doc.path;
    if (fromPath === path) return "noop";

    await tx.update(docs).set({ path }).where(eq(docs.id, doc.id));

    await emitEvent(tx, {
      kind: "doc.moved",
      docId: doc.id,
      payload: { slug: doc.slug, from_path: fromPath, to_path: path },
      actorName: by,
    });

    return "ok";
  });
}

export type SetDocOwnerResult = "ok" | "not-found" | "invalid-user";

/**
 * Reassign a doc's owner (admin action). Sets docs.owner_user_id to a new
 * user id (must be an ACTIVE users row). Emits a `doc.owner_changed` event
 * in-transaction. Returns:
 *   - "ok" when the owner changed (or was the same — idempotent).
 *   - "not-found" when the slug is unknown or doc is deleted.
 *   - "invalid-user" when the target user does not exist or is inactive.
 */
export async function setDocOwner(
  slug: string,
  ownerUserId: number,
  actor: string,
): Promise<SetDocOwnerResult> {
  // Validate target user exists and is active BEFORE the transaction.
  const targetUser = await db.query.users.findFirst({
    where: eq(users.id, ownerUserId),
  });
  if (!targetUser || targetUser.active !== 1) return "invalid-user";

  return db.transaction(async (tx) => {
    const [doc] = await tx
      .select()
      .from(docs)
      .where(and(eq(docs.slug, slug), isNull(docs.deletedAt)))
      .limit(1);
    if (!doc) return "not-found";

    const fromUserId = doc.ownerUserId;

    await tx
      .update(docs)
      .set({ ownerUserId })
      .where(eq(docs.id, doc.id));

    await emitEvent(tx, {
      kind: "doc.owner_changed",
      docId: doc.id,
      payload: {
        slug: doc.slug,
        fromUserId: fromUserId ?? null,
        toUserId: ownerUserId,
      },
      actorName: actor,
    });

    return "ok";
  });
}

export type SetDocAudienceResult = "ok" | "noop" | "not-found";

/**
 * Change a doc's audience (Audiences v2 — its visibility group). The caller must
 * have validated that `audience` is an existing audience key. Returns:
 *   - "ok" when the audience changed.
 *   - "noop" when it already equals the doc's current audience (no event).
 *   - "not-found" when the slug is unknown.
 *
 * Emits doc.published? No — this is metadata only (no new version). We don't
 * emit a dedicated event for an audience change (the doc.* event set is
 * version-scoped); the membership/flag model decides visibility on read.
 */
export async function setDocAudience(
  slug: string,
  audience: string,
  _by: string,
): Promise<SetDocAudienceResult> {
  const [doc] = await db
    .select({ id: docs.id, audience: docs.audience })
    .from(docs)
    .where(and(eq(docs.slug, slug), isNull(docs.deletedAt)))
    .limit(1);
  if (!doc) return "not-found";
  if (doc.audience === audience) return "noop";
  await db.update(docs).set({ audience }).where(eq(docs.id, doc.id));
  return "ok";
}

type DocRow = typeof docs.$inferSelect;
type VersionRow = typeof docVersions.$inferSelect;

export async function getDocBySlug(
  slug: string,
  opts?: { includeUnpublished?: boolean; scope?: ViewerScope }
): Promise<{ doc: DocRow; version: VersionRow | null } | null> {
  // Always exclude deleted docs (deleted_at IS NOT NULL) — treat as not-found.
  const rows = await db
    .select()
    .from(docs)
    .where(and(eq(docs.slug, slug), isNull(docs.deletedAt)))
    .limit(1);

  if (rows.length === 0) return null;

  const doc = rows[0];

  if (!opts?.includeUnpublished && doc.unpublishedAt !== null) {
    return null;
  }

  // Audience scoping: if a viewer scope is provided, members may only see docs
  // whose audience is member-visible. Return null (indistinguishable from
  // not-found) so no existence signal leaks.
  if (
    opts?.scope &&
    !(await canSeeAudience(opts.scope.viewer, doc.audience, opts.scope.userId))
  ) {
    return null;
  }

  let version: VersionRow | null = null;
  if (doc.currentVersionId !== null) {
    const versionRows = await db
      .select()
      .from(docVersions)
      .where(eq(docVersions.id, doc.currentVersionId))
      .limit(1);
    version = versionRows[0] ?? null;
  }

  return { doc, version };
}

export type DocListItem = {
  slug: string;
  title: string;
  audience: string;
  format: "md" | "html";
  /** Folder path ('' = root). */
  path: string;
  versionCount: number;
  updatedAt: Date;
  /** Count of unresolved comments on the doc — feeds the docs-list badge. */
  unresolvedComments: number;
  /** Non-null when the doc has been unpublished (only ever returned to admins). */
  unpublishedAt: Date | null;
  /** The owner's users.id, or null for docs created before ownership was added. */
  ownerUserId: number | null;
};

export async function listDocs(opts?: {
  includeUnpublished?: boolean;
  /** Case-insensitive substring filter over title + slug (Postgres ilike). */
  q?: string;
  /**
   * Folder-path prefix filter. '' (or omitted) = no filter (all paths). A
   * non-empty prefix matches the path itself and any descendant (so 'os'
   * matches 'os' and 'os/canon'). Already canonicalized by the caller.
   */
  path?: string;
  /** When provided, filters results to only docs the viewer may see. */
  scope?: ViewerScope;
}): Promise<DocListItem[]> {
  // Trim so "   " behaves like "no filter".
  const q = opts?.q?.trim();
  const searchFilter = q
    ? or(ilike(docs.title, `%${q}%`), ilike(docs.slug, `%${q}%`))
    : undefined;

  // Path-prefix filter: a non-empty prefix matches the folder itself and its
  // descendants. Escape LIKE metacharacters in the prefix so a stray % / _ in a
  // (validated) path can't widen the match.
  const prefix = opts?.path?.trim();
  const pathFilter =
    prefix && prefix.length > 0
      ? or(
          eq(docs.path, prefix),
          like(docs.path, `${prefix.replace(/[%_\\]/g, "\\$&")}/%`),
        )
      : undefined;

  // Audience scoping (DB-side): a member sees only docs whose audience is in
  // the member-visible set. Build the filter before the query so it lands in
  // the WHERE clause (no N+1, no per-row post-filter). Admins get no filter.
  let audienceFilter = undefined;
  if (opts?.scope && opts.scope.viewer === "member") {
    const keys = await memberVisibleAudienceKeys(opts.scope.userId);
    // No visible audiences → match nothing (inArray([]) is unsafe in SQL).
    audienceFilter = keys.length > 0 ? inArray(docs.audience, keys) : sql`false`;
  }

  // Always exclude deleted docs (deleted_at IS NOT NULL).
  const deletedFilter = isNull(docs.deletedAt);
  const whereParts = [deletedFilter, searchFilter, pathFilter, audienceFilter].filter(Boolean);
  const where = whereParts.length > 0 ? and(...whereParts) : undefined;

  // Build the query with versionCount via subquery/join
  const rows = await db
    .select({
      slug: docs.slug,
      title: docs.title,
      audience: docs.audience,
      format: docs.format,
      path: docs.path,
      unpublishedAt: docs.unpublishedAt,
      createdAt: docs.createdAt,
      docId: docs.id,
      ownerUserId: docs.ownerUserId,
      versionCount: sql<number>`cast(count(${docVersions.id}) as int)`,
      latestPublishedAt: sql<Date>`max(${docVersions.publishedAt})`,
      // Correlated subquery (not a join) so the doc_versions fan-out doesn't
      // multiply the comment count. One query, no N+1.
      unresolvedComments: sql<number>`(
        select cast(count(*) as int) from ${comments}
        where ${comments.docId} = ${docs.id} and ${comments.resolvedAt} is null
      )`,
    })
    .from(docs)
    .leftJoin(docVersions, eq(docVersions.docId, docs.id))
    .where(where)
    .groupBy(docs.id);

  const filtered = opts?.includeUnpublished
    ? rows
    : rows.filter((r) => r.unpublishedAt === null);

  return filtered.map((r) => ({
    slug: r.slug,
    title: r.title,
    audience: r.audience,
    format: r.format as "md" | "html",
    path: r.path,
    versionCount: r.versionCount,
    updatedAt: r.latestPublishedAt ?? r.createdAt,
    unresolvedComments: r.unresolvedComments,
    unpublishedAt: r.unpublishedAt,
    ownerUserId: r.ownerUserId ?? null,
  }));
}

// ── Full-text search (§7.5) ──────────────────────────────────────────────────

/**
 * Snippet delimiters handed to Postgres `ts_headline` (StartSel / StopSel).
 *
 * We DELIBERATELY do not use ts_headline's default `<b>…</b>` output: that
 * would inject raw HTML built from (attacker-influenceable) document content
 * into a snippet string, and any consumer that rendered it could be XSS'd. We
 * mark matches with two control characters that cannot appear in normal text,
 * then each surface re-encodes: the UI splits on them and emits <mark> React
 * nodes (escaped), the REST layer passes them through as a delimiter-encoded
 * `snippet` string, and the MCP layer wraps the marked spans in `**…**`.
 *
 * STX (0x02) / ETX (0x03) are non-printing and never legitimately in a doc, so
 * splitting on them is unambiguous.
 */
export { SNIPPET_START, SNIPPET_STOP };

export type DocSearchItem = DocListItem & {
  /**
   * Match snippet from ts_headline with custom delimiters (SNIPPET_START /
   * SNIPPET_STOP around matched terms). Always delimiter-encoded — NEVER raw
   * ts_headline HTML. Callers split on the delimiters to render highlights.
   * Empty string when ts_headline produced no fragment.
   */
  snippet: string;
  /** ts_rank score (higher = more relevant). Title matches outrank body. */
  rank: number;
};

/**
 * Full-text search over docs (title weight 'A' + current-version content
 * weight 'B'), audience-scoped IDENTICALLY to listDocs. Ranked by ts_rank
 * (title matches outrank body matches via the weights baked into search_tsv),
 * with a ts_headline snippet per row.
 *
 * Unpublished handling mirrors listDocs exactly: admins (includeUnpublished)
 * see unpublished docs; everyone else has them filtered out. Audience scoping
 * is the same member-visible join. An empty / whitespace `q` returns [].
 */
export async function searchDocs(
  q: string,
  opts?: { includeUnpublished?: boolean; path?: string; scope?: ViewerScope },
): Promise<DocSearchItem[]> {
  const query = q?.trim();
  if (!query || query.length === 0) return [];

  // websearch_to_tsquery: forgiving Google-style syntax, no parse errors on
  // arbitrary user input. Bound as a param so it's never SQL-injected.
  const tsquery = sql`websearch_to_tsquery('english', ${query})`;

  // Path-prefix filter — same semantics + escaping as listDocs.
  const prefix = opts?.path?.trim();
  const pathFilter =
    prefix && prefix.length > 0
      ? or(
          eq(docs.path, prefix),
          like(docs.path, `${prefix.replace(/[%_\\]/g, "\\$&")}/%`),
        )
      : undefined;

  // Audience scoping (DB-side) — identical to listDocs.
  let audienceFilter = undefined;
  if (opts?.scope && opts.scope.viewer === "member") {
    const keys = await memberVisibleAudienceKeys(opts.scope.userId);
    audienceFilter = keys.length > 0 ? inArray(docs.audience, keys) : sql`false`;
  }

  // The FTS match predicate: the doc's vector must match the query.
  const matchFilter = sql`${docs.searchTsv} @@ ${tsquery}`;

  // Always exclude deleted docs (deleted_at IS NOT NULL).
  const deletedFilter = isNull(docs.deletedAt);
  const whereParts = [matchFilter, deletedFilter, pathFilter, audienceFilter].filter(Boolean);
  const where = and(...(whereParts as NonNullable<typeof pathFilter>[]));

  const rows = await db
    .select({
      slug: docs.slug,
      title: docs.title,
      audience: docs.audience,
      format: docs.format,
      path: docs.path,
      unpublishedAt: docs.unpublishedAt,
      createdAt: docs.createdAt,
      docId: docs.id,
      ownerUserId: docs.ownerUserId,
      versionCount: sql<number>`cast(count(${docVersions.id}) as int)`,
      latestPublishedAt: sql<Date>`max(${docVersions.publishedAt})`,
      unresolvedComments: sql<number>`(
        select cast(count(*) as int) from ${comments}
        where ${comments.docId} = ${docs.id} and ${comments.resolvedAt} is null
      )`,
      rank: sql<number>`ts_rank(${docs.searchTsv}, ${tsquery})`,
      // ts_headline over the CURRENT version content, with CUSTOM delimiters
      // (never the default <b> HTML). Joined to the current version so the
      // snippet comes from the same content the vector indexes. A doc whose
      // match is title-only yields an empty/short headline — acceptable.
      snippet: sql<string>`coalesce(ts_headline(
        'english',
        (select dv.content from ${docVersions} dv where dv.id = ${docs.currentVersionId}),
        ${tsquery},
        ${`StartSel=${SNIPPET_START}, StopSel=${SNIPPET_STOP}, MaxFragments=2, MaxWords=24, MinWords=8, ShortWord=2`}
      ), '')`,
    })
    .from(docs)
    .leftJoin(docVersions, eq(docVersions.docId, docs.id))
    .where(where)
    .groupBy(docs.id)
    // Highest rank first; stable secondary by id so equal ranks are
    // deterministic across runs.
    .orderBy(sql`ts_rank(${docs.searchTsv}, ${tsquery}) desc`, desc(docs.id));

  const filtered = opts?.includeUnpublished
    ? rows
    : rows.filter((r) => r.unpublishedAt === null);

  return filtered.map((r) => ({
    slug: r.slug,
    title: r.title,
    audience: r.audience,
    format: r.format as "md" | "html",
    path: r.path,
    versionCount: r.versionCount,
    updatedAt: r.latestPublishedAt ?? r.createdAt,
    unresolvedComments: r.unresolvedComments,
    unpublishedAt: r.unpublishedAt,
    ownerUserId: r.ownerUserId ?? null,
    snippet: r.snippet,
    rank: r.rank,
  }));
}

export type VersionListItem = {
  id: number;
  contentHash: string;
  publishedAt: Date;
  publishedBy: string;
};

export async function listVersions(slug: string): Promise<VersionListItem[]> {
  // Exclude deleted docs.
  const docRows = await db
    .select()
    .from(docs)
    .where(and(eq(docs.slug, slug), isNull(docs.deletedAt)))
    .limit(1);

  if (docRows.length === 0) return [];

  const docId = docRows[0].id;

  const rows = await db
    .select({
      id: docVersions.id,
      contentHash: docVersions.contentHash,
      publishedAt: docVersions.publishedAt,
      publishedBy: docVersions.publishedBy,
    })
    .from(docVersions)
    .where(eq(docVersions.docId, docId))
    .orderBy(desc(docVersions.publishedAt));

  return rows;
}

/**
 * Fetch the raw content of a single version, scoped to a slug.
 *
 * Guards cross-doc access: returns null if the version doesn't exist OR
 * doesn't belong to the named doc (so `?diff=<other doc's versionId>` can't
 * leak content from a doc the request never asked for).
 */
export async function getVersionContent(
  slug: string,
  versionId: number,
): Promise<string | null> {
  // Exclude deleted docs.
  const docRows = await db
    .select({ id: docs.id })
    .from(docs)
    .where(and(eq(docs.slug, slug), isNull(docs.deletedAt)))
    .limit(1);

  if (docRows.length === 0) return null;

  const rows = await db
    .select({ content: docVersions.content })
    .from(docVersions)
    .where(
      and(eq(docVersions.id, versionId), eq(docVersions.docId, docRows[0].id)),
    )
    .limit(1);

  return rows[0]?.content ?? null;
}
