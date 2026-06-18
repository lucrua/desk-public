import type { ShareListItem } from "@/lib/shares";
import { dateStamp, shareModeChip, type ShareModeChip } from "../tree-model";

/**
 * Pure view-model for the per-doc "Share links" panel. Kept here (not borrowed
 * from the admin dashboard's view-model) so this surface owns its own
 * presentation logic and is unit-testable without a renderer or a DB.
 *
 * Status is DERIVED from dates in one place: a share is `revoked` if revokedAt
 * is set; else `expired` if expiresAt is past; else `active`. Revoked wins over
 * expired when both are true (the human-meaningful cause of death is the revoke).
 */

export type ShareStatus = "active" | "revoked" | "expired";

/**
 * Grid template for the per-doc share-links table, shared by the header
 * (DocShareLinks, server) and every row (DocShareLinkRow, client) so the two
 * can't drift. Columns: label · shows(mode) · created · expires · last view ·
 * views · status · [action]. The trailing action column exists for admins only;
 * members get a read-only table with no action slot.
 */
export function gridTemplate(isAdmin: boolean): string {
  // Admin has two action columns: copy + revoke-or-delete
  return isAdmin
    ? "1.3fr 0.8fr 0.7fr 0.7fr 0.7fr 0.4fr 0.7fr 0.5fr 0.6fr"
    : "1.3fr 0.8fr 0.7fr 0.7fr 0.7fr 0.4fr 0.7fr";
}

export function shareStatus(s: ShareListItem, now: Date = new Date()): ShareStatus {
  if (s.revokedAt !== null) return "revoked";
  if (s.expiresAt !== null && s.expiresAt <= now) return "expired";
  return "active";
}

export type DocShareRow = {
  id: number;
  label: string;
  createdBy: string;
  created: string; // YYYY-MM-DD
  /** "never", "expired", or a YYYY-MM-DD stamp. */
  expires: string;
  status: ShareStatus;
  /** Only an active share can be revoked. */
  canRevoke: boolean;
  /** True when the admin can re-reveal/copy the link URL (token_enc present + active). */
  canCopy: boolean;
  /** "—" when never viewed, else a YYYY-MM-DD stamp. */
  lastView: string;
  neverViewed: boolean;
  viewCount: number;
  allowComments: boolean;
  /** The pinned version id, or null when the link is live (latest). */
  pinnedVersionId: number | null;
  /** Mode chip — "live" (quiet) or "pinned vN" (purple fact chip). */
  modeChip: ShareModeChip;
};

/**
 * Project one service ShareListItem into the row the panel renders. Pure.
 *
 * `versionLabelById` maps a version id → "vN" (from the doc's version rail) so a
 * pinned link's chip reads "pinned v5". Omit it (or pass {}) and a pinned chip
 * falls back to a bare "pinned".
 */
export function toDocShareRow(
  s: ShareListItem,
  now: Date = new Date(),
  versionLabelById: Record<number, string> = {},
): DocShareRow {
  const status = shareStatus(s, now);

  let expires: string;
  if (s.expiresAt === null) {
    expires = "never";
  } else if (status === "expired") {
    expires = "expired";
  } else {
    expires = dateStamp(s.expiresAt);
  }

  const neverViewed = s.lastViewedAt === null;

  return {
    id: s.id,
    label: s.label,
    createdBy: s.createdBy,
    created: dateStamp(s.createdAt),
    expires,
    status,
    canRevoke: status === "active",
    canCopy: s.canCopy,
    lastView: neverViewed ? "—" : dateStamp(s.lastViewedAt!),
    neverViewed,
    viewCount: s.viewCount,
    allowComments: s.allowComments,
    pinnedVersionId: s.pinnedVersionId,
    modeChip: shareModeChip(s.pinnedVersionId, versionLabelById),
  };
}
