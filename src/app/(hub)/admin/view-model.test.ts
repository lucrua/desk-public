import { describe, it, expect } from "vitest";
import { isShareActive, toShareRow, computeStats, toUserRow, toAccessRequestRow } from "./view-model";
import type { AccessRequestListItem } from "@/lib/access-requests";
import type { ShareListItem } from "@/lib/shares";
import type { DocListItem } from "@/lib/docs";
import type { UserListItem } from "@/lib/users";
import type { Principal } from "@/lib/auth";

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

function doc(over: Partial<DocListItem> = {}): DocListItem {
  return {
    slug: "d",
    title: "D",
    audience: "team",
    format: "md",
    path: "",
    versionCount: 1,
    updatedAt: new Date("2026-06-01T00:00:00Z"),
    unresolvedComments: 0,
    unpublishedAt: null,
    ownerUserId: null,
    spaceSlug: null,
    ...over,
  };
}

describe("isShareActive", () => {
  it("active when not revoked and no expiry", () => {
    expect(isShareActive(share(), NOW)).toBe(true);
  });
  it("inactive when revoked", () => {
    expect(isShareActive(share({ revokedAt: new Date("2026-06-05") }), NOW)).toBe(false);
  });
  it("inactive when expired", () => {
    expect(isShareActive(share({ expiresAt: new Date("2026-06-01") }), NOW)).toBe(false);
  });
  it("active when expiry is in the future", () => {
    expect(isShareActive(share({ expiresAt: new Date("2026-12-01") }), NOW)).toBe(true);
  });
});

describe("toShareRow", () => {
  it("never-expiry, never-viewed", () => {
    const r = toShareRow(share(), NOW);
    expect(r.expires).toBe("never");
    expect(r.lastView).toBe("—");
    expect(r.neverViewed).toBe(true);
    expect(r.canRevoke).toBe(true);
    expect(r.isRevoked).toBe(false);
    expect(r.scope).toBe("doc:market-context");
  });

  it("future expiry within window → expiringSoon", () => {
    const r = toShareRow(share({ expiresAt: new Date("2026-06-20T12:00:00Z") }), NOW);
    expect(r.expires).toBe("2026-06-20");
    expect(r.expiringSoon).toBe(true);
  });

  it("future expiry beyond window → not expiringSoon", () => {
    const r = toShareRow(share({ expiresAt: new Date("2026-09-01T12:00:00Z") }), NOW);
    expect(r.expiringSoon).toBe(false);
  });

  it("past expiry → 'expired', not soon", () => {
    const r = toShareRow(share({ expiresAt: new Date("2026-06-01T12:00:00Z") }), NOW);
    expect(r.expires).toBe("expired");
    expect(r.expiringSoon).toBe(false);
  });

  it("revoked → cannot revoke, isRevoked true", () => {
    const r = toShareRow(share({ revokedAt: new Date("2026-06-05") }), NOW);
    expect(r.isRevoked).toBe(true);
    expect(r.canRevoke).toBe(false);
  });

  it("carries allowComments through (on and off)", () => {
    expect(toShareRow(share({ allowComments: true }), NOW).allowComments).toBe(true);
    expect(toShareRow(share({ allowComments: false }), NOW).allowComments).toBe(false);
  });

  it("viewed → lastView stamp + viewCount", () => {
    const r = toShareRow(
      share({ lastViewedAt: new Date("2026-06-09T14:02:00Z"), viewCount: 3 }),
      NOW,
    );
    expect(r.lastView).toBe("2026-06-09");
    expect(r.neverViewed).toBe(false);
    expect(r.viewCount).toBe(3);
  });
});

describe("computeStats", () => {
  it("counts published docs, active shares, passes recentViews through", () => {
    const docs = [doc(), doc({ slug: "x", unpublishedAt: new Date("2026-06-05") }), doc({ slug: "y" })];
    const shares = [
      share(),
      share({ id: 2, revokedAt: new Date("2026-06-05") }),
      share({ id: 3, expiresAt: new Date("2026-06-01") }), // expired
      share({ id: 4, expiresAt: new Date("2026-12-01") }), // active
    ];
    const stats = computeStats(docs, shares, 14, NOW);
    expect(stats.publishedDocs).toBe(2);
    expect(stats.activeShares).toBe(2);
    expect(stats.recentViews).toBe(14);
  });
});

function user(over: Partial<UserListItem> = {}): UserListItem {
  return {
    id: 1,
    email: "dani@example.com",
    tokenName: null,
    displayName: "Dani",
    role: "member",
    active: 1,
    createdAt: new Date("2026-06-01T00:00:00Z"),
    ...over,
  };
}

