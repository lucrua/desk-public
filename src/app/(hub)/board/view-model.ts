/**
 * Pure view-model logic for the board. No React, no fetch — just the math the
 * client island and the tests both depend on. Kept separate so the tricky bits
 * (drop-index computation, checklist progress, owner-filter interaction) are
 * unit-testable without a DOM.
 */

export type BoardCard = {
  id: number;
  title: string;
  body: string;
  bucketId: number;
  bucketKey: string;
  position: number;
  ownerUserId: number | null;
  ownerName: string | null;
  docSlug: string | null;
  checklist: { text: string; done: boolean }[];
  archivedAt: string | null;
};

export type BoardBucket = {
  id: number;
  key: string;
  label: string;
  position: number;
};

/** Checklist progress as a `done/total` label + percent (0 when empty). */
export function checklistProgress(checklist: { done: boolean }[]): {
  label: string;
  done: number;
  total: number;
  percent: number;
} {
  const total = checklist.length;
  const done = checklist.filter((c) => c.done).length;
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  return { label: `${done}/${total}`, done, total, percent };
}

/** Owner initial for the avatar chip ("Alex" → "A"; empty → "?"). */
export function ownerInitial(name: string | null): string {
  if (!name || name.trim().length === 0) return "?";
  return name.trim()[0].toUpperCase();
}

/**
 * Compute the drop slot index when a card is dragged over a target card.
 * `before` = the pointer is in the top half of the target → insert at the
 * target's index; otherwise after it (index + 1).
 *
 * KNOWN SIMPLIFICATION (carried from the design mock's "drop-index math ignores
 * active owner-filters"): the index returned is an index into the CURRENTLY
 * VISIBLE (filtered) list, not the full bucket. When an owner filter hides some
 * cards, the visible index does not equal the storage slot. The board resolves
 * the visible index back to a real insert position by passing the move through
 * the service, which inserts between the *unfiltered* neighbors of the visible
 * slot — see resolveVisibleDropToInsertIndex. This function is purely about the
 * visible list and intentionally filter-agnostic.
 */
export function dropIndexForCardHover(targetVisibleIndex: number, before: boolean): number {
  return before ? targetVisibleIndex : targetVisibleIndex + 1;
}

/**
 * Translate a drop slot expressed against the VISIBLE (owner-filtered) card list
 * back into an insert index against the FULL (unfiltered) bucket list, so the
 * move lands where the user sees it even with a filter active.
 *
 * `visibleIds` = ids of the cards shown in the column, in order.
 * `fullIds`    = ids of ALL live cards in the column, in order.
 * `visibleDropIndex` = slot within `visibleIds` (0..visibleIds.length).
 * Returns the slot within `fullIds` (0..fullIds.length).
 *
 * Rule: the drop sits "before" the card currently at `visibleDropIndex` in the
 * visible list (or at the end). We find that card's position in the full list
 * and insert there; an end-of-visible drop maps to end-of-full. The moved card
 * (if present) is excluded by the caller before computing positions, so we
 * operate on neighbor identity only.
 */
export function resolveVisibleDropToFullIndex(
  visibleIds: number[],
  fullIds: number[],
  visibleDropIndex: number,
): number {
  // End of the visible list → end of the full list.
  if (visibleDropIndex >= visibleIds.length) return fullIds.length;
  // The card the drop lands *before* in the visible list.
  const anchorId = visibleIds[visibleDropIndex];
  const fullPos = fullIds.indexOf(anchorId);
  return fullPos === -1 ? fullIds.length : fullPos;
}

/** Apply an owner filter to a card list. `ownerUserId === null` = "all". */
export function filterByOwner(cards: BoardCard[], ownerUserId: number | null): BoardCard[] {
  if (ownerUserId == null) return cards;
  return cards.filter((c) => c.ownerUserId === ownerUserId);
}

/** Group live (non-archived) cards by bucket id, preserving card order. */
export function groupCardsByBucket(
  cards: BoardCard[],
  buckets: BoardBucket[],
): Map<number, BoardCard[]> {
  const map = new Map<number, BoardCard[]>();
  for (const b of buckets) map.set(b.id, []);
  for (const c of cards) {
    if (c.archivedAt != null) continue;
    const list = map.get(c.bucketId);
    if (list) list.push(c);
  }
  return map;
}

/**
 * Whether the acting principal may edit/move/archive a card on the board.
 * Admin → always. Member → only their own card. Mirrors the server predicate
 * (canEditCard) so the UI's locked-card affordance matches what the API allows.
 */
export function uiCanEdit(
  isAdmin: boolean,
  card: { ownerUserId: number | null },
  myUserId: number | null,
): boolean {
  if (isAdmin) return true;
  if (myUserId == null) return false;
  return card.ownerUserId === myUserId;
}

/** Render a card.* activity event payload into the human trail line. */
export function activityLine(
  kind: string,
  payload: Record<string, unknown>,
  actorName: string,
  bucketLabelByKey: (key: string) => string,
): string {
  const by = ` · ${actorName}`;
  switch (kind) {
    case "card.created":
      return `created${by}`;
    case "card.moved": {
      const from = payload.from ? bucketLabelByKey(String(payload.from)) : null;
      const to = payload.to ? bucketLabelByKey(String(payload.to)) : null;
      if (from && to) return `moved ${from} → ${to}${by}`;
      if (to) return `moved to ${to}${by}`;
      return `moved${by}`;
    }
    case "card.updated": {
      const fields = Array.isArray(payload.fields) ? (payload.fields as string[]).join(", ") : "";
      return fields ? `updated ${fields}${by}` : `updated${by}`;
    }
    case "card.assigned":
      return payload.ownerUserId == null ? `unassigned${by}` : `assigned${by}`;
    case "card.archived":
      return payload.archived ? `archived${by}` : `restored${by}`;
    default:
      return `${kind}${by}`;
  }
}
