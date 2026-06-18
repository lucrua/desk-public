import { eq, and, sql, desc, gte, or, like, isNull, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { shares, shareViews, docs, docVersions } from "@/db/schema";
import { mintToken, hashToken } from "@/lib/tokens";
import { encryptToken, decryptToken } from "@/lib/crypto";
import { normalizePath } from "@/lib/path";

const SHARE_BASE_URL = process.env.SHARE_BASE_URL ?? "http://localhost:3000";

// ── Return types ─────────────────────────────────────────────────────────────

export type CreateShareResult = {
  id: number;
  token: string;      // raw — appears exactly once, never persisted
  shareUrl: string;
  label: string;
};

export type ResolvedShare = {
  doc: typeof docs.$inferSelect;
  version: typeof docVersions.$inferSelect | null;
  shareId: number;
  label: string;
  /** Whether link visitors may comment on this share (per-share flag). */
  allowComments: boolean;
  expiresAt: Date | null;
  createdBy: string;
  /** True when the share is pinned to a specific version (vs. live/latest). */
  pinned: boolean;
};

/** Result discriminant for createShare — covers the new pinned-version guards. */
export type CreateShareError =
  | "doc-not-found"
  | "pinned-version-not-found";

/** Result discriminant for createDirectoryShare. */
export type CreateDirectoryShareError =
  | "invalid-prefix"   // not a valid path, OR root ('' — disallowed)
  ;

export type ShareListItem = {
  id: number;
  label: string;
  /** "doc" share or "directory" (folder) share. */
  mode: "doc" | "directory";
  /** Doc slug for a doc share; null for a directory share. */
  docSlug: string | null;
  /** Folder prefix for a directory share; null for a doc share. */
  pathPrefix: string | null;
  createdBy: string;
  createdAt: Date;
  allowComments: boolean;
  expiresAt: Date | null;
  revokedAt: Date | null;
  viewCount: number;
  lastViewedAt: Date | null;
  /** The pinned version id (null = live/latest; always null for directory). */
  pinnedVersionId: number | null;
  /** Derived share status for UI display. */
  status: "active" | "revoked" | "expired";
  /** True when the admin can retrieve/copy the link URL. */
  canCopy: boolean;
};

// ── createShare ───────────────────────────────────────────────────────────────

/**
 * Create a capability-link share for a doc identified by its slug.
 *
 * Returns:
 *   - { ok: true, ... } with the share + one-time raw token on success.
 *   - { ok: false, error: "doc-not-found" } when the slug is unknown.
 *   - { ok: false, error: "pinned-version-not-found" } when pinnedVersionId is
 *     given but does not belong to this doc (so a caller can't pin a link to
 *     another doc's version — a cross-doc leak).
 *
 * The raw token is returned exactly once — only the sha256 hash is stored.
 * When `pinnedVersionId` is omitted/null the share is LIVE (resolves the doc's
 * current version); when set it is PINNED to that exact version.
 */
export type CreateShareOutcome =
  | ({ ok: true } & CreateShareResult)
  | { ok: false; error: CreateShareError };

export async function createShare(
  docSlug: string,
  label: string | undefined,
  by: string,
  expiresInDays?: number | null,
  pinnedVersionId?: number | null,
): Promise<CreateShareOutcome> {
  // Look up the doc
  const docRows = await db
    .select()
    .from(docs)
    .where(eq(docs.slug, docSlug))
    .limit(1);

  if (docRows.length === 0) return { ok: false, error: "doc-not-found" };
  const doc = docRows[0];

  // If a pin is requested, the version MUST belong to this doc — guards against
  // pinning a link to a version of a different doc.
  if (pinnedVersionId != null) {
    const [v] = await db
      .select({ id: docVersions.id })
      .from(docVersions)
      .where(and(eq(docVersions.id, pinnedVersionId), eq(docVersions.docId, doc.id)))
      .limit(1);
    if (!v) return { ok: false, error: "pinned-version-not-found" };
  }

  const token = mintToken();
  const tokenHash = hashToken(token);

  // null = never expire; undefined = 7-day default; positive = that many days
  const expiresAt = expiresInDays === null
    ? null
    : new Date(Date.now() + (expiresInDays ?? 7) * 24 * 60 * 60 * 1000);

  // Auto-name from doc title when label is absent or blank
  const effectiveLabel = (label && label.trim())
    ? label.trim()
    : (doc.title || `Link to ${docSlug}`);

  const tokenEnc = encryptToken(token);

  const values: typeof shares.$inferInsert = {
    tokenHash,
    ...(tokenEnc != null ? { tokenEnc } : {}),
    docId: doc.id,
    label: effectiveLabel,
    createdBy: by,
    ...(expiresAt !== null ? { expiresAt } : {}),
    ...(pinnedVersionId != null ? { pinnedVersionId } : {}),
  };

  const [inserted] = await db.insert(shares).values(values).returning();

  return {
    ok: true,
    id: inserted.id,
    token,
    shareUrl: `${SHARE_BASE_URL}/s/${token}`,
    label: inserted.label,
  };
}

// ── createDirectoryShare ──────────────────────────────────────────────────────

export type CreateDirectoryShareOutcome =
  | ({ ok: true } & CreateShareResult)
  | { ok: false; error: CreateDirectoryShareError };

/**
 * Create a capability-link DIRECTORY share scoped to a folder `pathPrefix`.
 *
 * The prefix is validated + canonicalized via normalizePath (same alphabet /
 * max-depth as docs.path). The ROOT prefix ('') is DISALLOWED — a root share
 * would expose everything; a non-empty prefix is required (returns
 * { ok:false, error:"invalid-prefix" } for an invalid or empty prefix).
 *
 * `allowComments` defaults on (folder-wide). The raw token is returned exactly
 * once. The share carries pathPrefix (docId NULL) — the DB CHECK enforces the
 * exactly-one-of invariant.
 */
export async function createDirectoryShare(
  rawPrefix: string,
  label: string | undefined,
  by: string,
  expiresInDays?: number | null,
  allowComments = true,
): Promise<CreateDirectoryShareOutcome> {
  const prefix = normalizePath(rawPrefix);
  // null = invalid path; '' = root, which is disallowed for a directory share.
  if (prefix === null || prefix.length === 0) {
    return { ok: false, error: "invalid-prefix" };
  }

  const token = mintToken();
  const tokenHash = hashToken(token);

  // null = never expire; undefined = 7-day default; positive = that many days
  const expiresAt = expiresInDays === null
    ? null
    : new Date(Date.now() + (expiresInDays ?? 7) * 24 * 60 * 60 * 1000);

  // Auto-name from prefix when label is absent or blank
  const effectiveLabel = (label && label.trim())
    ? label.trim()
    : `Folder: ${prefix}`;

  const tokenEnc = encryptToken(token);

  const values: typeof shares.$inferInsert = {
    tokenHash,
    ...(tokenEnc != null ? { tokenEnc } : {}),
    docId: null,
    pathPrefix: prefix,
    label: effectiveLabel,
    createdBy: by,
    allowComments: allowComments ? 1 : 0,
    ...(expiresAt !== null ? { expiresAt } : {}),
  };

  const [inserted] = await db.insert(shares).values(values).returning();

  return {
    ok: true,
    id: inserted.id,
    token,
    shareUrl: `${SHARE_BASE_URL}/s/${token}`,
    label: inserted.label,
  };
}

// ── resolveShare ──────────────────────────────────────────────────────────────

/**
 * Resolve a raw token to the current doc+version.
 * Returns null for: unknown token, revoked, expired, or unpublished doc.
 * All failure modes are indistinguishable to the caller.
 */
export async function resolveShare(rawToken: string): Promise<ResolvedShare | null> {
  const hash = hashToken(rawToken);

  const shareRows = await db
    .select()
    .from(shares)
    .where(eq(shares.tokenHash, hash))
    .limit(1);

  if (shareRows.length === 0) return null;
  const share = shareRows[0];

  // Revoked?
  if (share.revokedAt !== null) return null;

  // Expired?
  if (share.expiresAt !== null && share.expiresAt <= new Date()) return null;

  // Directory share? resolveShare is the DOC-share resolver; a directory share
  // has no single doc/version, so it never resolves here (the directory routes
  // use resolveDirectoryShare / resolveShareDoc). Uniform null.
  if (share.docId === null) return null;

  // Load the doc — must be live (not deleted) and published.
  const docRows = await db
    .select()
    .from(docs)
    .where(and(eq(docs.id, share.docId), isNull(docs.deletedAt)))
    .limit(1);

  if (docRows.length === 0) return null;
  const doc = docRows[0];

  // Unpublished? (Always 404 — even a pinned share of an unpublished doc dies.
  // Unpublish kills links unconditionally; the pin doesn't resurrect them.)
  if (doc.unpublishedAt !== null) return null;

  // Resolve the version: PINNED → the exact pinned version (still scoped to this
  // doc, though createShare already guaranteed that); LIVE → the doc's current
  // version. A pinned version id that somehow no longer resolves falls through
  // to null, which the page treats as a uniform 404.
  const pinned = share.pinnedVersionId != null;
  const targetVersionId = pinned ? share.pinnedVersionId! : doc.currentVersionId;

  let version: typeof docVersions.$inferSelect | null = null;
  if (targetVersionId !== null) {
    const versionRows = await db
      .select()
      .from(docVersions)
      .where(and(eq(docVersions.id, targetVersionId), eq(docVersions.docId, doc.id)))
      .limit(1);
    version = versionRows[0] ?? null;
  }

  return {
    doc,
    version,
    shareId: share.id,
    label: share.label,
    allowComments: share.allowComments === 1,
    expiresAt: share.expiresAt,
    createdBy: share.createdBy,
    pinned,
  };
}

// ── Directory-share resolution (SECURITY-CRITICAL) ────────────────────────────

export type ResolvedDirectoryShare = {
  shareId: number;
  label: string;
  pathPrefix: string;
  allowComments: boolean;
  expiresAt: Date | null;
  createdBy: string;
};

export type DirectoryDocEntry = {
  slug: string;
  title: string;
  path: string;
  format: "md" | "html";
  updatedAt: Date;
  /** Short excerpt of the current version's content (plain text, head). */
  excerpt: string;
};

/** Length of the excerpt we surface in the directory index (plain text, head). */
const EXCERPT_MAX = 180;

/**
 * Boundary-safe prefix test. `path` belongs under `prefix` iff it IS the prefix
 * OR it is a descendant (`prefix + "/" …`). This is the ONE rule that keeps
 * `finance` from matching `financial/` — a raw `startsWith(prefix)` would leak.
 */
export function isUnderPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix + "/");
}

