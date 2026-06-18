import { eq, and, sql } from "drizzle-orm";
import { db } from "@/db";
import { audiences, audienceMembers, docs, users } from "@/db/schema";
import { emitEvent } from "@/lib/events";

/**
 * Audiences are admin-configurable data (was: a hardcoded set). Each audience is
 * a `key` (the value stored on `docs.audience`) + a human `label` + a
 * `memberVisible` flag that drives the member-visibility boundary in lib/docs.ts.
 */

export type AudienceItem = {
  id: number;
  key: string;
  label: string;
  memberVisible: boolean;
  createdAt: Date;
  /** Number of docs (any state) currently using this audience key. */
  docCount: number;
};

/** Same contract the slug/doc-audience accepts. New keys must match this. */
const KEY_RE = /^[a-z0-9][a-z0-9-]*$/;

const PG_UNIQUE_VIOLATION = "23505";

function isUniqueViolation(e: unknown): boolean {
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur != null; i++) {
    if ((cur as { code?: string }).code === PG_UNIQUE_VIOLATION) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * All audiences, with a live doc-count per key (any publish state). Ordered by
 * id so initial seeds lead and later additions follow.
 */
export async function listAudiences(): Promise<AudienceItem[]> {
  const rows = await db
    .select({
      id: audiences.id,
      key: audiences.key,
      label: audiences.label,
      memberVisible: audiences.memberVisible,
      createdAt: audiences.createdAt,
      docCount: sql<number>`cast(count(${docs.id}) as int)`,
    })
    .from(audiences)
    .leftJoin(docs, eq(docs.audience, audiences.key))
    .groupBy(audiences.id)
    .orderBy(audiences.id);

  return rows.map((r) => ({
    id: r.id,
    key: r.key,
    label: r.label,
    memberVisible: r.memberVisible === 1,
    createdAt: r.createdAt,
    docCount: r.docCount,
  }));
}

/** True iff an audience with this exact key exists. */
export async function audienceExists(key: string): Promise<boolean> {
  const row = await db.query.audiences.findFirst({
    where: eq(audiences.key, key),
  });
  return row != null;
}

export type CreateAudienceInput = {
  key: string;
  label: string;
  memberVisible: boolean;
};

/**
 * Create an audience. Returns null on a duplicate key OR an invalid key (key
 * must match ^[a-z0-9][a-z0-9-]*$). The label is trimmed; an empty label after
 * trim is rejected (null). Keys are stored verbatim (already constrained).
 */
export async function createAudience(
  input: CreateAudienceInput,
): Promise<AudienceItem | null> {
  const key = input.key.trim();
  const label = input.label.trim();
  if (!KEY_RE.test(key)) return null;
  if (label.length === 0) return null;

  try {
    const [row] = await db
      .insert(audiences)
      .values({ key, label, memberVisible: input.memberVisible ? 1 : 0 })
      .returning();
    return {
      id: row.id,
      key: row.key,
      label: row.label,
      memberVisible: row.memberVisible === 1,
      createdAt: row.createdAt,
      docCount: 0,
    };
  } catch (e) {
    if (isUniqueViolation(e)) return null;
    throw e;
  }
}

/** Flip an audience's member-visibility. Returns false if the id is unknown. */
export async function setAudienceMemberVisible(
  id: number,
  visible: boolean,
): Promise<boolean> {
  const updated = await db
    .update(audiences)
    .set({ memberVisible: visible ? 1 : 0 })
    .where(eq(audiences.id, id))
    .returning({ id: audiences.id });
  return updated.length > 0;
}

export type DeleteAudienceResult = "ok" | "in-use" | "not-found";

/**
 * Delete an audience by id.
 *
 * - "not-found" when the id is unknown.
 * - "in-use" when any doc still references the audience key (we never orphan a
 *   doc's audience — re-point those docs first).
 * - "ok" once deleted.
 */
export async function deleteAudience(id: number): Promise<DeleteAudienceResult> {
  const existing = await db.query.audiences.findFirst({
    where: eq(audiences.id, id),
  });
  if (!existing) return "not-found";

  const [{ count }] = await db
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(docs)
    .where(eq(docs.audience, existing.key));

  if (count > 0) return "in-use";

  // No docs use the key, but the audience may still have membership rows
  // (a group with no docs yet). Clear them first so the FK doesn't block the
  // delete and no orphan rows linger.
  await db.delete(audienceMembers).where(eq(audienceMembers.audienceId, id));
  await db.delete(audiences).where(eq(audiences.id, id));
  return "ok";
}

// ── Membership (Audiences v2 — audiences are groups) ─────────────────────────

export type AudienceMemberItem = {
  /** The audience_members row id. */
  id: number;
  userId: number;
  displayName: string;
  email: string | null;
  tokenName: string | null;
  createdAt: Date;
};

/**
 * List the members of an audience (by audience id), joined to the users row for
 * display. Ordered by display name. Returns null when the audience id is
 * unknown (so the caller can 404 vs. return an empty membership list).
 */
export async function listAudienceMembers(
  audienceId: number,
): Promise<AudienceMemberItem[] | null> {
  const aud = await db.query.audiences.findFirst({
    where: eq(audiences.id, audienceId),
  });
  if (!aud) return null;

  const rows = await db
    .select({
      id: audienceMembers.id,
      userId: users.id,
      displayName: users.displayName,
      email: users.email,
      tokenName: users.tokenName,
      createdAt: audienceMembers.createdAt,
    })
    .from(audienceMembers)
    .innerJoin(users, eq(users.id, audienceMembers.userId))
    .where(eq(audienceMembers.audienceId, audienceId))
    .orderBy(users.displayName);

  return rows;
}

/**
 * Every membership row across all audiences, joined to audience key/label and
 * the user's display name. Feeds the admin UI (member chips on each audience
 * row, audience chips on each user row) in one query. Ordered for stable
 * rendering (audience id, then display name).
 */
export type MembershipRow = {
  audienceId: number;
  audienceKey: string;
  audienceLabel: string;
  userId: number;
  displayName: string;
};

export async function listAllMemberships(): Promise<MembershipRow[]> {
  return db
    .select({
      audienceId: audiences.id,
      audienceKey: audiences.key,
      audienceLabel: audiences.label,
      userId: users.id,
      displayName: users.displayName,
    })
    .from(audienceMembers)
    .innerJoin(audiences, eq(audiences.id, audienceMembers.audienceId))
    .innerJoin(users, eq(users.id, audienceMembers.userId))
    .orderBy(audiences.id, users.displayName);
}

export type AddMemberResult =
  | { ok: true; item: AudienceMemberItem; added: boolean }
  | { ok: false; reason: "audience-not-found" | "user-not-found" };

/**
 * Add a user to an audience (admin-only at the route layer). Idempotent: adding
 * an existing member is a no-op success (`added: false`, no event). Emits
 * `audience.member_added` in-transaction on a real insert. Returns a typed miss
 * when the audience or user id is unknown.
 */
export async function addAudienceMember(
  audienceId: number,
  userId: number,
  by: string,
): Promise<AddMemberResult> {
  return db.transaction(async (tx) => {
    const aud = await tx.query.audiences.findFirst({
      where: eq(audiences.id, audienceId),
    });
    if (!aud) return { ok: false, reason: "audience-not-found" } as const;

    const user = await tx.query.users.findFirst({ where: eq(users.id, userId) });
    if (!user) return { ok: false, reason: "user-not-found" } as const;

    const existing = await tx
      .select({ id: audienceMembers.id, createdAt: audienceMembers.createdAt })
      .from(audienceMembers)
      .where(
        and(
          eq(audienceMembers.audienceId, audienceId),
          eq(audienceMembers.userId, userId),
        ),
      )
      .limit(1);

    const item = (id: number, createdAt: Date): AudienceMemberItem => ({
      id,
      userId: user.id,
      displayName: user.displayName,
      email: user.email,
      tokenName: user.tokenName,
      createdAt,
    });

    if (existing.length > 0) {
      // Already a member — idempotent no-op, no event.
      return {
        ok: true,
        added: false,
        item: item(existing[0].id, existing[0].createdAt),
      } as const;
    }

    const [row] = await tx
      .insert(audienceMembers)
      .values({ audienceId, userId })
      .returning({ id: audienceMembers.id, createdAt: audienceMembers.createdAt });

    await emitEvent(tx, {
      kind: "audience.member_added",
      payload: {
        audience: aud.key,
        userId: user.id,
        displayName: user.displayName,
      },
      actorName: by,
    });

    return { ok: true, added: true, item: item(row.id, row.createdAt) } as const;
  });
}

export type RemoveMemberResult = "ok" | "not-a-member" | "audience-not-found";

/**
 * Remove a user from an audience (admin-only at the route layer). Returns
 * "audience-not-found" for an unknown audience id, "not-a-member" when the user
 * wasn't in it (no event), and "ok" once removed (emits
 * `audience.member_removed` in-transaction).
 */
export async function removeAudienceMember(
  audienceId: number,
  userId: number,
  by: string,
): Promise<RemoveMemberResult> {
  return db.transaction(async (tx) => {
    const aud = await tx.query.audiences.findFirst({
      where: eq(audiences.id, audienceId),
    });
    if (!aud) return "audience-not-found";

    const deleted = await tx
      .delete(audienceMembers)
      .where(
        and(
          eq(audienceMembers.audienceId, audienceId),
          eq(audienceMembers.userId, userId),
        ),
      )
      .returning({ id: audienceMembers.id });

    if (deleted.length === 0) return "not-a-member";

    // Resolve display name for the event payload (best-effort).
    const user = await tx.query.users.findFirst({ where: eq(users.id, userId) });

    await emitEvent(tx, {
      kind: "audience.member_removed",
      payload: {
        audience: aud.key,
        userId,
        displayName: user?.displayName ?? null,
      },
      actorName: by,
    });

    return "ok";
  });
}
