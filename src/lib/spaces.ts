/**
 * Spaces service — the document-host write boundary (Phase 1).
 *
 * A SPACE is an owned, access-controlled git repo Desk hosts (design-document-
 * host.md §3). Its canonical bytes live in a bare repo on disk; Desk's Postgres
 * is a derived projection. This module owns:
 *
 *   - the `spaces` / `space_members` rows (the coarse WRITE/clone ACL),
 *   - `principal_tokens` (the git Basic-auth credential → users row → space role),
 *   - `ensureDefaultSpace` — the Phase-1 single-space bootstrap every publish
 *     path attaches docs to,
 *   - `resolveSpaceRole` — the fail-closed authz primitive the git transport
 *     middleware calls (token + owner-slug + space-slug → role | null).
 *
 * AUTH-SENSITIVE: `resolveSpaceRole` is the keystone of the git write boundary.
 * It is fail-closed by construction — any unknown token, revoked token, missing
 * space, or absent membership row yields `null` (the caller maps null to a
 * uniform 404 on a private space, never leaking existence). See §13.5, §15.
 */
import { and, eq, isNull, desc, count } from "drizzle-orm";
import { db } from "@/db";
import { spaces, spaceMembers, principalTokens, users, docs } from "@/db/schema";
import { mintToken, hashToken } from "@/lib/tokens";
import { emitEvent } from "@/lib/events";
import type { Principal } from "@/lib/auth";
import { resolvePrincipalUserId } from "@/lib/principal-user";
import { assignUserHandle } from "@/lib/user-handle";

// The Phase-1 single space. Multi-space is Phase 2 (the schema already supports
// it); for now every doc lands in this one owner-only space. Its slug doubles as
// the <space> path segment in the git URL and the on-disk repo directory name.
export const DEFAULT_SPACE_SLUG = "workspace";

/** Same alphabet as slugs / audiences / path segments. */
export const SPACE_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

export type SpaceRole = "owner" | "writer" | "reader";
export type SpaceVisibility = "private" | "unlisted" | "public";
export type SpacePushPolicy = "direct" | "proposal";

export type SpaceRow = typeof spaces.$inferSelect;

/**
 * Ranking of space roles, coarsest-last. Used to compare a resolved role against
 * a required minimum ("reader+", "writer+"). A higher number subsumes lower.
 */
const ROLE_RANK: Record<SpaceRole, number> = { reader: 1, writer: 2, owner: 3 };

/** True iff `have` satisfies the `need` threshold (owner ⊇ writer ⊇ reader). */
export function roleSatisfies(have: SpaceRole, need: SpaceRole): boolean {
  return ROLE_RANK[have] >= ROLE_RANK[need];
}

/**
 * Lazily ensure the Phase-1 default space exists and return its row.
 *
 * Owner = the supplied `ownerUserId` when given, else the lowest-id active admin,
 * else the lowest-id user. The owner is mirrored as an `owner` member row so the
 * git ACL resolves through `space_members` uniformly (no owner special-casing).
 * Idempotent: a second call returns the existing row. Returns null only when
 * there is genuinely no user to own it (a doc-less, user-less fresh DB) — every
 * real deployment has at least the bootstrap admin.
 *
 * Race note: the slug is UNIQUE, so two concurrent creators collide on insert;
 * we swallow the unique violation and re-read. The member mirror is upserted
 * with ON CONFLICT DO NOTHING.
 */