/**
 * Resolve a raw token to a directory share. Returns null (uniform) for: unknown
 * token, revoked, expired, OR a non-directory (doc) share. No single doc/version
 * here — the index + per-doc routes fan out from this.
 */
export async function resolveDirectoryShare(
  rawToken: string,
): Promise<ResolvedDirectoryShare | null> {
  const hash = hashToken(rawToken);

  const shareRows = await db
    .select()
    .from(shares)
    .where(eq(shares.tokenHash, hash))
    .limit(1);

  if (shareRows.length === 0) return null;
  const share = shareRows[0];

  if (share.revokedAt !== null) return null;
  if (share.expiresAt !== null && share.expiresAt <= new Date()) return null;

  // Must be a directory share (pathPrefix set). A doc share never resolves here.
  if (share.pathPrefix === null) return null;

  return {
    shareId: share.id,
    label: share.label,
    pathPrefix: share.pathPrefix,
    allowComments: share.allowComments === 1,
    expiresAt: share.expiresAt,
    createdBy: share.createdBy,
  };
}

/**
 * List the PUBLISHED docs exposed by a directory share (by shareId). Returns
 * docs whose path is the prefix or under it (boundary-safe, via the same
 * SQL predicate listDocs uses), EXCLUDING unpublished. No audience filter — a
 * capability link bypasses audience by design (the admin chose to expose the
 * folder). Ordered by path then title.
 *
 * Returns [] for a non-directory share id, a revoked/expired share, or a folder
 * with nothing published. (Callers that need the live guard resolve the token
 * first via resolveDirectoryShare; this helper trusts the resolved shareId.)
 */
