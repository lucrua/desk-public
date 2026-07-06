import { eq } from "drizzle-orm";
import { sql, db, schema } from "@/db";
import { createShare, type CreateShareResult } from "@/lib/shares";
import { publishDoc, type PublishInput } from "@/lib/docs";
import { ensureDefaultSpace, DEFAULT_SPACE_SLUG } from "@/lib/spaces";
import { resolvePrincipalUserId } from "@/lib/principal-user";

export async function resetDb() {
  await sql`TRUNCATE events, revisions, comments, share_views, shares, doc_versions, docs, audience_members, user_emails, users, audiences, access_requests, cards, buckets, catalog_links, catalog_items, catalog_schemas, space_invites, space_members, principal_tokens, instance_settings, spaces RESTART IDENTITY CASCADE`;
}

/**
 * Seed the Phase-1 default space and return its id. Tests that insert `docs`
 * rows directly (bypassing publishDoc, which attaches the space itself) call
 * this so the NOT-NULL docs.space_id is satisfied. Creates a throwaway owner
 * user when none exists, mirrored as the space's `owner` member.
 */
export async function seedDefaultSpace(): Promise<number> {
  let [owner] = await db.select({ id: schema.users.id }).from(schema.users).limit(1);
  if (!owner) {
    [owner] = await db
      .insert(schema.users)
      .values({ email: "space-owner@test.local", displayName: "Space Owner", role: "admin", active: 1 })
      .returning({ id: schema.users.id });
  }
  const existing = await db.query.spaces.findFirst({ where: eq(schema.spaces.slug, "workspace") });
  if (existing) return existing.id;
  const [s] = await db
    .insert(schema.spaces)
    .values({ slug: "workspace", ownerUserId: owner.id, visibility: "private" })
    .returning({ id: schema.spaces.id });
  await db
    .insert(schema.spaceMembers)
    .values({ spaceId: s.id, userId: owner.id, role: "owner" })
    .onConflictDoNothing();
  return s.id;
}

/**
 * Seed the four generic buckets the 0008 migration installs (truncated by
 * resetDb). Board/card tests call this in setup. Returns the inserted rows
 * (id/key/label/position) so tests can reference ids without re-querying.
 */
export async function seedBuckets(): Promise<
  Array<{ id: number; key: string; label: string; position: number }>
> {
  const rows = [
    { key: "backlog", label: "Backlog", position: 1 },
    { key: "in-progress", label: "In Progress", position: 2 },
    { key: "review", label: "Review", position: 3 },
    { key: "done", label: "Done", position: 4 },
  ];
  const inserted = await db.insert(schema.buckets).values(rows).returning();
  return inserted.map((b) => ({ id: b.id, key: b.key, label: b.label, position: b.position }));
}

/**
 * Test helper: create a share and assert it succeeded, returning the unwrapped
 * success branch (token/id/shareUrl/label). createShare now returns a
 * discriminated CreateShareOutcome; success-path tests use this so they don't
 * have to narrow on `.ok` at every call site. Throws if the outcome is an error.
 */
export async function createShareOk(
  docSlug: string,
  label: string | undefined,
  by: string,
  expiresInDays?: number | null,
  pinnedVersionId?: number | null,
): Promise<CreateShareResult> {
  const out = await createShare(docSlug, label, by, expiresInDays, pinnedVersionId);
  if (!out.ok) {
    throw new Error(`createShareOk expected success, got error: ${out.error}`);
  }
  return out;
}

/**
 * Test helper: publish a doc and assert success, returning the unwrapped success
 * branch ({ slug, versionId, isNewVersion }). publishDoc now returns a
 * discriminated PublishResult (the false branch is an optimistic-concurrency
 * conflict); success-path tests use this to avoid narrowing everywhere.
 */
export async function publishDocOk(
  input: PublishInput,
): Promise<{ slug: string; versionId: number; versionNumber: number; isNewDoc: boolean; isNewVersion: boolean }> {
  const out = await publishDoc(input);
  if (!out.ok) {
    throw new Error(`publishDocOk expected success, got failure: ${JSON.stringify(out)}`);
  }
  return { slug: out.slug, versionId: out.versionId, versionNumber: out.versionNumber, isNewDoc: out.isNewDoc, isNewVersion: out.isNewVersion };
}

/**
 * Test helper: insert a users row and return its id. `role` defaults to member.
 * Identity is email-based (the common case); pass tokenName for an agent row.
 *
 * Mirrors the email (normalized trim + lowercase) into user_emails the way the
 * real createUser / bootstrap paths do, so the CF-JWT auth-resolution lookup
 * (user_emails → userId → users) finds the row. A token-only row gets no email
 * mirror.
 */