export async function ensureDefaultSpace(
  ownerUserId?: number,
): Promise<SpaceRow | null> {
  const existing = await db.query.spaces.findFirst({
    where: eq(spaces.slug, DEFAULT_SPACE_SLUG),
  });
  if (existing) return existing;

  // Resolve an owner.
  let owner = ownerUserId;
  if (owner == null) {
    const admin = await db.query.users.findFirst({
      where: and(eq(users.role, "admin"), eq(users.active, 1)),
      orderBy: (u, { asc }) => [asc(u.id)],
    });
    owner = admin?.id;
    if (owner == null) {
      const any = await db.query.users.findFirst({
        orderBy: (u, { asc }) => [asc(u.id)],
      });
      owner = any?.id;
    }
  }
  if (owner == null) return null; // no user to own a space — caller handles

  try {
    const row = await db.transaction(async (tx) => {
      const [s] = await tx
        .insert(spaces)
        .values({ slug: DEFAULT_SPACE_SLUG, ownerUserId: owner!, visibility: "private" })
        .returning();
      await tx
        .insert(spaceMembers)
        .values({ spaceId: s.id, userId: owner!, role: "owner" })
        .onConflictDoNothing();
      await emitEvent(tx, {
        kind: "space.created",
        payload: { slug: s.slug, ownerUserId: owner!, visibility: s.visibility },
        actorName: "system",
      });
      return s;
    });
    return row;
  } catch {
    // Lost the create race (unique slug) — re-read the winner's row.
    const won = await db.query.spaces.findFirst({
      where: eq(spaces.slug, DEFAULT_SPACE_SLUG),
    });
    return won ?? null;
  }
}

/**
 * THE canonical space resolver (Owner-namespace S3, decision D4): resolve a space
 * by its owner's stable HANDLE + slug. `handle → users.id` (via `users.handle`),
 * then `(ownerUserId, slug) → space`. Returns null — never throws, never leaks —
 * on an unknown/blank handle OR when that owner has no such slug. This is the
 * resolver every owner-qualified surface (git write boundary now; web/API routes
 * in S4) resolves through. The handle is matched case-insensitively (handles are
 * stored lowercased); the slug is matched exactly.
 */
export async function getSpace(
  handle: string,
  slug: string,
): Promise<SpaceRow | null> {
  const h = handle.trim().toLowerCase();
  if (h.length === 0) return null;
  const owner = await db.query.users.findFirst({ where: eq(users.handle, h) });
  if (!owner) return null; // unknown handle → not-found (no existence leak)
  return getSpaceByOwner(owner.id, slug);
}

/** Resolve a space by (ownerUserId, slug) — the composite identity. Null when
 * that owner has no space with this slug. The direct form `getSpace` uses after
 * turning a handle into a user id, and the one `createSpace` uses for its
 * per-owner duplicate pre-check (it already holds the owner id). */
export async function getSpaceByOwner(
  ownerUserId: number,
  slug: string,
): Promise<SpaceRow | null> {
  const row = await db.query.spaces.findFirst({
    where: and(eq(spaces.ownerUserId, ownerUserId), eq(spaces.slug, slug)),
  });
  return row ?? null;
}

/**
 * TRANSITIONAL slug-only resolver (Owner-namespace S3, decision D5). The slug is
 * no longer globally unique, so a bare slug can match MORE THAN ONE space. This
 * keeps the ~19 not-yet-owner-qualified web/API callers working until S4 rewrites
 * them to `getSpace(handle, slug)`:
 *   - exactly one space with this slug → return it (the common, single-owner case);
 *   - ZERO or MORE-THAN-ONE → return null (fail-closed — an ambiguous slug is
 *     treated as not-found; callers render 404 / "not found" until they qualify
 *     the owner in S4). NEVER returns an arbitrary winner (no cross-owner leak).
 */
export async function getSpaceBySlug(slug: string): Promise<SpaceRow | null> {
  const rows = await db.select().from(spaces).where(eq(spaces.slug, slug)).limit(2);
  return rows.length === 1 ? rows[0] : null;
}

/** Look up a space by id (null when absent). */
export async function getSpaceById(id: number): Promise<SpaceRow | null> {
  const row = await db.query.spaces.findFirst({ where: eq(spaces.id, id) });
  return row ?? null;
}