export async function listDocsUnderShare(
  shareId: number,
): Promise<DirectoryDocEntry[]> {
  // Re-read the share to obtain the prefix from the trusted id.
  const [share] = await db
    .select({ pathPrefix: shares.pathPrefix })
    .from(shares)
    .where(eq(shares.id, shareId))
    .limit(1);
  if (!share || share.pathPrefix === null) return [];
  const prefix = share.pathPrefix;

  // Boundary-safe SQL: path === prefix OR path LIKE 'prefix/%'. Escape LIKE
  // metacharacters in the (validated) prefix defensively.
  const escaped = prefix.replace(/[%_\\]/g, "\\$&");
  const rows = await db
    .select({
      slug: docs.slug,
      title: docs.title,
      path: docs.path,
      format: docs.format,
      unpublishedAt: docs.unpublishedAt,
      createdAt: docs.createdAt,
      content: docVersions.content,
      publishedAt: docVersions.publishedAt,
    })
    .from(docs)
    .leftJoin(docVersions, eq(docVersions.id, docs.currentVersionId))
    .where(
      and(
        isNull(docs.unpublishedAt),
        isNull(docs.deletedAt),
        or(eq(docs.path, prefix), like(docs.path, `${escaped}/%`)),
      ),
    )
    .orderBy(docs.path, docs.title);

  return rows.map((r) => ({
    slug: r.slug,
    title: r.title,
    path: r.path,
    format: r.format as "md" | "html",
    updatedAt: r.publishedAt ?? r.createdAt,
    excerpt: excerptOf(r.content ?? ""),
  }));
}

