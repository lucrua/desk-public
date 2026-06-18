/**
 * Pure view-model for the comments thread. Both the operator (/docs/[slug]) and
 * partner (/s/[token]) surfaces share the ordering + chip-mapping logic here so
 * the islands stay presentational and this is unit-testable without a renderer.
 *
 * The DTO is the JSON shape the comment APIs return (createdAt is an ISO string
 * over the wire). authorName / authorKind are DATA — the view-model never
 * interprets authorName as markup; islands render both as plain text.
 */

export type CommentDTO = {
  id: number;
  authorName: string;
  authorKind: string; // 'admin' | 'member' | 'link:<label>'
  body: string;
  createdAt: string; // ISO
  /** Present on the staff (full-thread) projection; absent on the public one. */
  resolvedAt?: string | null;
};

export type AuthorChip = {
  /** Plain-text label shown in the chip. */
  label: string;
  /** Coarse kind for styling: link visitors get the amber treatment. */
  kind: "admin" | "member" | "link";
};

/**
 * Map an authorKind string to a display chip. `link:<label>` → kind "link" with
 * the embedded label (falls back to the comment's authorName if the kind has no
 * label suffix). Unknown kinds degrade to "member" styling.
 */
export function authorChip(c: Pick<CommentDTO, "authorKind" | "authorName">): AuthorChip {
  if (c.authorKind === "admin") return { label: c.authorName, kind: "admin" };
  if (c.authorKind === "member") return { label: c.authorName, kind: "member" };
  if (c.authorKind.startsWith("link:")) {
    const embedded = c.authorKind.slice("link:".length);
    return { label: embedded || c.authorName, kind: "link" };
  }
  return { label: c.authorName, kind: "member" };
}

/** YYYY-MM-DD HH:MM in UTC (stable, no locale drift). */
export function commentStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 16).replace("T", " ");
}

export type GroupedThread = {
  open: CommentDTO[];
  resolved: CommentDTO[];
  resolvedCount: number;
};

/**
 * Split a thread (already oldest-first from the API) into open vs resolved,
 * preserving order within each group. A comment is resolved iff resolvedAt is a
 * non-null value. The public projection omits resolvedAt entirely → everything
 * is treated as open (which is correct: the public GET only returns unresolved).
 */
export function groupThread(comments: CommentDTO[]): GroupedThread {
  const open: CommentDTO[] = [];
  const resolved: CommentDTO[] = [];
  for (const c of comments) {
    if (c.resolvedAt != null) resolved.push(c);
    else open.push(c);
  }
  return { open, resolved, resolvedCount: resolved.length };
}
