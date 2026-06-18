import { eq, and, gt, inArray, asc, sql, type SQL } from "drizzle-orm";
import { db, schema } from "@/db";
import { events, docs, audiences, audienceMembers } from "@/db/schema";

/**
 * Event-log service — the append-only change-cursor that backs sync (S2+),
 * observability, and (later) agent triggering.
 *
 * Two hard rules, enforced here and at every call site:
 *
 *  1. **Transactional emission.** `emitEvent` takes a transaction handle (`tx`)
 *     and appends inside it, so an event is written IFF its mutation commits. A
 *     rolled-back publish/revision/comment emits nothing. Callers MUST pass the
 *     same `tx` they mutate on — never `db` directly from inside a transaction.
 *
 *  2. **Payloads carry references, not content.** ids / slugs / buckets /
 *     version ids only. Never a document body, comment body, or revision
 *     content — consumers fetch those through the normal scoped read paths.
 *
 * Cursor = `events.id` (bigserial, server-monotonic). Consumers page with
 * `?since=<id>`; there are no client clocks.
 */

// ── Event kinds ─────────────────────────────────────────────────────────────

/** The S1 event kinds. Frozen tuple so callers + tests share one source. */
export const EVENT_KINDS = [
  "doc.published",
  "doc.unpublished",
  "doc.moved",
  "doc.deleted",
  "revision.proposed",
  "revision.decided",
  "comment.added",
  "user.approved",
  // User email management (multi-email). Admin-only visibility — like
  // user.approved, the payload carries an email (admin-audit data) and only
  // admins manage users, so these never reach the member feed. Payload: userId
  // + email + displayName.
  "user.email_added",
  "user.email_removed",
  // P2 board kinds. These are internal coordination events on staff-only
  // surfaces (the board has no audience scoping) — every staff principal sees
  // them, admin and member alike. Payloads carry card/bucket ids + bucket keys,
  // never card bodies or checklist text.
  "card.created",
  "card.moved",
  "card.updated",
  "card.assigned",
  "card.archived",
  "bucket.created",
  "bucket.updated",
  "bucket.deleted",
  // P3 catalog kinds. Like the board, catalogs are an internal coordination
  // surface (no audience scoping) — staff-visible to admin and member alike.
  // Schema events register a kind; item events carry kind/itemId/title/status
  // only (never the item body or data payload).
  "catalog.schema.created",
  "catalog.schema.updated",
  "catalog.schema.deleted",
  "catalog.item.created",
  "catalog.item.updated",
  "catalog.item.deleted",
  // Audiences v2 membership kinds. Audience membership is an internal admin
  // surface (no doc scoping) — staff-visible to admin and member alike. Payload
  // carries the audience key + userId + displayName, never anything sensitive.
  "audience.member_added",
  "audience.member_removed",
  // Doc ownership (migration 0014). Emitted when an admin reassigns a doc's
  // owner via setDocOwner. Payload: slug, fromUserId, toUserId. Admin-only in
  // the event feed (ownership is an internal admin-audit event).
  "doc.owner_changed",
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

/** Kinds only an admin may ever see in the feed. */
const ADMIN_ONLY_KINDS = new Set<string>([
  "user.approved",
  "user.email_added",
  "user.email_removed",
  "doc.owner_changed",
]);

/**
 * Kinds that are staff-visible without audience scoping — they live on internal
 * coordination surfaces (the board), so any member sees them. They have no
 * docId, so the doc-audience gate doesn't apply; they're surfaced to members
 * explicitly. Never on the share host or to anonymous (the route gates that).
 */
const STAFF_VISIBLE_KINDS = new Set<string>([
  "card.created",
  "card.moved",
  "card.updated",
  "card.assigned",
  "card.archived",
  "bucket.created",
  "bucket.updated",
  "bucket.deleted",
  "catalog.schema.created",
  "catalog.schema.updated",
  "catalog.schema.deleted",
  "catalog.item.created",
  "catalog.item.updated",
  "catalog.item.deleted",
  "audience.member_added",
  "audience.member_removed",
]);

// ── emitEvent ───────────────────────────────────────────────────────────────

/**
 * A db transaction handle — the type drizzle's `db.transaction(async (tx) => …)`
 * hands the callback. We accept it (or the top-level `db`) so emitEvent can
 * append inside the SAME transaction as its mutation.
 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type EventEmitter = Tx | typeof db;

export type EmitEventInput = {
  kind: EventKind;
  /** Set for doc-scoped kinds; null/undefined for non-doc kinds. */
  docId?: number | null;
  /** Reference-only payload — ids/slugs/buckets/versionIds. Never content. */
  payload: Record<string, unknown>;
  /** The acting principal's display name. */
  actorName: string;
};

/**
 * Append one event. Pass the mutation's transaction handle as `tx` so the event
 * is written atomically with the mutation (rollback ⇒ no event). The returned
 * row id is the cursor value for that event.
 */
export async function emitEvent(
  tx: EventEmitter,
  input: EmitEventInput,
): Promise<{ id: number }> {
  const [row] = await tx
    .insert(events)
    .values({
      kind: input.kind,
      docId: input.docId ?? null,
      payload: input.payload,
      actorName: input.actorName,
    })
    .returning({ id: events.id });
  return { id: row.id };
}

// ── listEvents ──────────────────────────────────────────────────────────────

export type EventRow = {
  id: number;
  kind: string;
  payload: unknown;
  actorName: string;
  createdAt: Date;
};

