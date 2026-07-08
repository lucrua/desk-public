import type { ShareListItem } from "@/lib/shares";
import type { DocListItem } from "@/lib/docs";
import type { UserListItem } from "@/lib/users";
import type { AccessRequestListItem } from "@/lib/access-requests";
import type { Principal } from "@/lib/auth";
import { dateStamp } from "../docs/view-model";

/**
 * Pure view-model helpers for the admin dashboard. The page stays thin and
 * delegates formatting / ordering here so the logic is unit-testable without a
 * React renderer or a DB.
 */

/** A share that is neither revoked nor expired is "active". */
export function isShareActive(s: ShareListItem, now: Date = new Date()): boolean {
  if (s.revokedAt !== null) return false;
  if (s.expiresAt !== null && s.expiresAt <= now) return false;
  return true;
}

export type ShareRowView = {
  id: number;
  label: string;
  /** "doc" or "directory" (folder) share. */
  mode: "doc" | "directory";
  /** Doc slug for a doc share; null for a directory share. */
  docSlug: string | null;
  /** A human chip: "doc:<slug>" or "folder · <prefix>/". */
  scope: string;
  /** "never", "expired", or a YYYY-MM-DD stamp. */
  expires: string;
  /** true when the expiry is within `soonDays` and not yet past. */
  expiringSoon: boolean;
  /** "—" when never viewed, else a YYYY-MM-DD stamp. */
  lastView: string;
  neverViewed: boolean;
  viewCount: number;
  isRevoked: boolean;
  canRevoke: boolean;
  /** Whether link visitors may comment on this share (per-share flag). */
  allowComments: boolean;
};

/**
 * Project a service ShareListItem into the row the table renders. Pure: takes
 * an explicit `now` for deterministic tests.
 */
export function toShareRow(
  s: ShareListItem,
  now: Date = new Date(),
  soonDays = 14,
): ShareRowView {
  const isRevoked = s.revokedAt !== null;
  const expired = s.expiresAt !== null && s.expiresAt <= now;

  let expires: string;
  if (s.expiresAt === null) {
    expires = "never";
  } else if (expired) {
    expires = "expired";
  } else {
    expires = dateStamp(s.expiresAt);
  }

  const soonMs = soonDays * 24 * 60 * 60 * 1000;
  const expiringSoon =
    s.expiresAt !== null &&
    !expired &&
    s.expiresAt.getTime() - now.getTime() <= soonMs;

  const neverViewed = s.lastViewedAt === null;

  const scope =
    s.mode === "directory"
      ? `folder · ${s.pathPrefix ?? ""}/`
      : `doc:${s.docSlug}`;

  return {
    id: s.id,
    label: s.label,
    mode: s.mode,
    docSlug: s.docSlug,
    scope,
    expires,
    expiringSoon,
    lastView: neverViewed ? "—" : dateStamp(s.lastViewedAt!),
    neverViewed,
    viewCount: s.viewCount,
    isRevoked,
    canRevoke: !isRevoked,
    allowComments: s.allowComments,
  };
}

// ── users ──────────────────────────────────────────────────────────────────

export type UserRowView = {
  id: number;
  displayName: string;
  email: string | null;
  tokenName: string | null;
  /**
   * The stable, unique, URL-safe owner handle (Owner-namespace S1). Null only
   * transiently for a row created before the boot backfill; admin-editable.
   */
  handle: string | null;
  /**
   * The user's role — read from the stored `users.role` column (multi-admin
   * model v2). The `adminEmail` parameter to `toUserRow` is retained for
   * call-site compatibility but is no longer used for role derivation.
   */
  role: "admin" | "member";
  active: boolean;
  created: string;
  isSelf: boolean;
  /**
   * All of the user's emails (multi-email) — rendered as chips with an add/remove
   * control. `primary` flags the users.email display address. A token-only user
   * has none.
   */
  emails: Array<{ email: string; primary: boolean }>;
  /**
   * True when this row can have its role toggled (only admins can toggle; false
   * for the viewing principal's own row when they are the last admin, to prevent
   * accidental self-demotion in the UI without a guard message).
   */
  canToggleRole: boolean;
};

