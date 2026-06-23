import { describe, it, expect } from "vitest";
import { toFolderShareRows } from "./view-model";
import type { ShareListItem } from "@/lib/shares";

const NOW = new Date("2026-06-10T12:00:00Z");

function share(over: Partial<ShareListItem> = {}): ShareListItem {
  return {
    id: 1,
    label: "Folder",
    mode: "directory",
    docSlug: null,
    pathPrefix: "finance",
    createdBy: "lucas",
    createdAt: new Date("2026-06-01T00:00:00Z"),
    allowComments: true,
    expiresAt: null,
    revokedAt: null,
    viewCount: 3,
    lastViewedAt: new Date("2026-06-05T00:00:00Z"),
    pinnedVersionId: null,
    status: "active",
    canCopy: false,
    ...over,
  };
}

describe("toFolderShareRows", () => {
  it("keeps only directory shares (drops doc shares)", () => {
    const rows = toFolderShareRows(
      [
        share({ id: 1 }),
        { ...share({ id: 2 }), mode: "doc", docSlug: "x", pathPrefix: null },
      ],
      NOW,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(1);
    expect(rows[0].pathPrefix).toBe("finance");
  });

  it("derives active / revoked / expired status + canRevoke", () => {
    const [active] = toFolderShareRows([share({ id: 1 })], NOW);
    expect(active.status).toBe("active");
    expect(active.canRevoke).toBe(true);
    expect(active.expires).toBe("never");

    const [revoked] = toFolderShareRows([share({ id: 2, revokedAt: NOW })], NOW);
    expect(revoked.status).toBe("revoked");
    expect(revoked.canRevoke).toBe(false);

    const [expired] = toFolderShareRows(
      [share({ id: 3, expiresAt: new Date("2026-06-01T00:00:00Z") })],
      NOW,
    );
    expect(expired.status).toBe("expired");
    expect(expired.expires).toBe("expired");
  });

  it("formats lastView '—' when never viewed", () => {
    const [r] = toFolderShareRows([share({ id: 1, lastViewedAt: null })], NOW);
    expect(r.lastView).toBe("—");
  });

  it("sorts newest id first", () => {
    const rows = toFolderShareRows([share({ id: 1 }), share({ id: 5 }), share({ id: 3 })], NOW);
    expect(rows.map((r) => r.id)).toEqual([5, 3, 1]);
  });
});
