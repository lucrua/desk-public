/**
 * Permission helpers for doc ownership + publish gates.
 *
 * All helpers are pure (no DB calls) — callers have already loaded the doc
 * row and the resolved principal (with userId). These are the single source of
 * truth for the publish/decide/queue permission boundary. Import and call at
 * EVERY enforcement point (REST routes + MCP tools) so the check is consistent.
 *
 * Permission model:
 *   - Create NEW doc (no existing row): admin only.
 *   - Publish new version to EXISTING doc: admin OR the doc's owner.
 *   - Decide (accept/reject) a revision: admin OR the doc's owner.
 *   - Set doc owner: admin only.
 *   - See an item in the approval queue: admin (all) OR owner (own docs only).
 */

import type { Principal } from "@/lib/auth";

/** Minimal doc shape needed for ownership checks (subset of the full row). */
export type OwnableDoc = {
  ownerUserId: number | null | undefined;
};

/**
 * Can this principal publish a new version to an EXISTING doc?
 *
 * `true` when:
 *   - principal is admin, OR
 *   - principal.userId is set AND equals doc.ownerUserId.
 *
 * Creating a brand-new doc (slug absent) is NOT governed by this helper —
 * that is admin-only in all call sites.
 */
export function canPublishVersion(
  principal: Principal,
  doc: OwnableDoc,
): boolean {
  if (principal.kind === "admin") return true;
  if (principal.kind !== "member") return false;
  return (
    principal.userId != null &&
    doc.ownerUserId != null &&
    principal.userId === doc.ownerUserId
  );
}

/**
 * Can this principal decide (accept or reject) a revision on a doc?
 *
 * `true` when:
 *   - principal is admin, OR
 *   - principal is the doc's owner (same userId check as canPublishVersion).
 */
export function canDecideRevision(
  principal: Principal,
  doc: OwnableDoc,
): boolean {
  return canPublishVersion(principal, doc);
}

/**
 * Can this principal set the owner of a doc?
 *
 * Admin only — always.
 */
export function canSetOwner(principal: Principal): boolean {
  return principal.kind === "admin";
}

/**
 * Can this principal see an item in the central approval queue?
 *
 * Admin sees all items. An owner sees only items on their docs.
 */
export function canSeeApprovalQueueItem(
  principal: Principal,
  doc: OwnableDoc,
): boolean {
  if (principal.kind === "admin") return true;
  if (principal.kind !== "member") return false;
  return (
    principal.userId != null &&
    doc.ownerUserId != null &&
    principal.userId === doc.ownerUserId
  );
}
