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

// The Phase-1 single space. Multi-space is Phase 2 (the schema already supports
// it); for now every doc lands in this one owner-only space. Its slug doubles as
// the <space> path segment in the git URL and the on-disk repo directory name.
export const DEFAULT_SPACE_SLUG = "workspace";

/** Same alphabet as slugs / audiences / path segments. */
export const SPACE_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

export type SpaceRole = "owner" | "writer" | "reader";
export type SpaceVisibility = "private" | "unlisted" | "public";

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

/** Look up a space by slug (null when absent). */
export async function getSpaceBySlug(slug: string): Promise<SpaceRow | null> {
  const row = await db.query.spaces.findFirst({ where: eq(spaces.slug, slug) });
  return row ?? null;
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
 * Given a raw Basic-auth password (the principal token), the URL's `<owner>`
 * segment, and the `<space>` slug, resolve the caller's role on that space — or
 * `null` if anything fails to line up. Null is returned (never an exception)
 * for EVERY denial case so the caller renders one uniform 404:
 *   - no/blank token
 *   - unknown or revoked token
 *   - the resolving user is inactive
 *   - the space slug doesn't exist
 *   - the URL owner segment doesn't match the space's real owner segment
 *   - the user has no membership row on the space
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

  // Space slug must exist...
  const space = await getSpaceBySlug(spaceSlug);
  if (!space) return null;

  // ...and the URL's owner segment must match the space's real owner segment
  // (prevents `/<wrong-owner>/<space>.git` from resolving the right repo).
  const realOwnerSlug = await ownerSlugForSpace(space);
  if (realOwnerSlug !== ownerSegment.toLowerCase()) return null;

  // Membership row decides the role. No row ⇒ no access (fail-closed).
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
    ownerSlug: realOwnerSlug,
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
 * Create a space (Phase 2 surface; usable in Phase 1 for tests/import). Owner is
 * mirrored as an `owner` member. Slug must match SPACE_SLUG_RE and be unique.
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
  const dup = await getSpaceBySlug(slug);
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