/**
 * Management authority over a space (visibility + membership): an ADMIN, or the
 * space's OWNER. This is the authz check the space-detail UI mirrors with
 * `canManage = isAdmin || myRole === "owner"`, and the gate the visibility PATCH
 * and members-POST endpoints (+ the MCP `set_space_member` tool) share — so a
 * non-admin owner sees and can use the same controls the UI shows them.
 *
 * NOTE: space CREATION stays admin-only (an intentional Slice-1 operator
 * decision) — this helper governs management of an EXISTING space only.
 *
 * Resolves the caller's user id via `resolvePrincipalUserId` (CF userId → email/
 * tokenName → dev stub) so it works identically in dev and production.
 */
export async function canManageSpace(
  principal: Principal,
  space: SpaceRow,
): Promise<boolean> {
  if (principal.kind === "admin") return true;
  if (principal.kind === "anonymous") return false;
  const me = await resolvePrincipalUserId(principal);
  return me != null && me === space.ownerUserId;
}

/** The owner-slug for a space = its owner user's tokenName or display-derived id.
 * The git URL is `/<owner>/<space>.git`; in Phase 1 the owner segment is the
 * space's owner's stable identifier. We use the OWNER's user id rendered as a
 * slug-safe segment when no tokenName/email handle exists. Kept simple and
 * deterministic so the on-disk repo path is stable. */
export async function ownerSlugForSpace(space: SpaceRow): Promise<string> {
  const owner = await db.query.users.findFirst({ where: eq(users.id, space.ownerUserId) });
  return ownerSlugForUser(owner ?? null, space.ownerUserId);
}

/** Derive the stable `<owner>` URL/disk segment for a user. Prefers tokenName,
 * then the email local-part, then `u<id>` — always lowercased + alphabet-safe. */
export function ownerSlugForUser(
  user: { tokenName: string | null; email: string | null } | null,
  userId: number,
): string {
  const raw =
    user?.tokenName ??
    (user?.email ? user.email.split("@")[0] : null) ??
    `u${userId}`;
  const seg = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return seg.length > 0 ? seg : `u${userId}`;
}

export type ResolvedPrincipal = {
  userId: number;
  role: SpaceRole;
  space: SpaceRow;
  ownerSlug: string;
};

/**
 * THE git-transport authz primitive (fail-closed).
 *
 * Given a raw Basic-auth password (the principal token), the git URL's `<owner>`
 * segment, and the `<space>` slug, resolve the caller's role on that space — or
 * `null` if anything fails to line up. Null is returned (never an exception)
 * for EVERY denial case so the caller renders one uniform 404:
 *   - no/blank token
 *   - unknown or revoked token
 *   - the resolving user is inactive
 *   - the `<owner>` segment is not a known handle
 *   - that owner has no space with this slug (incl. a DIFFERENT owner's same-slug
 *     space — cross-owner requests never resolve)
 *   - the user has no membership row on the resolved space
 *
 * Owner-namespace S3 (D2/D4): the `<owner>` segment is resolved as a STABLE HANDLE
 * via `getSpace(handle, slug)` — `handle → users.id`, then `(ownerUserId, slug) →
 * space` — NOT by looking up the globally-unique slug and matching the segment
 * against a re-derived owner slug (the slug is no longer globally unique). Because
 * `handle === ownerSlugForUser` for existing users, existing git remotes keep
 * resolving; but `/api/git/<ownerA>/<slug>.git` and `/api/git/<ownerB>/<slug>.git`
 * now resolve to DIFFERENT spaces, and a token with a role on A's space is denied
 * on B's (no membership there) — the two same-slug owners are isolated.
 *
 * On success it also bumps the token's lastUsedAt (best-effort, non-fatal).
 */
