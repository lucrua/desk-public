import { describe, it, expect } from "vitest";
import {
  groupRevisions,
  proposedChangesLabel,
  revisionStamp,
  revisionAuthorChip,
  shareBadgeLabel,
  isStaleBase,
  statusLabel,
  acceptUnavailableReason,
  type RevisionDTO,
} from "./revisions-view-model";

function rev(over: Partial<RevisionDTO> = {}): RevisionDTO {
  return {
    id: 1,
    baseVersionId: 10,
    authorName: "Alex",
    authorKind: "member",
    note: null,
    status: "open",
    createdAt: "2026-06-10T12:00:00.000Z",
    decidedAt: null,
    proposerLabel: null,
    ...over,
  };
}

describe("revisions view-model", () => {
  describe("groupRevisions", () => {
    it("splits open vs decided, preserving order", () => {
      const list = [
        rev({ id: 3, status: "open" }),
        rev({ id: 2, status: "accepted" }),
        rev({ id: 1, status: "rejected" }),
      ];
      const g = groupRevisions(list);
      expect(g.open.map((r) => r.id)).toEqual([3]);
      expect(g.decided.map((r) => r.id)).toEqual([2, 1]);
      expect(g.openCount).toBe(1);
      expect(g.decidedCount).toBe(2);
    });

    it("empty in → empty groups", () => {
      const g = groupRevisions([]);
      expect(g.open).toEqual([]);
      expect(g.decided).toEqual([]);
      expect(g.openCount).toBe(0);
    });
  });

  describe("proposedChangesLabel", () => {
    it("singular / plural / none", () => {
      expect(proposedChangesLabel(1)).toBe("1 proposed change");
      expect(proposedChangesLabel(3)).toBe("3 proposed changes");
      expect(proposedChangesLabel(0)).toBeNull();
      expect(proposedChangesLabel(-1)).toBeNull();
    });
  });

  describe("revisionStamp", () => {
    it("formats ISO as UTC YYYY-MM-DD HH:MM", () => {
      expect(revisionStamp("2026-06-10T12:34:56.000Z")).toBe("2026-06-10 12:34");
    });
    it("passes through an unparseable value", () => {
      expect(revisionStamp("nope")).toBe("nope");
    });
  });

  describe("revisionAuthorChip", () => {
    it("maps admin/member, degrades unknown to member", () => {
      expect(revisionAuthorChip({ authorKind: "admin", authorName: "A" })).toEqual({ label: "A", kind: "admin" });
      expect(revisionAuthorChip({ authorKind: "member", authorName: "B" })).toEqual({ label: "B", kind: "member" });
      expect(revisionAuthorChip({ authorKind: "weird", authorName: "C" })).toEqual({ label: "C", kind: "member" });
    });
  });

  describe("isStaleBase", () => {
    it("true when base != current, false when equal", () => {
      expect(isStaleBase({ baseVersionId: 10 }, 11)).toBe(true);
      expect(isStaleBase({ baseVersionId: 10 }, 10)).toBe(false);
    });
  });

  describe("shareBadgeLabel", () => {
    it("strips the 'link:' prefix for a share suggestion", () => {
      expect(shareBadgeLabel("link:Microsoft")).toBe("Microsoft");
    });
    it("returns the raw value when there is no 'link:' prefix", () => {
      expect(shareBadgeLabel("Acme")).toBe("Acme");
    });
    it("returns null for a staff proposal (no proposer label)", () => {
      expect(shareBadgeLabel(null)).toBeNull();
      expect(shareBadgeLabel(undefined)).toBeNull();
    });
    it("returns null for an empty label after stripping", () => {
      expect(shareBadgeLabel("link:")).toBeNull();
      expect(shareBadgeLabel("")).toBeNull();
    });
  });

  describe("statusLabel", () => {
    it("labels each status", () => {
      expect(statusLabel("open")).toBe("open");
      expect(statusLabel("accepted")).toBe("accepted");
      expect(statusLabel("rejected")).toBe("rejected");
    });
  });

  describe("acceptUnavailableReason", () => {
    it("null (accept available) when the space is not mirrored", () => {
      expect(acceptUnavailableReason(false)).toBeNull();
    });
    it("a note when the space is mirrored", () => {
      const reason = acceptUnavailableReason(true);
      expect(reason).not.toBeNull();
      expect(reason).toMatch(/mirrors from GitHub/i);
    });
  });
});