/**
 * Project a service UserListItem into the row the Users table renders. `isSelf`
 * marks the signed-in admin's own row (matched by email or tokenName) so the UI
 * can disable self-deactivation — the same identity match the API enforces.
 *
 * The role chip is read from the stored `u.role` column (multi-admin model v2).
 * `adminEmail` is accepted for call-site compatibility but is no longer used for
 * role derivation — ADMIN_EMAIL is no longer the source of truth.
 *
 * `totalActiveAdmins` is used to compute `canToggleRole`: the last active admin
 * cannot demote themselves (guard message shown inline). Defaults to 2 (safe
 * assumption for call sites that don't pass it — toggle is allowed; the route
 * enforces the real guard).
 */
export function toUserRow(
  u: UserListItem,
  principal: Principal,
  _adminEmail: string | undefined, // kept for call-site compat — no longer used
  emails: Array<{ email: string; primary: boolean }> = [],
  totalActiveAdmins = 2,
): UserRowView {
  // The user's full email set (multi-email). Fall back to the primary when no
  // explicit set is passed (older call sites / tests) so behaviour is unchanged.
  const allEmails =
    emails.length > 0
      ? emails.map((e) => e.email.toLowerCase())
      : u.email != null
        ? [u.email.toLowerCase()]
        : [];

  // isSelf: match the principal's emails (ALL of them — a login via a secondary
  // address is still "me") OR tokenName against this row.
  const pEmails =
    principal.kind !== "anonymous"
      ? (principal.emails ?? (principal.email ? [principal.email] : [])).map((e) =>
          e.trim().toLowerCase(),
        )
      : [];
  const pToken = principal.kind !== "anonymous" ? principal.tokenName?.trim() : undefined;

  const emailMatch = allEmails.some((e) => pEmails.includes(e));
  const tokenMatch = pToken != null && u.tokenName != null && u.tokenName === pToken;

  const isSelf = emailMatch || tokenMatch;

  // Role is the stored column value (source of truth since admin model v2).
  const isAdmin = u.role === "admin";

  // canToggleRole: false only when this is the last active admin AND it's the
  // viewing admin's own row — prevents accidental self-lockout in the UI. The
  // server enforces the real guard; this flag just controls whether the toggle
  // is rendered as disabled with a message.
  const isLastAdmin = isAdmin && u.active === 1 && totalActiveAdmins <= 1;
  const canToggleRole = !(isSelf && isLastAdmin);

  return {
    id: u.id,
    displayName: u.displayName,
    email: u.email,
    tokenName: u.tokenName,
    handle: u.handle,
    role: isAdmin ? "admin" : "member",
    active: u.active === 1,
    created: dateStamp(u.createdAt),
    isSelf,
    emails: emails.length > 0
      ? emails
      : u.email != null
        ? [{ email: u.email, primary: true }]
        : [],
    canToggleRole,
  };
}

// ── access requests ──────────────────────────────────────────────────────────

export type AccessRequestRowView = {
  id: number;
  email: string;
  firstSeen: string; // YYYY-MM-DD stamp
  lastSeen: string; // YYYY-MM-DD stamp
  hits: number;
  /**
   * Default display name the Approve form prefills — the capitalized email
   * local-part (the admin can edit before approving). Mirrors the auth layer's
   * displayNameFromEmail / the service's defaultDisplayName.
   */
  defaultDisplayName: string;
};

/**
 * Project a service AccessRequestListItem into the row the admin "Access
 * requests" section renders. Pure: date formatting + the prefilled default
 * name, so the island stays presentational and the logic is unit-testable.
 */
export function toAccessRequestRow(r: AccessRequestListItem): AccessRequestRowView {
  const local = r.email.split("@")[0] ?? r.email;
  const defaultDisplayName =
    local.length === 0 ? r.email : local.charAt(0).toUpperCase() + local.slice(1);
  return {
    id: r.id,
    email: r.email,
    firstSeen: dateStamp(r.firstSeenAt),
    lastSeen: dateStamp(r.lastSeenAt),
    hits: r.hits,
    defaultDisplayName,
  };
}

export type AdminStats = {
  publishedDocs: number;
  activeShares: number;
  recentViews: number;
};

/**
 * Compute the three stat-tile numbers. `publishedDocs` counts docs that are not
 * unpublished; `activeShares` counts non-revoked / non-expired shares;
 * `recentViews` is supplied by the caller (countRecentViews service fn).
 */
export function computeStats(
  docs: DocListItem[],
  shares: ShareListItem[],
  recentViews: number,
  now: Date = new Date(),
): AdminStats {
  return {
    publishedDocs: docs.filter((d) => d.unpublishedAt === null).length,
    activeShares: shares.filter((s) => isShareActive(s, now)).length,
    recentViews,
  };
}
