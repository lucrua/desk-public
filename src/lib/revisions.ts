import { eq, and, desc } from "drizzle-orm";
import { db } from "@/db";
import { revisions, docs, docVersions, users } from "@/db/schema";
import { publishDoc, getDocBySlug, type ViewerScope } from "@/lib/docs";
import { emitEvent } from "@/lib/events";
import { MAX_CONTENT_CHARS, MAX_REVISION_NOTE_CHARS } from "@/lib/limits";

/**
 * Proposed-revisions service (the web-editing loop).
 *
 * A revision is a full proposed doc body queued against the version the author
 * was reading (`baseVersionId`). Staff propose; an admin reviews the unified
 * diff and accepts (→ publishDoc creates a new immutable version) or rejects.
 *
 * Invariants enforced here:
 *   - the target doc must be `md` format (html docs get no editor) and visible
 *     to the author's scope (createRevision returns null otherwise);
 *   - content is capped at MAX_CONTENT_CHARS, note at MAX_REVISION_NOTE_CHARS;
 *   - accept only ever changes CONTENT — it re-publishes through publishDoc with
 *     the doc's CURRENT title / sourcePath / audience / format unchanged, so the
 *     existing publish validations (audience exists, etc.) still apply and an
 *     author can never move a doc's slug/audience/title via a revision.
 *   - a revision can be decided (accepted/rejected) at most once.
 *
 * content / authorName / authorKind / note are DATA — always rendered through
 * the escaped Markdown / diff text nodes downstream, never a raw-HTML sink.
 */

export type RevisionRow = typeof revisions.$inferSelect;

export type RevisionStatus = "open" | "accepted" | "rejected";

export type CreateRevisionInput = {
  slug: string;
  authorName: string;
  authorKind: string; // 'admin' | 'member'
  /** The author's scope — md+visible check uses this (uniform null on miss). */
  scope: ViewerScope;
  content: string;
  note?: string;
};

/**
 * Create a proposed revision. Returns null when:
 *   - the doc is missing or out of the author's scope (uniform — no leak);
 *   - the doc is not markdown (html docs get no editor);
 *   - the doc has no published version to base the proposal on;
 *   - content is empty (after trim) or over MAX_CONTENT_CHARS;
 *   - the note is over MAX_REVISION_NOTE_CHARS;
 *   - the author name is empty.
 * The base version is always the doc's CURRENT version at propose time.
 */
export async function createRevision(
  input: CreateRevisionInput,
): Promise<RevisionRow | null> {
  const authorName = input.authorName.trim();
  if (authorName.length === 0) return null;

  // Cap checks before the DB round-trip.
  if (input.content.length === 0) return null;
  if (input.content.length > MAX_CONTENT_CHARS) return null;
  if (input.note != null && input.note.length > MAX_REVISION_NOTE_CHARS) return null;

  // Scope + existence + format gate. getDocBySlug returns null for a member on a
  // hidden audience exactly like a missing doc (no existence signal).
  const result = await getDocBySlug(input.slug, {
    includeUnpublished: input.scope.viewer === "admin",
    scope: input.scope,
  });
  if (!result) return null;
  if (result.doc.format !== "md") return null;
  if (result.doc.currentVersionId === null || result.version === null) return null;

  const note = input.note != null && input.note.trim().length > 0 ? input.note.trim() : null;

  // Insert + event in one transaction so a proposed revision and its
  // revision.proposed event are written atomically.
  return db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(revisions)
      .values({
        docId: result.doc.id,
        baseVersionId: result.version!.id,
        content: input.content,
        authorName,
        authorKind: input.authorKind,
        note,
      })
      .returning();

    if (!inserted) return null;

    await emitEvent(tx, {
      kind: "revision.proposed",
      docId: result.doc.id,
      payload: {
        revisionId: inserted.id,
        slug: result.doc.slug,
        baseVersionId: inserted.baseVersionId,
        authorKind: inserted.authorKind,
      },
      actorName: authorName,
    });

    return inserted;
  });
}

/**
 * List a doc's revisions, newest-first. Optional `status` filter ('open' |
 * 'accepted' | 'rejected').
 */
export async function listRevisions(
  docId: number,
  opts?: { status?: RevisionStatus },
): Promise<RevisionRow[]> {
  const where = opts?.status
    ? and(eq(revisions.docId, docId), eq(revisions.status, opts.status))
    : eq(revisions.docId, docId);

  return db
    .select()
    .from(revisions)
    .where(where)
    .orderBy(desc(revisions.createdAt), desc(revisions.id));
}