export async function seedUser(input: {
  email?: string;
  tokenName?: string;
  displayName: string;
  role?: "admin" | "member";
  active?: number; // 1|0 — defaults to 1
}): Promise<number> {
  const email = input.email?.trim().toLowerCase() ?? null;
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(schema.users)
      .values({
        email,
        tokenName: input.tokenName ?? null,
        displayName: input.displayName,
        role: input.role ?? "member",
        active: input.active ?? 1,
      })
      .returning({ id: schema.users.id });
    if (email) {
      await tx.insert(schema.userEmails).values({ userId: row.id, email });
    }
    return row.id;
  });
}

/**
 * Test helper: create a SPACE with a given slug + visibility, owned by `ownerId`
 * (mirrored as an `owner` member row, the way the real create paths do). Returns
 * the new space id. Used by the space-scoped read-visibility tests.
 */
export async function seedSpace(input: {
  slug: string;
  ownerId: number;
  visibility?: "private" | "unlisted" | "public";
}): Promise<number> {
  return db.transaction(async (tx) => {
    const [s] = await tx
      .insert(schema.spaces)
      .values({
        slug: input.slug,
        ownerUserId: input.ownerId,
        visibility: input.visibility ?? "private",
      })
      .returning({ id: schema.spaces.id });
    await tx
      .insert(schema.spaceMembers)
      .values({ spaceId: s.id, userId: input.ownerId, role: "owner" })
      .onConflictDoNothing();
    return s.id;
  });
}

/**
 * Test helper: add a user to a space with a role (owner|writer|reader). Idempotent
 * via the (space,user) PK — re-adding updates nothing extra. Mirrors the coarse
 * WRITE/read membership the space-scope read path keys on.
 */
export async function seedSpaceMember(
  spaceId: number,
  userId: number,
  role: "owner" | "writer" | "reader" = "reader",
): Promise<void> {
  await db
    .insert(schema.spaceMembers)
    .values({ spaceId, userId, role })
    .onConflictDoNothing();
}

/**
 * Test helper for route/MCP tests that drive the dev-mode role-switcher
 * ("x-dev-role: member"). Read access is space-scoped now: a doc published with
 * no explicit space lands in the Phase-1 default space (`workspace`, PRIVATE), so
 * the dev `member` principal — a distinct `dev-member` user — can't see it by
 * default. This makes the dev-member a READER of the default space, so a member
 * sees docs published there (the audience-era "team is member-visible" default).
 * Idempotent. Returns the default space id. Call it in a member-visibility test's
 * setup (after the user/space rows exist) the way `seedAudiences()` was called.
 */
export async function seedDevMemberInDefaultSpace(): Promise<number> {
  // Ensure the default space exists (publishDoc would create it lazily, but a
  // test may call this before its first publish). ensureDefaultSpace needs at
  // least one user to own it; resolve/create the dev-member first so there is one.
  const memberId = await resolvePrincipalUserId({ kind: "member", name: "Dev Member" });
  const space = await ensureDefaultSpace();
  if (!space) {
    // No owner could be resolved — create the space owned by the dev-member.
    const id = await seedSpace({ slug: DEFAULT_SPACE_SLUG, ownerId: memberId!, visibility: "private" });
    await seedSpaceMember(id, memberId!, "reader");
    return id;
  }
  if (memberId != null) await seedSpaceMember(space.id, memberId, "reader");
  return space.id;
}

/**
 * Test helper: add a user to an audience (by audience key + userId). Resolves
 * the audience id from its key. Idempotent (onConflictDoNothing on the uniq).
 */
export async function seedMembership(
  audienceKey: string,
  userId: number,
): Promise<void> {
  const aud = await db.query.audiences.findFirst({
    where: eq(schema.audiences.key, audienceKey),
  });
  if (!aud) throw new Error(`seedMembership: unknown audience '${audienceKey}'`);
  await db
    .insert(schema.audienceMembers)
    .values({ audienceId: aud.id, userId })
    .onConflictDoNothing();
}

/**
 * Seed the canonical audiences (team visible to members; pedro/dani hidden)
 * the way the 0001 migration does in real DBs. resetDb truncates the table, so
 * tests that exercise audience-scoped visibility call this in their setup.
 * Pass extra rows for ad-hoc audiences (e.g. an external one).
 */
export async function seedAudiences(
  extra: Array<{ key: string; label: string; memberVisible?: boolean }> = [],
): Promise<void> {
  const rows = [
    // `private` mirrors what migration 0010 seeds (member_visible 0) — the
    // upload/publish default. resetDb truncates audiences, so seed it here so
    // the "no audience → private" default resolves in tests.
    { key: "private", label: "Private", memberVisible: 0 },
    { key: "team", label: "Team", memberVisible: 1 },
    { key: "pedro", label: "Pedro", memberVisible: 0 },
    { key: "dani", label: "Dani", memberVisible: 0 },
    ...extra.map((e) => ({
      key: e.key,
      label: e.label,
      memberVisible: e.memberVisible ? 1 : 0,
    })),
  ];
  await db.insert(schema.audiences).values(rows).onConflictDoNothing();
}
