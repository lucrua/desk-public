import { describe, it, expect } from "vitest";
import {
  checklistProgress,
  ownerInitial,
  dropIndexForCardHover,
  resolveVisibleDropToFullIndex,
  filterByOwner,
  groupCardsByBucket,
  uiCanEdit,
  activityLine,
  type BoardCard,
  type BoardBucket,
} from "./view-model";

const card = (over: Partial<BoardCard>): BoardCard => ({
  id: 1,
  title: "t",
  body: "",
  bucketId: 1,
  bucketKey: "backlog",
  position: 1,
  ownerUserId: null,
  ownerName: null,
  docSlug: null,
  checklist: [],
  archivedAt: null,
  ...over,
});

describe("board view-model", () => {
  describe("checklistProgress", () => {
    it("computes done/total + percent", () => {
      expect(checklistProgress([])).toEqual({ label: "0/0", done: 0, total: 0, percent: 0 });
      expect(checklistProgress([{ done: true }, { done: false }, { done: false }, { done: false }, { done: false }])).toMatchObject({
        label: "1/5",
        percent: 20,
      });
    });
  });

  describe("ownerInitial", () => {
    it("first letter upper, ? when empty", () => {
      expect(ownerInitial("alex")).toBe("A");
      expect(ownerInitial(null)).toBe("?");
      expect(ownerInitial("  ")).toBe("?");
    });
  });

  describe("dropIndexForCardHover", () => {
    it("top half → before (index); bottom half → after (index+1)", () => {
      expect(dropIndexForCardHover(2, true)).toBe(2);
      expect(dropIndexForCardHover(2, false)).toBe(3);
    });
  });

  describe("resolveVisibleDropToFullIndex (owner-filter caveat)", () => {
    // Full bucket: [10, 20, 30, 40] (ids). Owner filter hides 20 and 40, so the
    // VISIBLE list is [10, 30]. The known-simplification from DESIGN-NOTES is
    // that filtered-out cards keep their positions; the drop index expressed
    // against the visible list must resolve back to a slot in the full list.
    const full = [10, 20, 30, 40];
    const visible = [10, 30];

    it("dropping before the first visible card → before it in the full list", () => {
      // visible slot 0 = "before 10" → full index of 10 = 0
      expect(resolveVisibleDropToFullIndex(visible, full, 0)).toBe(0);
    });

    it("dropping before the 2nd visible card lands before it in the full list (NOT collapsing the hidden card before it)", () => {
      // visible slot 1 = "before 30". 30 sits at full index 2 (after hidden 20).
      // So the drop resolves to full index 2 — the hidden card 20 keeps its
      // position before the insert point. This is the caveat made explicit.
      expect(resolveVisibleDropToFullIndex(visible, full, 1)).toBe(2);
    });

    it("end-of-visible drop → end-of-full", () => {
      expect(resolveVisibleDropToFullIndex(visible, full, 2)).toBe(full.length);
    });

    it("falls back to end when the anchor isn't in the full list", () => {
      expect(resolveVisibleDropToFullIndex([99], [1, 2], 0)).toBe(2);
    });
  });

  describe("filterByOwner", () => {
    it("null = all; otherwise matches ownerUserId", () => {
      const cards = [card({ id: 1, ownerUserId: 5 }), card({ id: 2, ownerUserId: 6 }), card({ id: 3, ownerUserId: null })];
      expect(filterByOwner(cards, null)).toHaveLength(3);
      expect(filterByOwner(cards, 5).map((c) => c.id)).toEqual([1]);
    });
  });

  describe("groupCardsByBucket", () => {
    it("groups live cards by bucket, drops archived, keeps empty buckets", () => {
      const buckets: BoardBucket[] = [
        { id: 1, key: "backlog", label: "Backlog", position: 1 },
        { id: 2, key: "done", label: "Done", position: 2 },
      ];
      const cards = [
        card({ id: 1, bucketId: 1 }),
        card({ id: 2, bucketId: 1, archivedAt: "2020-01-01" }),
        card({ id: 3, bucketId: 2 }),
      ];
      const grouped = groupCardsByBucket(cards, buckets);
      expect(grouped.get(1)!.map((c) => c.id)).toEqual([1]);
      expect(grouped.get(2)!.map((c) => c.id)).toEqual([3]);
    });
  });

  describe("uiCanEdit (mirrors server canEditCard)", () => {
    it("admin always; member only own; null user owns nothing", () => {
      expect(uiCanEdit(true, { ownerUserId: 9 }, null)).toBe(true);
      expect(uiCanEdit(false, { ownerUserId: 5 }, 5)).toBe(true);
      expect(uiCanEdit(false, { ownerUserId: 6 }, 5)).toBe(false);
      expect(uiCanEdit(false, { ownerUserId: null }, null)).toBe(false);
    });
  });

  describe("activityLine", () => {
    const lbl = (k: string) => ({ backlog: "Backlog", review: "Review" }[k] ?? k);
    it("renders each card.* kind", () => {
      expect(activityLine("card.created", {}, "Alex", lbl)).toBe("created · Alex");
      expect(activityLine("card.moved", { from: "backlog", to: "review" }, "Alex", lbl)).toBe("moved Backlog → Review · Alex");
      expect(activityLine("card.moved", { to: "review" }, "Sam", lbl)).toBe("moved to Review · Sam");
      expect(activityLine("card.updated", { fields: ["title", "body"] }, "Alex", lbl)).toBe("updated title, body · Alex");
      expect(activityLine("card.assigned", { ownerUserId: 3 }, "Alex", lbl)).toBe("assigned · Alex");
      expect(activityLine("card.assigned", { ownerUserId: null }, "Alex", lbl)).toBe("unassigned · Alex");
      expect(activityLine("card.archived", { archived: true }, "Alex", lbl)).toBe("archived · Alex");
      expect(activityLine("card.archived", { archived: false }, "Alex", lbl)).toBe("restored · Alex");
    });
  });
});