describe("toUserRow — admin model v2 (stored role is the truth)", () => {
  const adminSelf: Principal = { kind: "admin", name: "Lucas", email: "lucas@example.org" };
  const tokenSelf: Principal = { kind: "admin", name: "CI", tokenName: "ci-publisher" };

  it("maps fields and stamps created date; active=1 → true", () => {
    const r = toUserRow(user(), adminSelf, undefined);
    expect(r).toMatchObject({
      id: 1,
      displayName: "Dani",
      email: "dani@example.com",
      tokenName: null,
      role: "member",
      active: true,
      created: "2026-06-01",
      isSelf: false,
    });
  });

  it("active=0 → active:false", () => {
    expect(toUserRow(user({ active: 0 }), adminSelf, undefined).active).toBe(false);
  });

  it("isSelf true on email match (case-insensitive)", () => {
    const r = toUserRow(user({ email: "LUCAS@EXAMPLE.ORG" }), adminSelf, undefined);
    expect(r.isSelf).toBe(true);
  });

  it("isSelf true on tokenName match", () => {
    const r = toUserRow(user({ email: null, tokenName: "ci-publisher" }), tokenSelf, undefined);
    expect(r.isSelf).toBe(true);
  });

  it("isSelf false for a different identity", () => {
    expect(toUserRow(user({ email: "other@example.com" }), adminSelf, undefined).isSelf).toBe(false);
  });

  it("isSelf false for anonymous principal", () => {
    expect(toUserRow(user(), { kind: "anonymous" }, undefined).isSelf).toBe(false);
  });

  it("does not cross-match null target token against a principal with no token", () => {
    expect(toUserRow(user({ tokenName: null }), adminSelf, undefined).isSelf).toBe(false);
  });

  // ── stored-role chip (admin model v2) ─────────────────────────────────────
  it("role='admin' in stored column → 'admin' chip (regardless of any adminEmail arg)", () => {
    expect(toUserRow(user({ role: "admin" }), adminSelf, undefined).role).toBe("admin");
    // adminEmail arg is ignored — stored column wins
    expect(toUserRow(user({ role: "admin" }), adminSelf, "lucas@example.org").role).toBe("admin");
  });

  it("role='member' in stored column → 'member' chip", () => {
    expect(toUserRow(user({ role: "member" }), adminSelf, undefined).role).toBe("member");
  });

  it("stored role=member row → member even if adminEmail matches (ADMIN_EMAIL ignored)", () => {
    // The admin email argument has NO effect on role derivation.
    expect(
      toUserRow(user({ email: "lucas@example.org", role: "member" }), adminSelf, "lucas@example.org").role,
    ).toBe("member"); // stored member wins
  });

  it("stored role=admin row → admin even if email doesn't match adminEmail", () => {
    // Stored admin wins over any email comparison.
    expect(
      toUserRow(user({ email: "dani@example.com", role: "admin" }), adminSelf, "lucas@example.org").role,
    ).toBe("admin");
  });

  it("a token-only row with role=admin → admin (agent publish rights)", () => {
    expect(
      toUserRow(user({ email: null, tokenName: "ci-agent", role: "admin" }), adminSelf, undefined).role,
    ).toBe("admin");
  });

  it("a token-only row with role=member → member", () => {
    expect(
      toUserRow(user({ email: null, tokenName: "ci-agent", role: "member" }), adminSelf, undefined).role,
    ).toBe("member");
  });

  // ── canToggleRole ──────────────────────────────────────────────────────────
  it("canToggleRole=true for a non-self admin row (can demote others)", () => {
    const row = toUserRow(user({ email: "other@example.com", role: "admin" }), adminSelf, undefined, [], 2);
    expect(row.canToggleRole).toBe(true);
  });

  it("canToggleRole=false only when isSelf && last active admin", () => {
    const self = toUserRow(
      user({ email: "lucas@example.org", role: "admin" }),
      adminSelf,
      undefined,
      [],
      1, // only one active admin
    );
    expect(self.isSelf).toBe(true);
    expect(self.canToggleRole).toBe(false);
  });

  it("canToggleRole=true when isSelf but NOT last admin", () => {
    const self = toUserRow(
      user({ email: "lucas@example.org", role: "admin" }),
      adminSelf,
      undefined,
      [],
      2, // two admins — can still demote self
    );
    expect(self.isSelf).toBe(true);
    expect(self.canToggleRole).toBe(true);
  });

  it("canToggleRole=true for member rows (promote is always allowed)", () => {
    const row = toUserRow(user({ email: "dani@example.com", role: "member" }), adminSelf, undefined, [], 1);
    expect(row.canToggleRole).toBe(true);
  });

  // ── multiple emails per user ──────────────────────────────────────────────
  it("emails defaults to the primary when no set is passed", () => {
    const r = toUserRow(user({ email: "dani@example.com" }), adminSelf, undefined);
    expect(r.emails).toEqual([{ email: "dani@example.com", primary: true }]);
  });

  it("emails passes the explicit set through", () => {
    const r = toUserRow(user({ email: "p@example.com" }), adminSelf, undefined, [
      { email: "p@example.com", primary: true },
      { email: "alias@example.com", primary: false },
    ]);
    expect(r.emails.map((e) => e.email).sort()).toEqual(["alias@example.com", "p@example.com"]);
  });

  it("isSelf true when the principal logged in via a SECONDARY email", () => {
    // Principal carries the full email set (logged in via the secondary).
    const principal: Principal = {
      kind: "admin",
      name: "Lucas",
      email: "lucas@example.org",
      emails: ["lucas@example.org", "lucas@example.net"],
    };
    const r = toUserRow(
      user({ email: "lucas@example.org" }),
      principal,
      undefined,
      [
        { email: "lucas@example.org", primary: true },
        { email: "lucas@example.net", primary: false },
      ],
    );
    expect(r.isSelf).toBe(true);
  });
});

describe("toAccessRequestRow", () => {
  function req(over: Partial<AccessRequestListItem> = {}): AccessRequestListItem {
    return {
      id: 7,
      email: "dani.silva@example.com",
      firstSeenAt: new Date("2026-06-01T00:00:00Z"),
      lastSeenAt: new Date("2026-06-09T00:00:00Z"),
      hits: 3,
      ...over,
    };
  }

  it("maps fields + formats dates", () => {
    const row = toAccessRequestRow(req());
    expect(row).toMatchObject({
      id: 7,
      email: "dani.silva@example.com",
      firstSeen: "2026-06-01",
      lastSeen: "2026-06-09",
      hits: 3,
    });
  });

  it("default display name is the capitalized local-part", () => {
    expect(toAccessRequestRow(req({ email: "pedro@example.com" })).defaultDisplayName).toBe("Pedro");
    expect(toAccessRequestRow(req({ email: "Ana.B@example.com" })).defaultDisplayName).toBe("Ana.B");
  });
});