/** Fetch a single revision by id (null if absent). */
export async function getRevision(id: number): Promise<RevisionRow | null> {
  const rows = await db
    .select()
    .from(revisions)
    .where(eq(revisions.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export type AcceptResult =
  | { ok: false; reason: "not-found" | "already-decided" }
  | { ok: true; versionId: number; isNewVersion: boolean; staleBase: boolean };

/**
 * Accept a revision (admin action). Publishes the revision's content as a new
 * version via publishDoc — passing the doc's CURRENT title / sourcePath /
 * audience / format through unchanged (only the content differs), so the
 * existing publish validations apply and the proposal can't move metadata.
 *
 * `publishedBy` is the accepting admin's display name (`by`). The revision row
 * retains its own authorName / authorKind for attribution.
 *
 * Stale-base detection: `staleBase` is true when the revision's baseVersionId is
 * no longer the doc's current version at accept time (the doc moved on since the
 * proposal). The accept is still allowed — the admin saw the warning + the diff
 * against current in the UI — but the flag is surfaced so callers can log/note.
 */
export async function acceptRevision(
  id: number,
  { by }: { by: string },
): Promise<AcceptResult> {
  const rev = await getRevision(id);
  if (!rev) return { ok: false, reason: "not-found" };
  if (rev.status !== "open") return { ok: false, reason: "already-decided" };

  // Load the doc to pull its CURRENT metadata + detect a stale base.
  const docRows = await db
    .select()
    .from(docs)
    .where(eq(docs.id, rev.docId))
    .limit(1);
  const doc = docRows[0];
  if (!doc) return { ok: false, reason: "not-found" };

  const staleBase = doc.currentVersionId !== rev.baseVersionId;

  // publishDoc opens its own transaction (and emits doc.published). Accept never
  // passes a base_version_id, so it cannot conflict — but adapt to the result
  // shape defensively.
  const published = await publishDoc({
    slug: doc.slug,
    title: doc.title,
    sourcePath: doc.sourcePath,
    audience: doc.audience,
    format: doc.format,
    content: rev.content,
    by,
  });
  if (!published.ok) {
    // Unreachable in practice (no base check on accept); treat as a no-op.
    return { ok: false, reason: "already-decided" };
  }

  // Mark decided + emit revision.decided atomically.
  await db.transaction(async (tx) => {
    await tx
      .update(revisions)
      .set({ status: "accepted", decidedAt: new Date() })
      .where(eq(revisions.id, id));
    await emitEvent(tx, {
      kind: "revision.decided",
      docId: rev.docId,
      payload: {
        revisionId: id,
        slug: doc.slug,
        decision: "accepted",
        versionId: published.versionId,
        staleBase,
      },
      actorName: by,
    });
  });

  return {
    ok: true,
    versionId: published.versionId,
    isNewVersion: published.isNewVersion,
    staleBase,
  };
}

export type RejectResult =
  | { ok: false; reason: "not-found" | "already-decided" }
  | { ok: true };

/** Reject a revision (admin action). A revision can be decided only once. */
export async function rejectRevision(
  id: number,
  opts: { by?: string } = {},
): Promise<RejectResult> {
  const rev = await getRevision(id);
  if (!rev) return { ok: false, reason: "not-found" };
  if (rev.status !== "open") return { ok: false, reason: "already-decided" };

  const [doc] = await db
    .select({ slug: docs.slug })
    .from(docs)
    .where(eq(docs.id, rev.docId))
    .limit(1);

  await db.transaction(async (tx) => {
    await tx
      .update(revisions)
      .set({ status: "rejected", decidedAt: new Date() })
      .where(eq(revisions.id, id));
    await emitEvent(tx, {
      kind: "revision.decided",
      docId: rev.docId,
      payload: {
        revisionId: id,
        slug: doc?.slug,
        decision: "rejected",
      },
      actorName: opts.by ?? "system",
    });
  });

  return { ok: true };
}

/**
 * Count open revisions for a doc — feeds the "N proposed changes" pill. A single
 * scalar query.
 */
export async function openRevisionCount(docId: number): Promise<number> {
  const rows = await db
    .select({ id: revisions.id })
    .from(revisions)
    .where(and(eq(revisions.docId, docId), eq(revisions.status, "open")));
  return rows.length;
}

/**
 * An open revision enriched with its doc's context — for the central approval
 * queue. Each row is a revisions row PLUS the doc's slug, title, and ownerUserId.
 */
export type OpenRevisionQueueItem = RevisionRow & {
  docSlug: string;
  docTitle: string;
  docOwnerUserId: number | null;
};

/**
 * List ALL open revisions across every doc, newest-first. Joins docs to carry
 * the doc slug + title + owner. Used by the central approval queue.
 *
 * Optional `ownerUserId` — when provided, restricts to revisions on docs whose
 * owner_user_id matches (for the owner-scoped queue view). Omit for the full
 * admin view.
 */
export async function listOpenRevisions(opts?: {
  ownerUserId?: number;
}): Promise<OpenRevisionQueueItem[]> {
  const rows = await db
    .select({
      // All revisions columns
      id: revisions.id,
      docId: revisions.docId,
      baseVersionId: revisions.baseVersionId,
      content: revisions.content,
      authorName: revisions.authorName,
      authorKind: revisions.authorKind,
      note: revisions.note,
      status: revisions.status,
      createdAt: revisions.createdAt,
      decidedAt: revisions.decidedAt,
      // Doc context
      docSlug: docs.slug,
      docTitle: docs.title,
      docOwnerUserId: docs.ownerUserId,
    })
    .from(revisions)
    .innerJoin(docs, eq(docs.id, revisions.docId))
    .where(
      opts?.ownerUserId !== undefined
        ? and(eq(revisions.status, "open"), eq(docs.ownerUserId, opts.ownerUserId))
        : eq(revisions.status, "open"),
    )
    .orderBy(desc(revisions.createdAt), desc(revisions.id));

  return rows.map((r) => ({
    id: r.id,
    docId: r.docId,
    baseVersionId: r.baseVersionId,
    content: r.content,
    authorName: r.authorName,
    authorKind: r.authorKind,
    note: r.note,
    status: r.status as "open",
    createdAt: r.createdAt,
    decidedAt: r.decidedAt,
    docSlug: r.docSlug,
    docTitle: r.docTitle,
    docOwnerUserId: r.docOwnerUserId ?? null,
  }));
}

/** The base version content for a revision (for the unified diff vs base). */
export async function getRevisionBaseContent(rev: RevisionRow): Promise<string | null> {
  const rows = await db
    .select({ content: docVersions.content })
    .from(docVersions)
    .where(eq(docVersions.id, rev.baseVersionId))
    .limit(1);
  return rows[0]?.content ?? null;
}
