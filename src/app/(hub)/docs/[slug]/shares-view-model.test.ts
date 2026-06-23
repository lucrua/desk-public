import { describe, it, expect } from "vitest";
import { shareStatus, toDocShareRow } from "./shares-view-model";
import type { ShareListItem } from "@/lib/shares";

const NOW = new Date("2026-06-10T12:00:00Z");

function share(over: Partial<ShareListItem> = {}): ShareListItem {
  return {
    id: 1,
    label: "Pedro",
    mode: "doc",
    docSlug: "market-context",
    pathPrefix: null,
    createdBy: "lucas",
    createdAt: new Date("2026-06-01T00:00:00Z"),
    allowComments: true,
    expiresAt: null,
    revokedAt: null,
    viewCount: 0,
    lastViewedAt: null,
    pinnedVersionId: null,
    status: "active",
    canCopy: false,
    ...over,
  };
}

describe("shareStatus", () => {
  it("active when neither revoked nor expired", () => {
    expect(shareStatus(share(), NOW)).toBe("active");
  });

  it("active when expiry is in the future", () => {
    expect(shareStatus(share({ expiresAt: new Date("2026-07-01T00:00:00Z") }), NOW)).toBe("active");
  });

  it("expired when expiry is in the past", () => {
    expect(shareStatus(share({ expiresAt: new Date("2026-06-01T00:00:00Z") }), NOW)).toBe("expired");
  });

  it("expired exactly at the boundary (<=)", () => {
    expect(shareStatus(share({ expiresAt: NOW }), NOW)).toBe("expired");
  });

  it("revoked when revokedAt is set", () => {
    expect(shareStatus(share({ revokedAt: new Date("2026-06-05T00:00:00Z") }), NOW)).toBe("revoked");
  });

  it("revoked wins over expired when both are true", () => {
    const s = share({
      revokedAt: new Date("2026-06-05T00:00:00Z"),
      expiresAt: new Date("2026-06-01T00:00:00Z"),
    });
    expect(shareStatus(s, NOW)).toBe("revoked");
  });
});

describe("toDocShareRow", () => {
  it("active row: canRevoke true, expires 'never', lastView '—'", () => {
    const r = toDocShareRow(share(), NOW);
    expect(r.status).toBe("active");
    expect(r.canRevoke).toBe(true);
    expect(r.expires).toBe("never");
    expect(r.lastView).toBe("—");
    expect(r.neverViewed).toBe(true);
    expect(r.created).toBe("2026-06-01");
  });

  it("future expiry renders the date stamp", () => {
    const r = toDocShareRow(share({ expiresAt: new Date("2026-09-01T00:00:00Z") }), NOW);
    expect(r.expires).toBe("2026-09-01");
    expect(r.status).toBe("active");
  });

  it("past expiry renders 'expired' and cannot be revoked", () => {
    const r = toDocShareRow(share({ expiresAt: new Date("2026-06-01T00:00:00Z") }), NOW);
    expect(r.expires).toBe("expired");
    expect(r.status).toBe("expired");
    expect(r.canRevoke).toBe(false);
  });

  it("revoked row cannot be revoked again", () => {
    const r = toDocShareRow(share({ revokedAt: new Date("2026-06-05T00:00:00Z") }), NOW);
    expect(r.status).toBe("revoked");
    expect(r.canRevoke).toBe(false);
  });

  it("carries views + lastView when viewed", () => {
    const r = toDocShareRow(
      share({ viewCount: 3, lastViewedAt: new Date("2026-06-09T08:00:00Z") }),
      NOW,
    );
    expect(r.viewCount).toBe(3);
    expect(r.neverViewed).toBe(false);
    expect(r.lastView).toBe("2026-06-09");
  });

  it("passes through allowComments and createdBy", () => {
    const r = toDocShareRow(share({ allowComments: false, createdBy: "dani" }), NOW);
    expect(r.allowComments).toBe(false);
    expect(r.createdBy).toBe("dani");
  });

  it("live share → live mode chip", () => {
    const r = toDocShareRow(share({ pinnedVersionId: null }), NOW);
    expect(r.modeChip.kind).toBe("live");
  });

  it("pinned share → 'pinned vN' chip via the version label map", () => {
    const r = toDocShareRow(share({ pinnedVersionId: 42 }), NOW, { 42: "v5" });
    expect(r.modeChip.kind).toBe("pinned");
    if (r.modeChip.kind === "pinned") expect(r.modeChip.label).toBe("pinned v5");
  });

  it("pinned share with no label map → bare 'pinned'", () => {
    const r = toDocShareRow(share({ pinnedVersionId: 42 }), NOW);
    if (r.modeChip.kind === "pinned") expect(r.modeChip.label).toBe("pinned");
  });
});
