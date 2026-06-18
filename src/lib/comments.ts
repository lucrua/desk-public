import { eq, and, asc, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { comments, docs } from "@/db/schema";
import { emitEvent } from "@/lib/events";
import { MAX_COMMENT_CHARS } from "@/lib/limits";

/**
 * Comments service.
 *
 * Comments belong to a doc + the doc version they were made against. Staff post
 * from the hub; share-link visitors post from the public /s/[token] surface
 * (shareId set, authorKind 'link:<label>'). Bodies are markdown, trimmed, and
 * capped at MAX_COMMENT_CHARS; they are ALWAYS rendered through the escaped
 * Markdown component downstream (never a raw-HTML sink). authorName / authorKind
 * are data and must be rendered as plain text only.
 */

export type CommentRow = typeof comments.$inferSelect;

export type AuthorKind = "admin" | "member" | `link:${string}`;

export type AddCommentInput = {
  docId: number;
  versionId: number;
  /** Set only when the comment was posted via a share link. */
  shareId?: number;
  authorName: string;
  authorKind: string;
  body: string;
};

/**
 * List a doc's comments, oldest-first (chronological reading order). By default
 * resolved comments are excluded; pass `includeResolved` to get the full thread
 * (staff pages show all; the public share page shows only unresolved).
 */
export async function listComments(
  docId: number,
  opts?: { includeResolved?: boolean },
): Promise<CommentRow[]> {
  const where = opts?.includeResolved
    ? eq(comments.docId, docId)
    : and(eq(comments.docId, docId), isNull(comments.resolvedAt));

  return db
    .select()
    .from(comments)
    .where(where)
    .orderBy(asc(comments.createdAt), asc(comments.id));
}

/**
 * Add a comment. Body is trimmed; an empty (after trim) or oversize body is
 * rejected with `null` (the caller maps that to a 4xx / tool error). Returns the
 * inserted row on success.
 */
export async function addComment(input: AddCommentInput): Promise<CommentRow | null> {
  const body = input.body.trim();
  if (body.length === 0) return null;
  if (body.length > MAX_COMMENT_CHARS) return null;

  const authorName = input.authorName.trim();
  if (authorName.length === 0) return null;

  // Insert + event in one transaction so the comment and its comment.added
  // event commit together (a rolled-back insert emits nothing).
  return db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(comments)
      .values({
        docId: input.docId,
        versionId: input.versionId,
        ...(input.shareId != null ? { shareId: input.shareId } : {}),
        authorName,
        authorKind: input.authorKind,
        body,
      })
      .returning();

    if (!inserted) return null;

    await emitEvent(tx, {
      kind: "comment.added",
      docId: input.docId,
      payload: {
        commentId: inserted.id,
        docId: input.docId,
        versionId: input.versionId,
        authorKind: inserted.authorKind,
        // Whether the comment came via a share link (boolean only — never the
        // share token or the comment body).
        viaShare: input.shareId != null,
      },
      actorName: authorName,
    });

    return inserted;
  });
}

/**
 * Mark a comment resolved (admin action). Returns true if a row was updated.
 * Idempotent-ish: re-resolving an already-resolved comment still returns true
 * (the row exists) but does not move the timestamp.
 */
export async function resolveComment(id: number): Promise<boolean> {
  const existing = await db
    .select({ id: comments.id, resolvedAt: comments.resolvedAt })
    .from(comments)
    .where(eq(comments.id, id))
    .limit(1);

  if (existing.length === 0) return false;
  if (existing[0].resolvedAt !== null) return true;

  await db
    .update(comments)
    .set({ resolvedAt: new Date() })
    .where(eq(comments.id, id));

  return true;
}

/**
 * Hard-delete a comment (admin action). Returns true if a row was removed.
 */
export async function deleteComment(id: number): Promise<boolean> {
  const removed = await db
    .delete(comments)
    .where(eq(comments.id, id))
    .returning({ id: comments.id });

  return removed.length > 0;
}

/**
 * Count unresolved comments per doc id, for the docs-list badge. Returns a Map
 * keyed by docId; docs with zero unresolved comments are absent from the map.
 * One grouped query (no N+1).
 */
export async function unresolvedCommentCounts(): Promise<Map<number, number>> {
  const rows = await db
    .select({
      docId: comments.docId,
      count: sql<number>`cast(count(*) as int)`,
    })
    .from(comments)
    .where(isNull(comments.resolvedAt))
    .groupBy(comments.docId);

  const map = new Map<number, number>();
  for (const r of rows) map.set(r.docId, r.count);
  return map;
}

/**
 * Resolve a slug → doc id (lightweight helper for the comment routes, which
 * already audience-gate via getDocBySlug but need the id to query comments).
 */
export async function docIdForSlug(slug: string): Promise<number | null> {
  const rows = await db
    .select({ id: docs.id })
    .from(docs)
    .where(eq(docs.slug, slug))
    .limit(1);
  return rows[0]?.id ?? null;
}