export type ListEventsOpts = {
  /** Exclusive lower bound on the cursor (events with id > since). */
  since?: number;
  /** Restrict to these kinds (already validated by the caller). */
  kinds?: string[];
  /** Page size cap. Defaults + max enforced inside. */
  limit?: number;
  /** Viewer scope — admins see everything; members are audience-scoped. */
  viewer: "admin" | "member";
  /**
   * The member's resolved users-row id (Audiences v2). Decides which
   * membership-targeted audiences this member may see in the feed. Null/absent
   * → flag-only visibility (fail-closed). Ignored for admins.
   */
  userId?: number | null;
};

/** Default / max page size for an events page. */
export const DEFAULT_EVENTS_LIMIT = 200;
export const MAX_EVENTS_LIMIT = 1000;

/**
 * List events after `since`, oldest-first (ascending cursor — consumers replay
 * in order and advance `since` to the last id seen).
 *
 * Audience scoping (server-side, fail-closed):
 *   - admin: every event.
 *   - member: doc-scoped events ONLY for docs whose audience is member-visible
 *     to THIS member — flag-visible (member_visible=1) OR an audience the member
 *     belongs to (Audiences v2). Joined on docs.id; admin-only kinds
 *     (user.approved) are excluded entirely; any unknown kind is treated as
 *     doc-scoped and excluded unless its doc is visible (so a future kind can't
 *     leak by default).
 *
 * Payloads are returned as-is (they already carry references only).
 */
export async function listEvents(opts: ListEventsOpts): Promise<EventRow[]> {
  const limit = Math.min(
    Math.max(1, opts.limit ?? DEFAULT_EVENTS_LIMIT),
    MAX_EVENTS_LIMIT,
  );

  const conds: SQL[] = [];
  if (opts.since != null) conds.push(gt(events.id, opts.since));
  if (opts.kinds && opts.kinds.length > 0) {
    conds.push(inArray(events.kind, opts.kinds));
  }

  if (opts.viewer === "admin") {
    const where = conds.length > 0 ? and(...conds) : undefined;
    const rows = await db
      .select({
        id: events.id,
        kind: events.kind,
        payload: events.payload,
        actorName: events.actorName,
        createdAt: events.createdAt,
      })
      .from(events)
      .where(where)
      .orderBy(asc(events.id))
      .limit(limit);
    return rows;
  }

  // Member visibility is a union of two disjoint sets:
  //   (a) staff-visible board kinds (card.*/bucket.*) — internal coordination
  //       surface, no audience scoping, no docId.
  //   (b) doc-scoped kinds whose referenced doc has a member-visible audience.
  // Admin-only kinds (user.approved) are excluded from both. We compute the set
  // of member-visible audience keys once, then express the union as a LEFT JOIN
  // on docs with an OR predicate (a board event has no doc, so the join misses;
  // we admit it via the staff-visible branch).
  // Flag-visible audience keys (everyone signed in) ∪ keys this member belongs
  // to (Audiences v2 membership). userId null → membership half empty (fail-
  // closed to flag-only, matching the pre-v2 behaviour).
  const flagKeys = (
    await db
      .select({ key: audiences.key })
      .from(audiences)
      .where(eq(audiences.memberVisible, 1))
  ).map((r) => r.key);
  const memberKeys =
    opts.userId != null
      ? (
          await db
            .select({ key: audiences.key })
            .from(audienceMembers)
            .innerJoin(audiences, eq(audiences.id, audienceMembers.audienceId))
            .where(eq(audienceMembers.userId, opts.userId))
        ).map((r) => r.key)
      : [];
  const visibleKeys = [...new Set([...flagKeys, ...memberKeys])];

  // Exclude admin-only kinds explicitly (defense in depth — even if a caller
  // passed one in `kinds`).
  conds.push(sql`${events.kind} not in (${sql.join(
    [...ADMIN_ONLY_KINDS].map((k) => sql`${k}`),
    sql`, `,
  )})`);

  // Staff-visible (board) branch: kind ∈ STAFF_VISIBLE_KINDS.
  const staffVisibleBranch = sql`${events.kind} in (${sql.join(
    [...STAFF_VISIBLE_KINDS].map((k) => sql`${k}`),
    sql`, `,
  )})`;

  // Doc-scoped branch: a referenced doc whose audience is member-visible. With
  // no visible audiences this branch admits nothing.
  const docScopedBranch =
    visibleKeys.length > 0
      ? sql`(${events.docId} is not null and ${inArray(docs.audience, visibleKeys)})`
      : sql`false`;

  conds.push(sql`(${staffVisibleBranch} or ${docScopedBranch})`);

  const rows = await db
    .select({
      id: events.id,
      kind: events.kind,
      payload: events.payload,
      actorName: events.actorName,
      createdAt: events.createdAt,
    })
    .from(events)
    .leftJoin(docs, eq(docs.id, events.docId))
    .where(and(...conds))
    .orderBy(asc(events.id))
    .limit(limit);
  return rows;
}

/**
 * Validate a comma-separated `kinds` filter string against the known kinds.
 * Returns the parsed list (deduped, in input order) or null if any token is
 * unknown — the caller maps null to a 400. An empty/whitespace string → []
 * (no filter).
 */
export function parseKindsParam(raw: string | null | undefined): string[] | null {
  if (raw == null) return [];
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];
  const known = new Set<string>(EVENT_KINDS);
  const out: string[] = [];
  for (const tok of trimmed.split(",")) {
    const k = tok.trim();
    if (k.length === 0) continue;
    if (!known.has(k)) return null;
    if (!out.includes(k)) out.push(k);
  }
  return out;
}

// Re-export the schema reference so call sites that need the raw table (rare)
// don't reach past this module.
export { schema };
