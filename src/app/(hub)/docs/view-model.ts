import type { VersionListItem } from "@/lib/docs";
import type { ShareListItem } from "@/lib/shares";
import type { FolderShareRow } from "./FolderSharesPanel";
import { dateStamp } from "./tree-model";

/**
 * View-model helpers for the docs surfaces (server side). Pages stay thin and
 * delegate formatting / ordering decisions here so the logic is unit-testable
 * without a React renderer or a DB.
 *
 * The PURE, client-safe helpers (snippet split, folder tree, search flatten,
 * path-picker suggestions, share-mode chip) live in `./tree-model` — a module
 * with no DB coupling — and are RE-EXPORTED here so existing server imports and
 * tests that reference `./view-model` keep working unchanged. Client components
 * (DocsTree, PathPicker) import from `./tree-model` directly to avoid pulling
 * the DB layer (`@/lib/docs`, via the `canSeeAudience` re-export below) into the
 * browser bundle.
 */

export {
  // snippet
  splitSnippet,
  snippetToMarkdown,
  type SnippetRun,
  // legacy flat grouping
  groupDocsByPath,
  type DocPathGroup,
  // round-2 folder tree
  deriveFolders,
  buildDocTree,
  flattenSearch,
  pathContextLabel,
  type TreeRow,
  type TreeFolderRow,
  type TreeDocRow,
  // path picker
  pathSuggestions,
  moveCtaLabel,
  type PathSuggestion,
  // share-mode chip
  shareModeChip,
  railVersionShort,
  type ShareModeChip,
  // stamps
  shortHash,
} from "./tree-model";

// dateStamp is imported above for internal use in buildVersionRail; re-export it
// for server callers (page.tsx) that import it from ./view-model.
export { dateStamp };

/**
 * Audience visibility check (DB-driven, async).
 *
 * Re-exported from the service layer (src/lib/docs.ts) — single source of
 * truth. Pages import from here; internally the service uses it directly.
 *
 * Admins see every doc. Members see only docs whose audience key is marked
 * `member_visible=1` in the `audiences` table (admin-configurable).
 */
export { canSeeAudience } from "@/lib/docs";

export type VersionRailItem = {
  id: number;
  /** "v4 · current" for the newest, "v3", "v2"… below it. */
  label: string;
  /** Display date stamp. */
  date: string;
  publisher: string;
  isCurrent: boolean;
  /** A version is diffable iff it has a predecessor to compare against. */
  diffable: boolean;
};

/**
 * Build the version rail view-model from the service's version list.
 *
 * `listVersions` returns versions newest-first. The newest is the current one
 * and carries the highest vN. The oldest (last) is v1 and has no predecessor,
 * so it is not diffable. Every other version diffs against the one published
 * immediately before it (its successor in the newest-first array).
 */
export function buildVersionRail(
  versions: VersionListItem[],
): VersionRailItem[] {
  const total = versions.length;
  return versions.map((v, idx) => {
    // newest-first: index 0 → vTotal, last index → v1
    const vNum = total - idx;
    const isCurrent = idx === 0;
    // diffable when there is an older version after it in the list.
    const diffable = idx < total - 1;
    return {
      id: v.id,
      label: isCurrent ? `v${vNum} · current` : `v${vNum}`,
      date: dateStamp(v.publishedAt),
      publisher: v.publishedBy,
      isCurrent,
      diffable,
    };
  });
}

/**
 * Given the newest-first version list and a selected versionId, find the id of
 * the version published immediately before it (its predecessor). Returns null
 * if the selection is unknown or is the very first version (nothing to diff
 * against).
 */
export function predecessorVersionId(
  versions: VersionListItem[],
  versionId: number,
): number | null {
  const idx = versions.findIndex((v) => v.id === versionId);
  if (idx === -1) return null;
  // newest-first → the predecessor sits at the NEXT index (older).
  const prev = versions[idx + 1];
  return prev ? prev.id : null;
}

/**
 * Project the directory shares out of a full `listShares()` result into the
 * rows the admin "Folder shares" panel renders. Filters to mode==="directory",
 * derives the active/revoked/expired status + display stamps, newest-first.
 * Pure (takes an explicit `now` for deterministic tests).
 */
export function toFolderShareRows(
  shares: ShareListItem[],
  now: Date = new Date(),
): FolderShareRow[] {
  return shares
    .filter((s) => s.mode === "directory")
    .map((s) => {
      const revoked = s.revokedAt !== null;
      const expired = s.expiresAt !== null && s.expiresAt <= now;
      const status: FolderShareRow["status"] = revoked
        ? "revoked"
        : expired
          ? "expired"
          : "active";
      const expires =
        s.expiresAt === null ? "never" : expired ? "expired" : dateStamp(s.expiresAt);
      return {
        id: s.id,
        label: s.label,
        pathPrefix: s.pathPrefix ?? "",
        status,
        created: dateStamp(s.createdAt),
        expires,
        lastView: s.lastViewedAt === null ? "—" : dateStamp(s.lastViewedAt),
        viewCount: s.viewCount,
        allowComments: s.allowComments,
        canRevoke: !revoked,
        canCopy: s.canCopy,
      };
    })
    .sort((a, b) => b.id - a.id);
}

/** Parse the optional `?diff=` search param into a version id or null. */
export function parseDiffParam(raw: string | string[] | undefined): number | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (v === undefined) return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}
