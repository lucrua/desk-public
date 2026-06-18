import { eq, and, asc, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { cards, buckets, users, events } from "@/db/schema";
import { emitEvent } from "@/lib/events";
import type { Principal } from "@/lib/auth";
import {
  MAX_CARD_BODY_CHARS,
  MAX_CHECKLIST_ITEMS,
  MAX_CHECKLIST_ITEM_CHARS,
} from "@/lib/limits";

/**
 * Cards — the board's live coordination truth. The board surface is staff-only
 * (no audience scoping; it's internal). Authorization:
 *
 *   - admin  → everything.
 *   - member → create cards; read all; edit/move/check/archive ONLY cards they
 *     own (ownerUserId === their users row). A member with no users row (dev
 *     mode, or a brand-new principal) owns nothing and so can only create + read.
 *
 * Ownership is matched by resolving the principal to a users row (email OR
 * tokenName, mirroring isSelfDeactivation) — see resolveMemberUserId.
 *
 * Every mutation emits a card.* event in-transaction. Payloads carry ids and
 * bucket KEYS (from/to) — never the body or checklist text. This is what lets a
 * consumer spin up an agent on `card.moved` + `to` bucket key.
 *
 * Position is a fractional float, ordering cards WITHIN a bucket. A move inserts
 * the card at the midpoint between its new neighbors; when the gap collapses
 * (neighbors equal, or floats too close) the bucket is renormalized to integer
 * spacing and the move retried.
 */

// ── Types ───────────────────────────────────────────────────────────────────

export type ChecklistItem = { text: string; done: boolean };

export type CardRow = {
  id: number;
  title: string;
  body: string;
  bucketId: number;
  bucketKey: string;
  position: number;
  ownerUserId: number | null;
  ownerName: string | null;
  docSlug: string | null;
  checklist: ChecklistItem[];
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
};

export type CardActivityEvent = {
  id: number;
  kind: string;
  payload: unknown;
  actorName: string;
  createdAt: Date;
};

// ── Validation helpers ──────────────────────────────────────────────────────

export type ValidationError = { ok: false; error: string };
type Ok<T> = { ok: true; value: T };
export type Validated<T> = Ok<T> | ValidationError;

function validateTitle(raw: unknown): Validated<string> {
  if (typeof raw !== "string") return { ok: false, error: "title must be a string" };
  const t = raw.trim();
  if (t.length === 0) return { ok: false, error: "title must be non-empty" };
  if (t.length > 500) return { ok: false, error: "title too long (max 500 chars)" };
  return { ok: true, value: t };
}

function validateBody(raw: unknown): Validated<string> {
  if (raw == null) return { ok: true, value: "" };
  if (typeof raw !== "string") return { ok: false, error: "body must be a string" };
  if (raw.length > MAX_CARD_BODY_CHARS) {
    return { ok: false, error: `body too long (max ${MAX_CARD_BODY_CHARS} chars)` };
  }
  return { ok: true, value: raw };
}

function validateChecklist(raw: unknown): Validated<ChecklistItem[]> {
  if (raw == null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, error: "checklist must be an array" };
  if (raw.length > MAX_CHECKLIST_ITEMS) {
    return { ok: false, error: `checklist too long (max ${MAX_CHECKLIST_ITEMS} items)` };
  }
  const out: ChecklistItem[] = [];
  for (const it of raw) {
    if (it == null || typeof it !== "object") {
      return { ok: false, error: "each checklist item must be an object {text, done}" };
    }
    const text = (it as { text?: unknown }).text;
    const done = (it as { done?: unknown }).done;
    if (typeof text !== "string" || text.trim().length === 0) {
      return { ok: false, error: "each checklist item needs a non-empty text" };
    }
    if (text.length > MAX_CHECKLIST_ITEM_CHARS) {
      return { ok: false, error: `checklist item too long (max ${MAX_CHECKLIST_ITEM_CHARS} chars)` };
    }
    if (typeof done !== "boolean") {
      return { ok: false, error: "each checklist item needs a boolean done" };
    }
    out.push({ text, done });
  }
  return { ok: true, value: out };
}

// ── Principal → users row (ownership) ───────────────────────────────────────

/**
 * Resolve a member principal to its users-row id, matching by email OR
 * tokenName (the same identity match isSelfDeactivation uses). Returns null when
 * the principal is anonymous or has no users row (dev mode) — such a principal
 * owns no cards.
 */
export async function resolveMemberUserId(
  principal: Principal,
): Promise<number | null> {
  if (principal.kind === "anonymous") return null;
  // Match against ALL of the principal's emails (multi-email): a login via a
  // secondary address still owns the same cards. Fall back to the single `email`
  // field for principals that don't carry the full set.
  const emails = new Set(
    (principal.emails ?? (principal.email ? [principal.email] : [])).map((e) =>
      e.trim().toLowerCase(),
    ),
  );
  const tokenName = principal.tokenName?.trim();
  if (emails.size === 0 && !tokenName) return null;
  const rows = await db.select({ id: users.id, email: users.email, tokenName: users.tokenName }).from(users);
  for (const r of rows) {
    const em = r.email?.toLowerCase();
    if (em && emails.has(em)) return r.id;
    if (tokenName && r.tokenName && r.tokenName === tokenName) return r.id;
  }
  return null;
}

/**
 * Authorization predicate for editing/moving/archiving a card. Admin → always.
 * Member → only when they own the card (resolved users-row id matches
 * ownerUserId). Pure given the resolved memberUserId, so it's trivially
 * testable as a matrix.
 */
export function canEditCard(
  principal: Principal,
  card: { ownerUserId: number | null },
  memberUserId: number | null,
): boolean {
  if (principal.kind === "admin") return true;
  if (principal.kind !== "member") return false;
  if (memberUserId == null) return false;
  return card.ownerUserId === memberUserId;
}

// ── Read ────────────────────────────────────────────────────────────────────

const selectCard = {
  id: cards.id,
  title: cards.title,
  body: cards.body,
  bucketId: cards.bucketId,
  bucketKey: buckets.key,
  position: cards.position,
  ownerUserId: cards.ownerUserId,
  ownerName: users.displayName,
  docSlug: cards.docSlug,
  checklist: cards.checklist,
  createdAt: cards.createdAt,
  updatedAt: cards.updatedAt,
  archivedAt: cards.archivedAt,
} as const;

function toRow(r: Record<string, unknown>): CardRow {
  return {
    id: r.id as number,
    title: r.title as string,
    body: r.body as string,
    bucketId: r.bucketId as number,
    bucketKey: r.bucketKey as string,
    position: r.position as number,
    ownerUserId: (r.ownerUserId as number | null) ?? null,
    ownerName: (r.ownerName as string | null) ?? null,
    docSlug: (r.docSlug as string | null) ?? null,
    checklist: Array.isArray(r.checklist) ? (r.checklist as ChecklistItem[]) : [],
    createdAt: r.createdAt as Date,
    updatedAt: r.updatedAt as Date,
    archivedAt: (r.archivedAt as Date | null) ?? null,
  };
}

export type ListCardsOpts = {
  bucketId?: number;
  ownerUserId?: number;
  includeArchived?: boolean;
};

/**
 * List cards (staff-wide; the board is not audience-scoped). Live cards only by
 * default; pass includeArchived to include archived ones. Ordered by bucket
 * position, then card position (the board's natural order).
 */
export async function listCards(opts: ListCardsOpts = {}): Promise<CardRow[]> {
  const conds = [];
  if (opts.bucketId != null) conds.push(eq(cards.bucketId, opts.bucketId));
  if (opts.ownerUserId != null) conds.push(eq(cards.ownerUserId, opts.ownerUserId));
  if (!opts.includeArchived) conds.push(isNull(cards.archivedAt));

  const rows = await db
    .select(selectCard)
    .from(cards)
    .innerJoin(buckets, eq(buckets.id, cards.bucketId))
    .leftJoin(users, eq(users.id, cards.ownerUserId))
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(asc(buckets.position), asc(cards.position), asc(cards.id));

  return rows.map(toRow);
}

/** Load one card by id, or null. */
export async function getCard(id: number): Promise<CardRow | null> {
  const rows = await db
    .select(selectCard)
    .from(cards)
    .innerJoin(buckets, eq(buckets.id, cards.bucketId))
    .leftJoin(users, eq(users.id, cards.ownerUserId))
    .where(eq(cards.id, id))
    .limit(1);
  return rows.length > 0 ? toRow(rows[0]) : null;
}

/**
 * The activity trail for a card: every card.* event whose payload.cardId is this
 * card, oldest-first. Staff-only at the call site. Used by the drawer.
 */
export async function getCardActivity(cardId: number): Promise<CardActivityEvent[]> {
  const rows = await db
    .select({
      id: events.id,
      kind: events.kind,
      payload: events.payload,
      actorName: events.actorName,
      createdAt: events.createdAt,
    })
    .from(events)
    .where(
      and(
        sql`${events.kind} like 'card.%'`,
        sql`(${events.payload} ->> 'cardId')::int = ${cardId}`,
      ),
    )
    .orderBy(asc(events.id));
  return rows;
}

// ── Position strategy ───────────────────────────────────────────────────────

/** Min gap before we renormalize a bucket's float positions. */
const MIN_GAP = 1e-6;

/**
 * Compute the insert position for a card landing at slot `index` within
 * `bucketId` (0 = first, omitted/large = end). `excludeId` skips the card being
 * moved (so re-dropping in place is well-defined). Renormalizes the bucket to
 * integer spacing and recomputes when the float gap collapses.
 *
 * Returns the float to write. May renormalize sibling rows as a side effect
 * (inside the given tx).
 */
async function computeInsertPosition(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  bucketId: number,
  index: number | null | undefined,
  excludeId: number | null,
): Promise<number> {
  const siblings = await tx
    .select({ id: cards.id, position: cards.position })
    .from(cards)
    .where(
      and(
        eq(cards.bucketId, bucketId),
        isNull(cards.archivedAt),
        excludeId != null ? sql`${cards.id} <> ${excludeId}` : undefined,
      ),
    )
    .orderBy(asc(cards.position), asc(cards.id));

  const n = siblings.length;
  const i = index == null ? n : Math.max(0, Math.min(index, n));

  const before = i > 0 ? siblings[i - 1].position : null;
  const after = i < n ? siblings[i].position : null;

  let pos: number;
  if (before == null && after == null) pos = 1; // empty bucket
  else if (before == null) pos = (after as number) - 1; // head
  else if (after == null) pos = (before as number) + 1; // tail
  else pos = (before + after) / 2; // between

  // Collapsed gap → renormalize to integers and recompute the midpoint cleanly.
  if (before != null && after != null && after - before < MIN_GAP) {
    for (let k = 0; k < n; k++) {
      await tx
        .update(cards)
        .set({ position: k + 1 })
        .where(eq(cards.id, siblings[k].id));
    }
    // After renormalizing, slot i sits between integer i and i+1.
    const b = i > 0 ? i : null;
    const a = i < n ? i + 1 : null;
    if (b == null && a == null) pos = 1;
    else if (b == null) pos = (a as number) - 0.5;
    else if (a == null) pos = (b as number) + 1;
    else pos = (b + a) / 2;
  }
  return pos;
}

// ── Mutations ───────────────────────────────────────────────────────────────

export type CreateCardInput = {
  title: unknown;
  body?: unknown;
  bucketId?: number;
  bucketKey?: string;
  ownerUserId?: number | null;
  docSlug?: string | null;
  checklist?: unknown;
  actorName: string;
};

export type CreateCardResult =
  | { ok: true; card: CardRow }
  | { ok: false; error: string };

/**
 * Create a card at the END of its bucket. Any staff principal may create (the
 * authz is at the route — members can create). Validates title/body/checklist;
 * resolves the bucket by id or key. Emits `card.created`.
 */
export async function createCard(input: CreateCardInput): Promise<CreateCardResult> {
  const title = validateTitle(input.title);
  if (!title.ok) return title;
  const body = validateBody(input.body);
  if (!body.ok) return body;
  const checklist = validateChecklist(input.checklist);
  if (!checklist.ok) return checklist;

  return db.transaction(async (tx) => {
    const bucket = input.bucketId != null
      ? await tx.query.buckets.findFirst({ where: eq(buckets.id, input.bucketId) })
      : input.bucketKey != null
        ? await tx.query.buckets.findFirst({ where: eq(buckets.key, input.bucketKey) })
        : undefined;
    if (!bucket) return { ok: false as const, error: "bucket not found" };

    if (input.ownerUserId != null) {
      const owner = await tx.query.users.findFirst({ where: eq(users.id, input.ownerUserId) });
      if (!owner) return { ok: false as const, error: "owner user not found" };
    }

    const position = await computeInsertPosition(tx, bucket.id, null, null);

    const [row] = await tx
      .insert(cards)
      .values({
        title: title.value,
        body: body.value,
        bucketId: bucket.id,
        position,
        ownerUserId: input.ownerUserId ?? null,
        docSlug: input.docSlug ?? null,
        checklist: checklist.value,
      })
      .returning({ id: cards.id });

    await emitEvent(tx, {
      kind: "card.created",
      payload: { cardId: row.id, bucket: bucket.key },
      actorName: input.actorName,
    });

    const created = await loadCardTx(tx, row.id);
    return { ok: true as const, card: created! };
  });
}

async function loadCardTx(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  id: number,
): Promise<CardRow | null> {
  const rows = await tx
    .select(selectCard)
    .from(cards)
    .innerJoin(buckets, eq(buckets.id, cards.bucketId))
    .leftJoin(users, eq(users.id, cards.ownerUserId))
    .where(eq(cards.id, id))
    .limit(1);
  return rows.length > 0 ? toRow(rows[0]) : null;
}

export type MutateResult =
  | { ok: true; card: CardRow }
  | { ok: false; error: string; code?: "not-found" };

/**
 * Move a card to `bucketId` at slot `index` (fractional reorder). Emits
 * `card.moved` with from/to bucket keys (only when the bucket actually changes
 * OR the position changes — always emit so the activity trail records reorders).
 */
export async function moveCard(
  cardId: number,
  bucketId: number,
  index: number | null,
  actorName: string,
): Promise<MutateResult> {
  return db.transaction(async (tx) => {
    const card = await tx.query.cards.findFirst({ where: eq(cards.id, cardId) });
    if (!card) return { ok: false as const, error: "card not found", code: "not-found" as const };
    const fromBucket = await tx.query.buckets.findFirst({ where: eq(buckets.id, card.bucketId) });
    const toBucket = await tx.query.buckets.findFirst({ where: eq(buckets.id, bucketId) });
    if (!toBucket) return { ok: false as const, error: "bucket not found" };

    const position = await computeInsertPosition(tx, bucketId, index, cardId);

    await tx
      .update(cards)
      .set({ bucketId, position, updatedAt: new Date() })
      .where(eq(cards.id, cardId));

    await emitEvent(tx, {
      kind: "card.moved",
      payload: {
        cardId,
        from: fromBucket?.key ?? null,
        to: toBucket.key,
      },
      actorName,
    });

    const moved = await loadCardTx(tx, cardId);
    return { ok: true as const, card: moved! };
  });
}

export type UpdateCardInput = {
  title?: unknown;
  body?: unknown;
  docSlug?: string | null | undefined;
  checklist?: unknown;
  actorName: string;
};

/**
 * Patch a card's title/body/docSlug/checklist. Each field is optional (only the
 * provided ones change). Emits `card.updated` listing the changed fields.
 */
export async function updateCard(
  cardId: number,
  input: UpdateCardInput,
): Promise<MutateResult> {
  const set: Record<string, unknown> = {};
  const changed: string[] = [];

  if (input.title !== undefined) {
    const v = validateTitle(input.title);
    if (!v.ok) return { ok: false as const, error: v.error };
    set.title = v.value;
    changed.push("title");
  }
  if (input.body !== undefined) {
    const v = validateBody(input.body);
    if (!v.ok) return { ok: false as const, error: v.error };
    set.body = v.value;
    changed.push("body");
  }
  if (input.docSlug !== undefined) {
    if (input.docSlug !== null && typeof input.docSlug !== "string") {
      return { ok: false as const, error: "docSlug must be a string or null" };
    }
    set.docSlug = input.docSlug === "" ? null : input.docSlug;
    changed.push("docSlug");
  }
  if (input.checklist !== undefined) {
    const v = validateChecklist(input.checklist);
    if (!v.ok) return { ok: false as const, error: v.error };
    set.checklist = v.value;
    changed.push("checklist");
  }

  if (changed.length === 0) return { ok: false as const, error: "nothing to update" };

  return db.transaction(async (tx) => {
    const card = await tx.query.cards.findFirst({ where: eq(cards.id, cardId) });
    if (!card) return { ok: false as const, error: "card not found", code: "not-found" as const };
    set.updatedAt = new Date();
    await tx.update(cards).set(set).where(eq(cards.id, cardId));
    await emitEvent(tx, {
      kind: "card.updated",
      payload: { cardId, fields: changed },
      actorName: input.actorName,
    });
    const updated = await loadCardTx(tx, cardId);
    return { ok: true as const, card: updated! };
  });
}

/**
 * Assign (or clear) a card's owner. Admin-only at the call site (owner
 * reassignment is admin-only per the design). Emits `card.assigned`.
 */
export async function assignCard(
  cardId: number,
  ownerUserId: number | null,
  actorName: string,
): Promise<MutateResult> {
  return db.transaction(async (tx) => {
    const card = await tx.query.cards.findFirst({ where: eq(cards.id, cardId) });
    if (!card) return { ok: false as const, error: "card not found", code: "not-found" as const };
    if (ownerUserId != null) {
      const owner = await tx.query.users.findFirst({ where: eq(users.id, ownerUserId) });
      if (!owner) return { ok: false as const, error: "owner user not found" };
    }
    await tx
      .update(cards)
      .set({ ownerUserId, updatedAt: new Date() })
      .where(eq(cards.id, cardId));
    await emitEvent(tx, {
      kind: "card.assigned",
      payload: { cardId, ownerUserId },
      actorName,
    });
    const updated = await loadCardTx(tx, cardId);
    return { ok: true as const, card: updated! };
  });
}

/**
 * Archive or restore a card (soft). Emits `card.archived` (payload carries the
 * archived flag + the bucket key it was in, so a restore can be narrated).
 */
export async function setCardArchived(
  cardId: number,
  archived: boolean,
  actorName: string,
): Promise<MutateResult> {
  return db.transaction(async (tx) => {
    const card = await tx.query.cards.findFirst({ where: eq(cards.id, cardId) });
    if (!card) return { ok: false as const, error: "card not found", code: "not-found" as const };
    const bucket = await tx.query.buckets.findFirst({ where: eq(buckets.id, card.bucketId) });
    await tx
      .update(cards)
      .set({ archivedAt: archived ? new Date() : null, updatedAt: new Date() })
      .where(eq(cards.id, cardId));
    await emitEvent(tx, {
      kind: "card.archived",
      payload: { cardId, archived, bucket: bucket?.key ?? null },
      actorName,
    });
    const updated = await loadCardTx(tx, cardId);
    return { ok: true as const, card: updated! };
  });
}
