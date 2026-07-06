/**
 * Pure view-model for the proposed-revisions surface on /docs/[slug]. Keeps the
 * page + islands thin and presentational; ordering / grouping / label logic is
 * unit-testable here without a renderer or a DB.
 *
 * The DTO is the JSON shape the revisions API returns (timestamps are ISO
 * strings over the wire). content / authorName / note are DATA — the view-model
 * never treats authorName/note as markup; islands render them as plain text and
 * the body only ever flows through the escaped Markdown / diff text nodes.
 */

export type RevisionStatus = "open" | "accepted" | "rejected";

export type RevisionDTO = {
  id: number;
  baseVersionId: number;
  authorName: string;
  authorKind: string; // 'admin' | 'member' | 'link:<label>' (share suggestion)
  note: string | null;
  status: RevisionStatus;
  createdAt: string; // ISO
  decidedAt: string | null; // ISO | null
  /** Set on a suggestion that arrived through a share link ("link:<label>"),
   *  null for a staff-proposed revision. Surfaced as a "via share <label>" badge. */
  proposerLabel: string | null;
};

export type GroupedRevisions = {
  open: RevisionDTO[];
  decided: RevisionDTO[];
  openCount: number;
  decidedCount: number;
};

/**
 * Split revisions (already newest-first from the API) into open vs decided
 * (accepted | rejected), preserving order within each group.
 */
export function groupRevisions(revisions: RevisionDTO[]): GroupedRevisions {
  const open: RevisionDTO[] = [];
  const decided: RevisionDTO[] = [];
  for (const r of revisions) {
    if (r.status === "open") open.push(r);
    else decided.push(r);
  }
  return { open, decided, openCount: open.length, decidedCount: decided.length };
}

/** Pill label for the open-revision count, or null when there are none. */
export function proposedChangesLabel(openCount: number): string | null {
  if (openCount <= 0) return null;
  return `${openCount} proposed change${openCount === 1 ? "" : "s"}`;
}

/** YYYY-MM-DD HH:MM in UTC (stable, no locale drift). */
export function revisionStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 16).replace("T", " ");
}

export type AuthorChip = {
  label: string;
  kind: "admin" | "member";
};

/** Display chip for a revision author. Unknown kinds degrade to "member". */
export function revisionAuthorChip(
  r: Pick<RevisionDTO, "authorKind" | "authorName">,
): AuthorChip {
  return { label: r.authorName, kind: r.authorKind === "admin" ? "admin" : "member" };
}

/**
 * Is a revision's base version stale relative to the doc's current version?
 * True when the doc moved on (a new version was published) since the proposal.
 * When stale, the admin review screen also shows the diff against current.
 */
export function isStaleBase(rev: Pick<RevisionDTO, "baseVersionId">, currentVersionId: number): boolean {
  return rev.baseVersionId !== currentVersionId;
}

/**
 * Display label for the "via share <label>" badge on a share-originated
 * suggestion. `proposerLabel` is stored as "link:<label>" (the forced share
 * identity); this strips the "link:" prefix for display. Returns null when the
 * revision has no proposer label (a staff proposal) → the badge is not rendered.
 */
export function shareBadgeLabel(proposerLabel: string | null | undefined): string | null {
  if (!proposerLabel) return null;
  const stripped = proposerLabel.startsWith("link:")
    ? proposerLabel.slice("link:".length)
    : proposerLabel;
  return stripped.length > 0 ? stripped : null;
}

/** Human status label for a decided revision. */
export function statusLabel(status: RevisionStatus): string {
  switch (status) {
    case "accepted":
      return "accepted";
    case "rejected":
      return "rejected";
    default:
      return "open";
  }
}

/**
 * Why "Accept" is unavailable for an open revision, or null when it's fine to
 * show. A `mirrored` space's canon is GitHub (convergence fix-pass, D-C3) —
 * `acceptRevision` refuses server-side there (reason `"mirrored"`, the
 * `MIRRORED_WRITE_REFUSED` message in `web-author.ts`), because committing on
 * Desk would drift from the space's real source. Reject is unaffected (it only
 * marks the DB row decided; no commit) — only Accept is gated. Surfaced as a
 * small note next to the Accept button instead of a failed request the reviewer
 * has to interpret.
 */
export function acceptUnavailableReason(isMirrored: boolean): string | null {
  if (!isMirrored) return null;
  return "This space mirrors from GitHub — accept is unavailable here. Apply the change upstream on GitHub instead.";
}