export async function resolveSpaceRole(
  rawToken: string | null | undefined,
  ownerSegment: string,
  spaceSlug: string,
): Promise<ResolvedPrincipal | null> {
  if (!rawToken || rawToken.trim().length === 0) return null;
  const tokenHash = hashToken(rawToken.trim());

  // Token → users row (active, non-revoked token only).
  const tok = await db.query.principalTokens.findFirst({
    where: and(eq(principalTokens.tokenHash, tokenHash), isNull(principalTokens.revokedAt)),
  });
  if (!tok) return null;

  const user = await db.query.users.findFirst({ where: eq(users.id, tok.userId) });
  if (!user || user.active !== 1) return null;

  // Resolve the git URL's `<owner>` segment as a HANDLE → that owner's space with
  // this slug. Unknown handle, or that owner having no such space (incl. another
  // owner's same-slug space), both yield null — fail-closed, no cross-owner leak.
  const space = await getSpace(ownerSegment, spaceSlug);
  if (!space) return null;

  // Membership row on the RESOLVED space decides the role. No row ⇒ no access
  // (fail-closed) — this is what denies a token that has a role on owner A's
  // same-slug space when it is presented at owner B's URL.
  const member = await db.query.spaceMembers.findFirst({
    where: and(eq(spaceMembers.spaceId, space.id), eq(spaceMembers.userId, user.id)),
  });
  if (!member) return null;

  // Best-effort lastUsedAt bump (never blocks the request).
  try {
    await db
      .update(principalTokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(principalTokens.id, tok.id));
  } catch {
    /* non-fatal */
  }

  return {
    userId: user.id,
    role: member.role as SpaceRole,
    space,
    // The matched owner handle (the normalized `<owner>` segment). getSpace matched
    // by `users.handle = ownerSegment.toLowerCase()`, so the two are equal.
    ownerSlug: ownerSegment.trim().toLowerCase(),
  };
}

// ── Principal-token mint / revoke ──────────────────────────────────────────────

export type MintedToken = { id: number; token: string; label: string };

/**
 * Mint a new principal token for a user. Returns the RAW token exactly once
 * (only the sha256 hash is stored). The caller surfaces it to the operator and
 * never persists it. `label` is a human-facing name.
 */
export async function mintPrincipalToken(
  userId: number,
  label: string,
): Promise<MintedToken> {
  const token = mintToken();
  const tokenHash = hashToken(token);
  const [row] = await db
    .insert(principalTokens)
    .values({ userId, tokenHash, label })
    .returning({ id: principalTokens.id, label: principalTokens.label });
  return { id: row.id, token, label: row.label };
}

/** Revoke a principal token by id (idempotent). Returns true if a live token
 * was revoked, false if unknown/already revoked. */
export async function revokePrincipalToken(id: number): Promise<boolean> {
  const [row] = await db
    .update(principalTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(principalTokens.id, id), isNull(principalTokens.revokedAt)))
    .returning({ id: principalTokens.id });
  return row != null;
}

/**
 * A token row as surfaced to a UI/API caller — NEVER the raw token or its hash.
 * `ownerUserId` lets an admin list (with `?all=1`) attribute a token to a user;
 * a scoped (own-only) list still carries it harmlessly.
 */
export type TokenListItem = {
  id: number;
  label: string;
  ownerUserId: number;
  lastUsedAt: Date | null;
  createdAt: Date;
  revokedAt: Date | null;
};

function toTokenListItem(row: typeof principalTokens.$inferSelect): TokenListItem {
  return {
    id: row.id,
    label: row.label,
    ownerUserId: row.userId,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
    revokedAt: row.revokedAt,
  };
}

/**
 * List a single user's principal tokens (newest-first), live + revoked. The raw
 * token and its hash are never included — only the safe projection. This is the
 * own-tokens view for `GET /api/tokens`.
 */
export async function listTokensForUser(userId: number): Promise<TokenListItem[]> {
  const rows = await db
    .select()
    .from(principalTokens)
    .where(eq(principalTokens.userId, userId))
    .orderBy(desc(principalTokens.createdAt));
  return rows.map(toTokenListItem);
}

/**
 * List EVERY principal token across all users (admin-only `?all=1` view). Same
 * safe projection; `ownerUserId` identifies whose token each row is.
 */
export async function listAllTokens(): Promise<TokenListItem[]> {
  const rows = await db
    .select()
    .from(principalTokens)
    .orderBy(desc(principalTokens.createdAt));
  return rows.map(toTokenListItem);
}

