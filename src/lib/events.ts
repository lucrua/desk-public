import { eq, and, gt, inArray, asc, sql, type SQL } from "drizzle-orm";
import { db, schema } from "@/db";
import { events, docs, spaces, spaceMembers } from "@/db/schema";

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
  // Doc ownership (migration 0014). Emitted when an admin reassigns a doc's
  // owner via setDocOwner. Payload: slug, fromUserId, toUserId. Admin-only in
  // the event feed (ownership is an internal admin-audit event).
  "doc.owner_changed",
  // Document-host (Phase 1) — space + membership mutations. Spaces are the
  // WRITE boundary; their lifecycle is an internal admin-audit surface (no doc
  // scoping). Payloads carry the space slug + userId/role only, never content.
  // Admin-only in the feed (like doc.owner_changed).
  "space.created",
  "space.updated",
  "space.member_added",
  "space.member_removed",
  // External Collaboration (Slice E1) — invite lifecycle. An invite is a
  // capability link an owner/admin mints; accepting it self-serves an external
  // partner into the space. The payload may carry a target email (admin-audit
  // data), so — like space.member_* — these are ADMIN-ONLY in the feed and never
  // reach a member or the share host. invite_created: { slug, role, inviteId };
  // invite_accepted: { slug, role, userId } (never the raw token).
  "space.invite_created",
  "space.invite_accepted",
  // External Collaboration (Slice E2) — proposals (PR) lifecycle. In `proposal`
  // push-policy mode a non-owner writer's push lands on `proposals/*`; an
  // owner/admin accepts (merge → main + reindex + delete ref) or rejects (delete
  // ref). Admin-only in the feed (a space-management surface, like space.*).
  // Payload: { slug, name, merged?, tipSha } — never file content.
  "proposal.accepted",
  "proposal.rejected",
  // Web-author (Slice W1/W2) — a browser save that became a git commit. An
  // owner/admin direct commit to `main` (doc.web_committed) or a non-owner
  // writer's web write that opened a `proposals/<handle>` ref (proposal.opened).
  // Like the rest of the space-write surface these are ADMIN-ONLY in the feed
  // (a space-management/audit signal). Payload: { slug, ref, newSha, path? } —
  // ids/refs/shas only, never file content.
  "doc.web_committed",
  "proposal.opened",
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

