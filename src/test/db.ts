import { eq } from "drizzle-orm";
import { sql, db, schema } from "@/db";
import { createShare, type CreateShareResult } from "@/lib/shares";
import { publishDoc, type PublishInput } from "@/lib/docs";

export async function resetDb() {
  await sql`TRUNCATE events, revisions, comments, share_views, shares, doc_versions, docs, audience_members, user_emails, users, audiences, access_requests, cards, buckets, catalog_links, catalog_items, catalog_schemas RESTART IDENTITY CASCADE`;
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
    throw new Error(
      `publishDocOk expected success, got conflict (current ${out.currentVersionId})`,
    );
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
 * Seed the canonical audiences (team visible to members; alice/bob hidden)
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
    { key: "alice", label: "Alice", memberVisible: 0 },
    { key: "bob", label: "Bob", memberVisible: 0 },
    ...extra.map((e) => ({
      key: e.key,
      label: e.label,
      memberVisible: e.memberVisible ? 1 : 0,
    })),
  ];
  await db.insert(schema.audiences).values(rows).onConflictDoNothing();
}