/**
 * The owning users.id of a token by id, or null when the token does not exist.
 * Used to scope a revoke: a member may revoke only their own token; an admin may
 * revoke any. Never exposes the hash.
 */
export async function tokenOwnerUserId(id: number): Promise<number | null> {
  const row = await db.query.principalTokens.findFirst({
    where: eq(principalTokens.id, id),
  });
  return row?.userId ?? null;
}

// ── Space CRUD + membership (REST + MCP back this) ─────────────────────────────

export type CreateSpaceResult =
  | { ok: true; space: SpaceRow }
  | { ok: false; error: string };

/**
 * Create a space. Owner is mirrored as an `owner` member. Slug must match
 * SPACE_SLUG_RE and be unique PER OWNER (Owner-namespace S3, D2) — two different
 * owners may each own the same slug; a single owner may not own it twice.
 *
 * The owner's stable `users.handle` is the `<owner>` namespace segment a space is
 * reachable by (URLs + git), so we ensure the owner HAS one (assign-on-read,
 * idempotent — a no-op in production, where every creation path already assigns a
 * handle). Uniqueness is checked per-owner up front and, under a create race,
 * enforced by the composite unique index `(owner_user_id, slug)`.
 */
export async function createSpace(
  slug: string,
  ownerUserId: number,
  visibility: SpaceVisibility,
  actorName: string,
): Promise<CreateSpaceResult> {
  if (!SPACE_SLUG_RE.test(slug)) {
    return { ok: false, error: "invalid slug — must match ^[a-z0-9][a-z0-9-]*$" };
  }
  const owner = await db.query.users.findFirst({ where: eq(users.id, ownerUserId) });
  if (!owner || owner.active !== 1) return { ok: false, error: "invalid owner" };
  // A namespaced space is reachable by its owner's handle — guarantee the owner
  // has one (idempotent; keeps existing handle, derives + persists one otherwise).
  await assignUserHandle(db, ownerUserId);
  // Per-owner duplicate check: does THIS owner already own this slug? (A different
  // owner owning the same slug is fine — the whole point of the composite key.)
  const dup = await getSpaceByOwner(ownerUserId, slug);
  if (dup) return { ok: false, error: "slug already in use" };

  try {
    const space = await db.transaction(async (tx) => {
      const [s] = await tx
        .insert(spaces)
        .values({ slug, ownerUserId, visibility })
        .returning();
      await tx
        .insert(spaceMembers)
        .values({ spaceId: s.id, userId: ownerUserId, role: "owner" })
        .onConflictDoNothing();
      await emitEvent(tx, {
        kind: "space.created",
        payload: { slug: s.slug, ownerUserId, visibility },
        actorName,
      });
      return s;
    });
    return { ok: true, space };
  } catch {
    return { ok: false, error: "slug already in use" };
  }
}

export type SpaceListItem = {
  id: number;
  slug: string;
  ownerUserId: number;
  visibility: SpaceVisibility;
  memberCount: number;
  createdAt: Date;
};

/** List spaces a user can see. Admins (isAdmin) see all; otherwise only spaces
 * the user is a member of. */
export async function listSpaces(opts: {
  isAdmin: boolean;
  userId?: number | null;
}): Promise<SpaceListItem[]> {
  const rows = await db.select().from(spaces);
  let visible = rows;
  if (!opts.isAdmin) {
    if (opts.userId == null) return [];
    const memberOf = await db
      .select({ spaceId: spaceMembers.spaceId })
      .from(spaceMembers)
      .where(eq(spaceMembers.userId, opts.userId));
    const ids = new Set(memberOf.map((m) => m.spaceId));
    visible = rows.filter((s) => ids.has(s.id));
  }
  const out: SpaceListItem[] = [];
  for (const s of visible) {
    const members = await db
      .select({ userId: spaceMembers.userId })
      .from(spaceMembers)
      .where(eq(spaceMembers.spaceId, s.id));
    out.push({
      id: s.id,
      slug: s.slug,
      ownerUserId: s.ownerUserId,
      visibility: s.visibility as SpaceVisibility,
      memberCount: members.length,
      createdAt: s.createdAt,
    });
  }
  return out;
}

