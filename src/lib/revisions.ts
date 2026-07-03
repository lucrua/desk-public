import { eq, and, desc } from "drizzle-orm";
import { db } from "@/db";
import { revisions, docs, docVersions, users } from "@/db/schema";
import { getDocBySlug, type ViewerScope } from "@/lib/docs";
import { getSpaceById } from "@/lib/spaces";
import {
  webAuthorCommit,
  liveMainTip,
  type WebAuthorIdentity,
} from "@/lib/web-author";
import { emitEvent } from "@/lib/events";
import { MAX_CONTENT_CHARS, MAX_REVISION_NOTE_CHARS } from "@/lib/limits";

/**
 * Proposed-revisions service (the web-editing loop).
 *
 * A revision is a full proposed doc body queued against the version the author
 * was reading (`baseVersionId`). Staff propose; an admin reviews the unified
 * diff and accepts (→ commits the new body to the doc's file on `main` via
 * `webAuthorCommit`, and the indexer projects the new version) or rejects.
 *
 * Invariants enforced here:
 *   - the target doc must be `md` format (html docs get no editor) and visible
 *     to the author's scope (createRevision returns null otherwise);
 *   - content is capped at MAX_CONTENT_CHARS, note at MAX_REVISION_NOTE_CHARS;
 *   - accept only ever changes CONTENT — it commits to the doc's CURRENT
 *     sourcePath on `main` (title/format re-derive from the committed file via
 *     the projection), so an author can never move a doc's path/slug/title via
 *     a revision.
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
  | { ok: false; reason: "not-found" | "already-decided" | "stale" | "error" }
  | { ok: true; versionId: number; isNewVersion: boolean; staleBase: boolean };

/** Derive a web-author commit identity from a reviewer's display name. The
 * accept lands on `main` as an authoritative merge (role forced to `owner`), so
 * the handle is not used for routing — only a stable author label. */
function identityFromName(name: string): WebAuthorIdentity {
  const handle =
    (name || "reviewer")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "") || "reviewer";
  return { name: name || "Desk reviewer", email: `${handle}@desk.localhost`, handle };
}

/**
 * Accept a revision (admin OR doc-owner action). Truth = git: the revision's
 * content is committed to the doc's `(space, sourcePath)` on `main` via
 * `webAuthorCommit` (role forced to `owner` — an accept is an authoritative
 * merge, exactly like accepting a git proposal), and the synchronous reindex
 * projects the new version. No doc content is written to Postgres here — the
 * indexer owns that (the git-truth invariant).
 *
 * `by` is the accepting reviewer's display name — the commit author label and
 * the `revision.decided` actor; the reindex records it as the version's
 * `publishedBy`. The revision row retains its own authorName / authorKind for
 * proposer attribution.
 *
 * CAS: the commit builds on `main`'s live tip. If `main` moved between the read
 * and the commit, `webAuthorCommit` rejects it as `stale`; we re-read the tip
 * and retry ONCE, then surface `stale` to the reviewer (never a silent
 * overwrite).
 *
 * Stale-base detection (`staleBase`) is unchanged: true when the revision's
 * baseVersionId is no longer the doc's current version at accept time.
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

  // Resolve the doc's owning space (its slug is the repo/target of the commit).
  const space = await getSpaceById(doc.spaceId);
  if (!space) return { ok: false, reason: "error" };

  const staleBase = doc.currentVersionId !== rev.baseVersionId;
  const prevVersionId = doc.currentVersionId;
  const identity = identityFromName(by);

  // Commit the revision content to the doc's source path on `main`. CAS on the
  // live tip; on `stale`, re-read the tip and retry ONCE.
  let committed = false;
  let failReason: "stale" | "error" = "stale";
  for (let attempt = 0; attempt < 2; attempt++) {
    const baseMainTip = await liveMainTip(space.slug);
    const result = await webAuthorCommit(space.slug, {
      role: "owner",
      identity,
      writes: [{ path: doc.sourcePath, bytes: Buffer.from(rev.content, "utf8") }],
      baseMainTip,
      message: `accept revision: ${doc.sourcePath}`,
    });
    if (result.ok) {
      committed = true;
      break;
    }
    if (result.reason === "stale") {
      failReason = "stale";
      continue; // re-read the tip and retry once
    }
    // forbidden / conflict / unknown-space / error → not retryable.
    failReason = "error";
    break;
  }
  if (!committed) return { ok: false, reason: failReason };

  // The reindex has projected the commit. Re-read the doc for the new version id
  // (a no-op commit — content identical to current — dedups to the same version).
  const after = await getDocBySlug(doc.slug, { includeUnpublished: true });
  const newVersionId = after?.doc.currentVersionId ?? prevVersionId ?? 0;
  const isNewVersion = newVersionId !== prevVersionId;

  // Mark decided + emit revision.decided atomically (the doc-version write is the
  // indexer's; this only records the decision).
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
        versionId: newVersionId,
        staleBase,
      },
      actorName: by,
    });
  });

  return { ok: true, versionId: newVersionId, isNewVersion, staleBase };
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