/**
 * Derive a short plain-text excerpt from doc content: strip markdown-ish
 * structure crudely, collapse whitespace, head to EXCERPT_MAX. Rendered as
 * plain text in the index (never an HTML sink).
 */
function excerptOf(content: string): string {
  const flat = content
    .replace(/```[\s\S]*?```/g, " ")      // fenced code
    .replace(/[#>*_`~\-]+/g, " ")          // md punctuation
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > EXCERPT_MAX ? flat.slice(0, EXCERPT_MAX).trimEnd() + "…" : flat;
}

export type ResolvedShareDoc = {
  doc: typeof docs.$inferSelect;
  version: typeof docVersions.$inferSelect;
  share: ResolvedDirectoryShare;
};

/**
 * THE KEY GUARD. Resolve a directory share token + a doc slug to that doc's
 * content — ONLY IF the doc is published AND its path is under the share's
 * prefix. Any failure (unknown/revoked/expired token, non-directory share,
 * unknown slug, slug-outside-the-prefix, unpublished doc, doc with no current
 * version) returns null → the route renders the SAME uniform 404.
 *
 * A visitor must NEVER read a doc outside the shared folder by passing an
 * arbitrary slug: the boundary-safe isUnderPrefix check below is what stops
 * `?doc=<slug-outside-prefix>` from leaking arbitrary docs.
 */
export async function resolveShareDoc(
  rawToken: string,
  slug: string,
): Promise<ResolvedShareDoc | null> {
  const share = await resolveDirectoryShare(rawToken);
  if (share === null) return null;

  const [doc] = await db
    .select()
    .from(docs)
    .where(and(eq(docs.slug, slug), isNull(docs.deletedAt)))
    .limit(1);
  if (!doc) return null;

  // Published only — unpublish kills visibility through the directory too.
  if (doc.unpublishedAt !== null) return null;

  // THE prefix guard — boundary-safe. A doc not under the shared prefix is
  // indistinguishable from one that doesn't exist (uniform null).
  if (!isUnderPrefix(doc.path, share.pathPrefix)) return null;

  // Resolve the current version. No pinning for directory shares (live only).
  if (doc.currentVersionId === null) return null;
  const [version] = await db
    .select()
    .from(docVersions)
    .where(and(eq(docVersions.id, doc.currentVersionId), eq(docVersions.docId, doc.id)))
    .limit(1);
  if (!version) return null;

  return { doc, version, share };
}

// ── revokeShare ───────────────────────────────────────────────────────────────

/**
 * Revoke a share by id.
 * Returns true if revoked successfully, false if already revoked or not found.
 */
export async function revokeShare(id: number): Promise<boolean> {
  // Check share exists and is not already revoked
  const shareRows = await db
    .select()
    .from(shares)
    .where(eq(shares.id, id))
    .limit(1);

  if (shareRows.length === 0) return false;
  if (shareRows[0].revokedAt !== null) return false;

  await db
    .update(shares)
    .set({ revokedAt: new Date() })
    .where(eq(shares.id, id));

  return true;
}

// ── revealShareUrl ────────────────────────────────────────────────────────────

/**
 * Reveal the full share URL for a share by id (admin action).
 *
 * Decrypts the stored token_enc to reconstruct the IDENTICAL URL that was
 * returned at creation time. Returns null when:
 *   - share not found
 *   - share is stage-2 deleted (deleted_at set)
 *   - token_enc is null (pre-migration share — only hash exists, unrecoverable)
 *   - DESK_TOKEN_KEY is unset or the ciphertext was tampered
 *
 * The link itself is NOT checked for revocation or expiry — the admin may still
 * want to see a revoked link's URL (e.g. to confirm which link they revoked).
 */
export async function revealShareUrl(id: number): Promise<string | null> {
  const [share] = await db
    .select({ tokenEnc: shares.tokenEnc, deletedAt: shares.deletedAt })
    .from(shares)
    .where(eq(shares.id, id))
    .limit(1);

  if (!share) return null;
  if (share.deletedAt !== null) return null;
  if (share.tokenEnc === null) return null;

  const raw = decryptToken(share.tokenEnc);
  if (raw === null) return null;

  return `${SHARE_BASE_URL}/s/${raw}`;
}

// ── deleteShare ───────────────────────────────────────────────────────────────

/**
 * Stage-2 delete a share link by id (admin action).
 *
 * Sets `deleted_at` (and `revoked_at` if not already set — delete implies the
 * link is dead). The row is KEPT (share_views / comments FK it — never hard-
 * DELETE the row). Idempotent — calling again on an already-deleted share still
 * returns true. Returns false only when the share id is not found.
 *
 * After deleteShare the link 404s (via the revoke path) AND the share is
 * excluded from all admin list views.
 */
export async function deleteShare(id: number): Promise<boolean> {
  const [share] = await db
    .select({ revokedAt: shares.revokedAt, deletedAt: shares.deletedAt })
    .from(shares)
    .where(eq(shares.id, id))
    .limit(1);

  if (!share) return false;

  // Idempotent: if already deleted just return true (the outcome is already achieved).
  if (share.deletedAt !== null) return true;

  const now = new Date();
  await db
    .update(shares)
    .set({
      deletedAt: now,
      // Delete implies revoke — set revokedAt if not already set.
      ...(share.revokedAt === null ? { revokedAt: now } : {}),
    })
    .where(eq(shares.id, id));

  return true;
}

// ── recordView ────────────────────────────────────────────────────────────────

// Caps enforced HERE (not at call sites) so no caller on the public /s/[token]
// path can forget them. Unbounded text from the public request (ip / user-agent
// headers are attacker-controlled) is a storage-DoS vector.
const IP_MAX = 64;
const UA_MAX = 512;

/**
 * Record a view event for a share.
 *
 * `ip` and `userAgent` originate from request headers on the public share path,
 * so they are untrusted, unbounded text. They are truncated to IP_MAX / UA_MAX
 * characters before insert — enforced inside this function so every caller is
 * protected regardless of what it passes.
 */
export async function recordView(
  shareId: number,
  docVersionId: number,
  ip?: string,
  userAgent?: string
): Promise<void> {
  const cappedIp = ip != null ? ip.slice(0, IP_MAX) : ip;
  const cappedUa = userAgent != null ? userAgent.slice(0, UA_MAX) : userAgent;

  await db.insert(shareViews).values({
    shareId,
    docVersionId,
    ...(cappedIp ? { ip: cappedIp } : {}),
    ...(cappedUa ? { userAgent: cappedUa } : {}),
  });
}

// ── listShares ────────────────────────────────────────────────────────────────

/** Derive ShareListItem status and canCopy from a raw row. */
function deriveStatusAndCanCopy(r: {
  revokedAt: Date | null;
  expiresAt: Date | null;
  tokenEnc: string | null;
}): { status: "active" | "revoked" | "expired"; canCopy: boolean } {
  const now = new Date();
  const isExpired = r.expiresAt !== null && r.expiresAt <= now;
  const isRevoked = r.revokedAt !== null;

  let status: "active" | "revoked" | "expired";
  if (isExpired) {
    status = "expired";
  } else if (isRevoked) {
    status = "revoked";
  } else {
    status = "active";
  }

  // canCopy: token_enc present AND the link is still active (not revoked/expired)
  const canCopy = r.tokenEnc !== null && status === "active";

  return { status, canCopy };
}

/**
 * List all shares with aggregate view stats. Excludes stage-2 deleted shares.
 */
export async function listShares(): Promise<ShareListItem[]> {
  // LEFT join docs — a directory share has no docId, so an inner join would
  // silently drop it. docSlug is null for directory shares.
  const rows = await db
    .select({
      id: shares.id,
      label: shares.label,
      docSlug: docs.slug,
      pathPrefix: shares.pathPrefix,
      createdBy: shares.createdBy,
      createdAt: shares.createdAt,
      allowComments: shares.allowComments,
      expiresAt: shares.expiresAt,
      revokedAt: shares.revokedAt,
      tokenEnc: shares.tokenEnc,
      pinnedVersionId: shares.pinnedVersionId,
      viewCount: sql<number>`cast(count(${shareViews.id}) as int)`,
      lastViewedAt: sql<Date | null>`max(${shareViews.viewedAt})`,
    })
    .from(shares)
    .leftJoin(docs, eq(docs.id, shares.docId))
    .leftJoin(shareViews, eq(shareViews.shareId, shares.id))
    .where(isNull(shares.deletedAt))
    .groupBy(shares.id, docs.slug);

  return rows.map((r) => {
    const { status, canCopy } = deriveStatusAndCanCopy(r);
    return {
      id: r.id,
      label: r.label,
      mode: r.pathPrefix !== null ? ("directory" as const) : ("doc" as const),
      docSlug: r.docSlug,
      pathPrefix: r.pathPrefix,
      createdBy: r.createdBy,
      createdAt: r.createdAt,
      allowComments: r.allowComments === 1,
      expiresAt: r.expiresAt,
      revokedAt: r.revokedAt,
      viewCount: r.viewCount,
      lastViewedAt: r.lastViewedAt,
      pinnedVersionId: r.pinnedVersionId,
      status,
      canCopy,
    };
  });
}

// ── listSharesForDoc ──────────────────────────────────────────────────────────

/**
 * List every share for a single doc (identified by slug), with aggregate view
 * stats — newest-first. Filtered in SQL (joined on docs.slug), not by
 * post-filtering listShares(), so it stays O(shares-for-this-doc).
 *
 * Returns [] for a slug with no shares AND for an unknown slug — the caller is
 * responsible for the doc-existence check (the route 404s unknown slugs before
 * calling this, so an unknown slug never reaches here in practice).
 */
export async function listSharesForDoc(docSlug: string): Promise<ShareListItem[]> {
  const rows = await db
    .select({
      id: shares.id,
      label: shares.label,
      docSlug: docs.slug,
      createdBy: shares.createdBy,
      createdAt: shares.createdAt,
      allowComments: shares.allowComments,
      expiresAt: shares.expiresAt,
      revokedAt: shares.revokedAt,
      tokenEnc: shares.tokenEnc,
      pinnedVersionId: shares.pinnedVersionId,
      viewCount: sql<number>`cast(count(${shareViews.id}) as int)`,
      lastViewedAt: sql<Date | null>`max(${shareViews.viewedAt})`,
    })
    .from(shares)
    .innerJoin(docs, eq(docs.id, shares.docId))
    .leftJoin(shareViews, eq(shareViews.shareId, shares.id))
    .where(and(eq(docs.slug, docSlug), isNull(shares.deletedAt)))
    .groupBy(shares.id, docs.slug)
    .orderBy(desc(shares.createdAt), desc(shares.id));

  return rows.map((r) => {
    const { status, canCopy } = deriveStatusAndCanCopy(r);
    return {
      id: r.id,
      label: r.label,
      mode: "doc" as const,
      docSlug: r.docSlug,
      pathPrefix: null,
      createdBy: r.createdBy,
      createdAt: r.createdAt,
      allowComments: r.allowComments === 1,
      expiresAt: r.expiresAt,
      revokedAt: r.revokedAt,
      viewCount: r.viewCount,
      lastViewedAt: r.lastViewedAt,
      pinnedVersionId: r.pinnedVersionId,
      status,
      canCopy,
    };
  });
}

// ── setShareComments ──────────────────────────────────────────────────────────

/**
 * Toggle the `allowComments` flag on a share (admin action).
 * Returns true if the share exists and was updated, false if not found.
 * Revoked shares can still be toggled (no-op in practice — the composer is gone
 * once revoked — but we don't special-case it here).
 */
export async function setShareComments(id: number, allow: boolean): Promise<boolean> {
  const shareRows = await db
    .select({ id: shares.id })
    .from(shares)
    .where(eq(shares.id, id))
    .limit(1);

  if (shareRows.length === 0) return false;

  await db
    .update(shares)
    .set({ allowComments: allow ? 1 : 0 })
    .where(eq(shares.id, id));

  return true;
}

// ── listViews ─────────────────────────────────────────────────────────────────

export type ShareViewItem = {
  viewedAt: Date;
  ip: string | null;
  userAgent: string | null;
  docVersionId: number;
};

/**
 * List the raw view events for one share, newest-first.
 *
 * `ip` / `userAgent` are returned UNSANITIZED — they are attacker-controlled
 * strings (capped at storage, see recordView). They are this admin's own audit
 * data; callers MUST render them as plain text only (never into an HTML sink,
 * href, or src). Use uaLabel() to derive a display label.
 */
export async function listViews(shareId: number): Promise<ShareViewItem[]> {
  const rows = await db
    .select({
      viewedAt: shareViews.viewedAt,
      ip: shareViews.ip,
      userAgent: shareViews.userAgent,
      docVersionId: shareViews.docVersionId,
    })
    .from(shareViews)
    .where(eq(shareViews.shareId, shareId))
    .orderBy(desc(shareViews.viewedAt), desc(shareViews.id));

  return rows;
}

// ── resolveShareState ──────────────────────────────────────────────────────────

export type ShareStateResult =
  | { state: "ok" }
  | { state: "expired"; expiresAt: Date }
  | { state: "gone" };

/**
 * Display-only resolver: distinguishes expired shares from gone
 * (unknown/revoked/deleted). Used by the /s/[token] page to render a friendly
 * expired page vs uniform 404. Does NOT expose content — just state.
 *
 * Returns:
 *   - "expired": token exists, share is not revoked/deleted, but expiresAt < now
 *   - "ok": token exists and share is active (not expired/revoked/deleted)
 *   - "gone": unknown token, revoked, or deleted share
 */
export async function resolveShareState(rawToken: string): Promise<ShareStateResult> {
  const hash = hashToken(rawToken);
  const [share] = await db.select().from(shares).where(eq(shares.tokenHash, hash)).limit(1);

  if (!share) return { state: "gone" };
  if (share.deletedAt !== null) return { state: "gone" };
  if (share.revokedAt !== null) return { state: "gone" };

  if (share.expiresAt !== null && share.expiresAt <= new Date()) {
    return { state: "expired", expiresAt: share.expiresAt };
  }

  return { state: "ok" };
}

// ── countRecentViews ──────────────────────────────────────────────────────────

/**
 * Count share views recorded within the last `days` days (default 7) — feeds
 * the admin "views · N days" stat tile.
 */
export async function countRecentViews(days = 7): Promise<number> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const [row] = await db
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(shareViews)
    .where(gte(shareViews.viewedAt, since));
  return row?.count ?? 0;
}