/**
 * Set a space's listing visibility (private|unlisted|public). Governs DISCOVERY
 * only — never the git ACL (that is membership-based). Emits space.updated.
 * Returns false when the slug is unknown.
 */
export async function setSpaceVisibility(
  spaceSlug: string,
  visibility: SpaceVisibility,
  actorName: string,
): Promise<boolean> {
  const space = await getSpaceBySlug(spaceSlug);
  if (!space) return false;
  await db.transaction(async (tx) => {
    await tx.update(spaces).set({ visibility }).where(eq(spaces.id, space.id));
    await emitEvent(tx, {
      kind: "space.updated",
      payload: { slug: space.slug, visibility },
      actorName,
    });
  });
  return true;
}

/**
 * Set a space's PUSH POLICY (direct|proposal) — the git-push branch-protection
 * mode (External Collaboration, E1). `direct` (the default) lets writers push
 * `main`; `proposal` routes non-owner writer pushes to `proposals/*` (ENFORCED in
 * E2 — E1 only stores the setting + reflects it in the setup prompt + UI). Emits
 * space.updated. Returns false when the slug is unknown.
 */
export async function setSpacePushPolicy(
  spaceSlug: string,
  pushPolicy: SpacePushPolicy,
  actorName: string,
): Promise<boolean> {
  const space = await getSpaceBySlug(spaceSlug);
  if (!space) return false;
  await db.transaction(async (tx) => {
    await tx.update(spaces).set({ pushPolicy }).where(eq(spaces.id, space.id));
    await emitEvent(tx, {
      kind: "space.updated",
      payload: { slug: space.slug, pushPolicy },
      actorName,
    });
  });
  return true;
}

export type SpaceDocItem = {
  slug: string;
  title: string;
  path: string;
  format: "md" | "html";
  unpublished: boolean;
};

/**
 * The LIVE docs projected into a space (for the space-detail page). Tombstoned
 * (deleted) docs are excluded; unpublished docs are flagged so the caller can
 * gate them to admins. Returns null when the slug is unknown.
 */
export async function docsInSpace(spaceSlug: string): Promise<SpaceDocItem[] | null> {
  const space = await getSpaceBySlug(spaceSlug);
  if (!space) return null;
  const rows = await db
    .select({
      slug: docs.slug,
      title: docs.title,
      path: docs.path,
      format: docs.format,
      unpublishedAt: docs.unpublishedAt,
    })
    .from(docs)
    .where(and(eq(docs.spaceId, space.id), isNull(docs.deletedAt)))
    .orderBy(docs.path, docs.slug);
  return rows.map((r) => ({
    slug: r.slug,
    title: r.title,
    path: r.path,
    format: r.format as "md" | "html",
    unpublished: r.unpublishedAt !== null,
  }));
}

export type SpaceViewItem = SpaceListItem & {
  /** Owner's human label (display name) + the `<owner>` git-URL segment. */
  ownerLabel: string;
  ownerSlug: string;
  /** Count of LIVE (non-deleted) docs projected into this space. */
  docCount: number;
};

/**
 * Listing for the `/spaces` UI — `listSpaces` enriched with the owner's display
 * label, the owner URL segment (for the git remote), and a live doc count. Same
 * visibility rule (admins all; members member-of). Kept separate so the lean
 * `listSpaces` (REST/MCP) stays allocation-cheap.
 */
export async function listSpacesForView(opts: {
  isAdmin: boolean;
  userId?: number | null;
}): Promise<SpaceViewItem[]> {
  const base = await listSpaces(opts);
  const out: SpaceViewItem[] = [];
  for (const s of base) {
    const owner = await db.query.users.findFirst({ where: eq(users.id, s.ownerUserId) });
    const [dc] = await db
      .select({ n: count() })
      .from(docs)
      .where(and(eq(docs.spaceId, s.id), isNull(docs.deletedAt)));
    out.push({
      ...s,
      ownerLabel: owner?.displayName ?? `user ${s.ownerUserId}`,
      ownerSlug: ownerSlugForUser(owner ?? null, s.ownerUserId),
      docCount: dc?.n ?? 0,
    });
  }
  return out;
}

