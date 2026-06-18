import { eq, sql, asc, and, isNull } from "drizzle-orm";
import { db } from "@/db";
import { buckets, cards } from "@/db/schema";
import { emitEvent } from "@/lib/events";

/**
 * Buckets are the board's columns — admin-configurable data (the same move
 * audiences made from a hardcoded set to a table). Each bucket is a stable
 * `key` (slug) + a human `label` + an integer `position` (column order). The
 * key appears in card.* event payloads (from/to bucket keys) so consumers can
 * filter `card.moved` without resolving ids.
 *
 * Mutations emit `bucket.created` / `bucket.updated` / `bucket.deleted` events
 * in-transaction (payloads carry the bucket id + key, never card bodies). A
 * bucket is deletable only when empty (no live or archived cards reference it)
 * — we never orphan a card's bucket.
 */

export type BucketItem = {
  id: number;
  key: string;
  label: string;
  position: number;
  createdAt: Date;
  /** Number of LIVE (non-archived) cards in this bucket. */
  cardCount: number;
};

/** Same slug contract audiences/docs use. */
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
 * Derive a slug key from a free-text label. Lowercase, non-alnum → hyphen,
 * collapse + trim hyphens. Returns "" when nothing usable remains (caller
 * rejects). Used when a bucket is created from the board (label only — the key
 * is machine-derived, like the audience key pattern but auto-minted).
 */
export function deriveBucketKey(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * All buckets ordered by position (then id), each with a live card-count.
 */
export async function listBuckets(): Promise<BucketItem[]> {
  const rows = await db
    .select({
      id: buckets.id,
      key: buckets.key,
      label: buckets.label,
      position: buckets.position,
      createdAt: buckets.createdAt,
      cardCount: sql<number>`cast(count(${cards.id}) filter (where ${cards.archivedAt} is null) as int)`,
    })
    .from(buckets)
    .leftJoin(cards, eq(cards.bucketId, buckets.id))
    .groupBy(buckets.id)
    .orderBy(asc(buckets.position), asc(buckets.id));

  return rows.map((r) => ({
    id: r.id,
    key: r.key,
    label: r.label,
    position: r.position,
    createdAt: r.createdAt,
    cardCount: r.cardCount,
  }));
}

/** Load one bucket by id, or null. */
export async function getBucket(id: number): Promise<BucketItem | null> {
  const all = await listBuckets();
  return all.find((b) => b.id === id) ?? null;
}

export type CreateBucketInput = {
  /** Optional explicit key; when omitted it's derived from the label. */
  key?: string;
  label: string;
  actorName: string;
};

/**
 * Create a bucket at the end of the column order. Returns null on an invalid
 * label/key or a duplicate key. The key is either the provided one (must match
 * the slug pattern) or derived from the label. Emits `bucket.created`.
 */
export async function createBucket(
  input: CreateBucketInput,
): Promise<BucketItem | null> {
  const label = input.label.trim();
  if (label.length === 0) return null;
  const key = (input.key?.trim() || deriveBucketKey(label)).trim();
  if (!KEY_RE.test(key)) return null;

  try {
    return await db.transaction(async (tx) => {
      const [{ maxPos }] = await tx
        .select({ maxPos: sql<number>`coalesce(max(${buckets.position}), 0)` })
        .from(buckets);
      const [row] = await tx
        .insert(buckets)
        .values({ key, label, position: maxPos + 1 })
        .returning();
      await emitEvent(tx, {
        kind: "bucket.created",
        payload: { bucketId: row.id, bucketKey: row.key },
        actorName: input.actorName,
      });
      return {
        id: row.id,
        key: row.key,
        label: row.label,
        position: row.position,
        createdAt: row.createdAt,
        cardCount: 0,
      };
    });
  } catch (e) {
    if (isUniqueViolation(e)) return null;
    throw e;
  }
}

export type UpdateBucketResult = "ok" | "not-found" | "invalid";

/**
 * Rename a bucket (label only — the key is immutable, it's referenced in event
 * payloads). Trims; an empty label after trim → "invalid". Emits
 * `bucket.updated`. Returns "not-found" for an unknown id.
 */
export async function renameBucket(
  id: number,
  label: string,
  actorName: string,
): Promise<UpdateBucketResult> {
  const trimmed = label.trim();
  if (trimmed.length === 0) return "invalid";
  return db.transaction(async (tx) => {
    const existing = await tx.query.buckets.findFirst({
      where: eq(buckets.id, id),
    });
    if (!existing) return "not-found";
    await tx.update(buckets).set({ label: trimmed }).where(eq(buckets.id, id));
    await emitEvent(tx, {
      kind: "bucket.updated",
      payload: { bucketId: id, bucketKey: existing.key },
      actorName,
    });
    return "ok";
  });
}

export type ReorderBucketResult = "ok" | "not-found";

/**
 * Reorder buckets to the exact id sequence given. Every existing bucket id must
 * be present (a total reorder, not a partial move) — otherwise "not-found".
 * Positions are renumbered 1..N in the provided order. Emits one
 * `bucket.updated` for the board (single event, no per-bucket spam). This backs
 * both "move left" / "move right" (the UI computes the new order) and any
 * drag-reorder of columns.
 */
export async function reorderBuckets(
  orderedIds: number[],
  actorName: string,
): Promise<ReorderBucketResult> {
  return db.transaction(async (tx) => {
    const all = await tx.select({ id: buckets.id }).from(buckets);
    const existing = new Set(all.map((b) => b.id));
    if (orderedIds.length !== existing.size) return "not-found";
    for (const id of orderedIds) {
      if (!existing.has(id)) return "not-found";
    }
    // Two-phase to dodge the unique-nothing (position isn't unique, but keep it
    // deterministic): write final positions directly.
    for (let i = 0; i < orderedIds.length; i++) {
      await tx
        .update(buckets)
        .set({ position: i + 1 })
        .where(eq(buckets.id, orderedIds[i]));
    }
    await emitEvent(tx, {
      kind: "bucket.updated",
      payload: { reordered: orderedIds },
      actorName,
    });
    return "ok";
  });
}

export type DeleteBucketResult = "ok" | "not-found" | "in-use";

/**
 * Delete a bucket by id.
 *
 * - "not-found" when the id is unknown.
 * - "in-use" when ANY card (live OR archived) still references the bucket — we
 *   never orphan a card's bucket. The board gates the delete affordance on a
 *   live-empty bucket; the service additionally refuses if archived cards point
 *   here (restore would land nowhere).
 * - "ok" once deleted. Emits `bucket.deleted`.
 */
export async function deleteBucket(
  id: number,
  actorName: string,
): Promise<DeleteBucketResult> {
  return db.transaction(async (tx) => {
    const existing = await tx.query.buckets.findFirst({
      where: eq(buckets.id, id),
    });
    if (!existing) return "not-found";

    const [{ count }] = await tx
      .select({ count: sql<number>`cast(count(*) as int)` })
      .from(cards)
      .where(eq(cards.bucketId, id));
    if (count > 0) return "in-use";

    await tx.delete(buckets).where(eq(buckets.id, id));
    await emitEvent(tx, {
      kind: "bucket.deleted",
      payload: { bucketId: id, bucketKey: existing.key },
      actorName,
    });
    return "ok";
  });
}

/** True iff a live (non-archived) bucket-empty check passes. Test helper-ish. */
export async function bucketLiveCardCount(id: number): Promise<number> {
  const [{ count }] = await db
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(cards)
    .where(and(eq(cards.bucketId, id), isNull(cards.archivedAt)));
  return count;
}