/** Kinds only an admin may ever see in the feed. */
const ADMIN_ONLY_KINDS = new Set<string>([
  "user.approved",
  "user.email_added",
  "user.email_removed",
  "doc.owner_changed",
  "space.created",
  "space.updated",
  "space.member_added",
  "space.member_removed",
  "space.invite_created",
  "space.invite_accepted",
  "proposal.accepted",
  "proposal.rejected",
  "doc.web_committed",
  "proposal.opened",
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
  /** Viewer scope — admins see everything; members are space-scoped. */
  viewer: "admin" | "member";
  /**
   * The member's resolved users-row id. Decides which spaces the member belongs
   * to, hence which docs' events they may see. Null/absent → public/unlisted
   * spaces only (fail-closed). Ignored for admins.
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
 * Space scoping (server-side, fail-closed):
 *   - admin: every event.
 *   - member: doc-scoped events ONLY for docs whose SPACE is visible to THIS
 *     member — a space they belong to OR a public/unlisted space. Joined on
 *     docs.id; admin-only kinds (user.approved) are excluded entirely; any
 *     unknown kind is treated as doc-scoped and excluded unless its doc is
 *     visible (so a future kind can't leak by default).
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
  //       surface, no space scoping, no docId.
  //   (b) doc-scoped kinds whose referenced doc lives in a space this member can
  //       see.
  // Admin-only kinds (user.approved) are excluded from both. We compute the set
  // of member-visible space ids once, then express the union as a LEFT JOIN on
  // docs with an OR predicate (a board event has no doc, so the join misses; we
  // admit it via the staff-visible branch).
  // Public/unlisted spaces (everyone signed in) ∪ spaces this member belongs to.
  // userId null → membership half empty (fail-closed to public/unlisted only).
  const openSpaceIds = (
    await db
      .select({ id: spaces.id })
      .from(spaces)
      .where(inArray(spaces.visibility, ["public", "unlisted"]))
  ).map((r) => r.id);
  const memberSpaceIds =
    opts.userId != null
      ? (
          await db
            .select({ spaceId: spaceMembers.spaceId })
            .from(spaceMembers)
            .where(eq(spaceMembers.userId, opts.userId))
        ).map((r) => r.spaceId)
      : [];
  const visibleSpaceIds = [...new Set([...openSpaceIds, ...memberSpaceIds])];

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

  // Doc-scoped branch: a referenced doc whose space is member-visible. With no
  // visible spaces this branch admits nothing.
  const docScopedBranch =
    visibleSpaceIds.length > 0
      ? sql`(${events.docId} is not null and ${inArray(docs.spaceId, visibleSpaceIds)})`
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

// ── listEventsWaiting (optional server-side long-poll) ───────────────────────

/**
 * Upper bound on a long-poll park, in seconds. Kept comfortably under the
 * ~60 s most proxies/load-balancers use for an idle-connection cutoff, so a
 * parked request always returns on its own before anything upstream kills it.
 */
export const MAX_WAIT_SECONDS = 55;

/** How often the park re-queries the DB while waiting (ms). */
const WAIT_POLL_MS = 1000;

/**
 * Clamp a requested wait to the safe integer band `[0, MAX_WAIT_SECONDS]`.
 * Non-finite / null / undefined / ≤0 → `0` (the immediate, no-wait default);
 * anything above the cap → the cap. `0` means "behave exactly like listEvents".
 */
export function clampWaitSeconds(raw: number | null | undefined): number {
  if (raw == null || !Number.isFinite(raw)) return 0;
  if (raw <= 0) return 0;
  if (raw >= MAX_WAIT_SECONDS) return MAX_WAIT_SECONDS;
  return Math.floor(raw);
}

/**
 * A sleep that resolves after `ms` OR immediately when `signal` aborts —
 * whichever comes first. Cleans up its timer + listener either way (no leak).
 */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
    signal?.addEventListener("abort", finish, { once: true });
  });
}

/**
 * `listEvents` with an OPTIONAL server-side long-poll (near-real-time dispatch,
 * outbound-only — the agent just makes a normal request that may take longer).
 *
 * Behaviour:
 *   - `waitSeconds <= 0` (the default): identical to `listEvents` — one query,
 *     return immediately (possibly empty).
 *   - `waitSeconds > 0` AND the immediate query already matches events: return
 *     those NOW (no wait) — pending events short-circuit the park.
 *   - `waitSeconds > 0` AND nothing pending: park, re-querying every
 *     `WAIT_POLL_MS`, until an event matches OR the (clamped) deadline elapses,
 *     then return (possibly empty).
 *
 * RESOURCE SAFETY — the whole point of this being safe:
 *   - Each poll is a FRESH, short `listEvents` call. Between polls we only
 *     `abortableSleep`, holding NO DB connection and NO transaction — the pool
 *     is never checked out across the wait, so a wall of parked agents can't
 *     exhaust it (they hold an HTTP slot for ≤55 s, not a DB connection).
 *   - `signal` (client disconnect, wired from `req.signal` / the MCP request's
 *     abort signal) ends the park PROMPTLY and returns whatever the last query
 *     produced (empty on a mid-wait abort) — a hung/abandoned request doesn't
 *     linger for the full timeout.
 *
 * Same return shape as `listEvents` in every case.
 */
export async function listEventsWaiting(
  opts: ListEventsOpts,
  waitSeconds: number,
  signal?: AbortSignal,
): Promise<EventRow[]> {
  // First read is unconditional: if events already match `since`, return NOW —
  // pending events never wait, exactly like the immediate path.
  let rows = await listEvents(opts);
  const wait = clampWaitSeconds(waitSeconds);
  if (rows.length > 0 || wait === 0 || signal?.aborted) return rows;

  const deadline = Date.now() + wait * 1000;
  while (!signal?.aborted && Date.now() < deadline) {
    const remaining = deadline - Date.now();
    await abortableSleep(Math.min(WAIT_POLL_MS, remaining), signal);
    if (signal?.aborted) break;
    // Fresh short query; the pool connection is released as it resolves, so the
    // upcoming sleep holds nothing.
    rows = await listEvents(opts);
    if (rows.length > 0) return rows;
  }
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