export type SetMemberRoleResult =
  | { ok: true; role: SpaceRole | null }
  | { ok: false; error: string };

/**
 * Set (or, with role=null, remove) a user's membership role on a space. The
 * owner role cannot be removed or reassigned through here (the space's
 * ownerUserId is the single owner; reassigning ownership is out of Phase-1
 * scope). Emits space.member_added / space.member_removed.
 */
export async function setSpaceMemberRole(
  spaceSlug: string,
  userId: number,
  role: SpaceRole | null,
  actorName: string,
): Promise<SetMemberRoleResult> {
  const space = await getSpaceBySlug(spaceSlug);
  if (!space) return { ok: false, error: "unknown space" };
  const target = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!target) return { ok: false, error: "unknown user" };

  // Guard the owner: never demote/remove the space owner via this path.
  if (userId === space.ownerUserId) {
    return { ok: false, error: "cannot change the space owner's role" };
  }
  if (role === "owner") {
    return { ok: false, error: "use ownership transfer (not in Phase 1) to set owner" };
  }

  return db.transaction(async (tx) => {
    const existing = await tx.query.spaceMembers.findFirst({
      where: and(eq(spaceMembers.spaceId, space.id), eq(spaceMembers.userId, userId)),
    });

    if (role === null) {
      if (!existing) return { ok: true as const, role: null };
      await tx
        .delete(spaceMembers)
        .where(and(eq(spaceMembers.spaceId, space.id), eq(spaceMembers.userId, userId)));
      await emitEvent(tx, {
        kind: "space.member_removed",
        payload: { slug: space.slug, userId },
        actorName,
      });
      return { ok: true as const, role: null };
    }

    if (existing) {
      await tx
        .update(spaceMembers)
        .set({ role })
        .where(and(eq(spaceMembers.spaceId, space.id), eq(spaceMembers.userId, userId)));
    } else {
      await tx.insert(spaceMembers).values({ spaceId: space.id, userId, role });
    }
    await emitEvent(tx, {
      kind: "space.member_added",
      payload: { slug: space.slug, userId, role },
      actorName,
    });
    return { ok: true as const, role };
  });
}

export type SpaceMemberItem = {
  userId: number;
  role: SpaceRole;
  displayName: string;
  email: string | null;
  tokenName: string | null;
  isOwner: boolean;
};

/**
 * List the members of a space (owner first, then by role rank, then id). Joins
 * the user row so the UI can render a human label without a second round-trip.
 * Returns null when the space slug doesn't exist (so the caller can 404).
 */
export async function listSpaceMembers(
  spaceSlug: string,
): Promise<SpaceMemberItem[] | null> {
  const space = await getSpaceBySlug(spaceSlug);
  if (!space) return null;
  const rows = await db
    .select({
      userId: spaceMembers.userId,
      role: spaceMembers.role,
      displayName: users.displayName,
      email: users.email,
      tokenName: users.tokenName,
    })
    .from(spaceMembers)
    .innerJoin(users, eq(users.id, spaceMembers.userId))
    .where(eq(spaceMembers.spaceId, space.id));
  return rows
    .map((r) => ({
      userId: r.userId,
      role: r.role as SpaceRole,
      displayName: r.displayName,
      email: r.email,
      tokenName: r.tokenName,
      isOwner: r.userId === space.ownerUserId,
    }))
    .sort((a, b) => {
      if (a.isOwner !== b.isOwner) return a.isOwner ? -1 : 1;
      const r = ROLE_RANK[b.role] - ROLE_RANK[a.role];
      return r !== 0 ? r : a.userId - b.userId;
    });
}
