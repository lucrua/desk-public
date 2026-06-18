import { describe, it, expect, beforeEach } from "vitest";
import { resetDb, createShareOk, publishDocOk } from "@/test/db";
import { publishDoc, unpublishDoc } from "@/lib/docs";
import { hashToken } from "@/lib/tokens";
import {
  createShare,
  resolveShare,
  revokeShare,
  recordView,
  listShares,
  listSharesForDoc,
  listViews,
  countRecentViews,
  resolveShareState,
  createDirectoryShare,
} from "./shares";

const BASE_DOC = {
  slug: "test-doc",
  title: "Test Doc",
  sourcePath: "os/test.md",
  audience: "external:alice",
  format: "md" as const,
  content: "# Hello",
  by: "admin",
};

describe("shares service", () => {
  beforeEach(async () => {
    await resetDb();
    await publishDocOk(BASE_DOC);
  });

  // ── createShare ────────────────────────────────────────────────────────────

  describe("createShare", () => {
    it("returns {id, token (43 chars), shareUrl, label}", async () => {
      const result = await createShareOk("test-doc", "Alice share", "admin");
      expect(result).not.toBeNull();
      expect(typeof result!.id).toBe("number");
      expect(typeof result!.token).toBe("string");
      expect(result!.token).toHaveLength(43);
      expect(result!.shareUrl).toBe(
        `${process.env.SHARE_BASE_URL}/s/${result!.token}`
      );
      expect(result!.label).toBe("Alice share");
    });

    it("DB row stores ONLY the hash — raw token not in row", async () => {
      const result = await createShareOk("test-doc", "Alice share", "admin");
      expect(result).not.toBeNull();
      const { token } = result!;

      // Verify hash matches
      const { db } = await import("@/db");
      const { shares } = await import("@/db/schema");
      const { eq } = await import("drizzle-orm");
      const rows = await db.select().from(shares).where(eq(shares.id, result!.id));
      expect(rows).toHaveLength(1);
      expect(rows[0].tokenHash).toBe(hashToken(token));

      // Row must NOT contain the raw token string anywhere
      const rowStr = JSON.stringify(rows[0]);
      expect(rowStr).not.toContain(token);
    });

    it("createShare with expiresInDays sets expiresAt", async () => {
      const before = Date.now();
      const result = await createShareOk("test-doc", "Expiring", "admin", 7);
      expect(result).not.toBeNull();

      const { db } = await import("@/db");
      const { shares } = await import("@/db/schema");
      const { eq } = await import("drizzle-orm");
      const rows = await db.select().from(shares).where(eq(shares.id, result!.id));
      expect(rows[0].expiresAt).not.toBeNull();
      const expMs = rows[0].expiresAt!.getTime();
      const expectedMs = before + 7 * 24 * 60 * 60 * 1000;
      // Allow ±5 seconds tolerance
      expect(Math.abs(expMs - expectedMs)).toBeLessThan(5000);
    });

    it("createShare for unknown docSlug returns an error outcome", async () => {
      const result = await createShare("no-such-doc", "label", "admin");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe("doc-not-found");
    });

    it("omitted label → auto-named from doc title", async () => {
      const result = await createShareOk("test-doc", undefined, "admin");
      // BASE_DOC title is "Test Doc"
      expect(result.label).toBe("Test Doc");
    });

    it("empty string label → auto-named from doc title", async () => {
      const out = await createShare("test-doc", "", "admin");
      if (!out.ok) throw new Error("Expected ok");
      expect(out.label).toBe("Test Doc");
    });

    it("explicit label is preserved unchanged", async () => {
      const result = await createShareOk("test-doc", "Partner review", "admin");
      expect(result.label).toBe("Partner review");
    });

    it("omitted expiresInDays defaults to ~7 days from now", async () => {
      const before = Date.now();
      const result = await createShareOk("test-doc", "auto-expiry", "admin");
      const { db } = await import("@/db");
      const { shares } = await import("@/db/schema");
      const { eq } = await import("drizzle-orm");
      const rows = await db.select().from(shares).where(eq(shares.id, result.id));
      expect(rows[0].expiresAt).not.toBeNull();
      const expMs = rows[0].expiresAt!.getTime();
      const expectedMs = before + 7 * 24 * 60 * 60 * 1000;
      expect(Math.abs(expMs - expectedMs)).toBeLessThan(5000);
    });

    it("null expiresInDays → expiresAt is null (never expires)", async () => {
      const result = await createShareOk("test-doc", "never-expires", "admin", null);
      const { db } = await import("@/db");
      const { shares } = await import("@/db/schema");
      const { eq } = await import("drizzle-orm");
      const rows = await db.select().from(shares).where(eq(shares.id, result.id));
      expect(rows[0].expiresAt).toBeNull();
    });
  });

  // ── resolveShare ──────────────────────────────────────────────────────────

  describe("resolveShare", () => {
    it("valid share resolves to {doc, version, shareId, expiresAt}", async () => {
      // Pass null to create a never-expiring share (expiresAt = null)
      const share = await createShareOk("test-doc", "Alice", "admin", null);
      expect(share).not.toBeNull();
      const resolved = await resolveShare(share!.token);
      expect(resolved).not.toBeNull();
      expect(resolved!.doc.slug).toBe("test-doc");
      expect(resolved!.version).not.toBeNull();
      expect(resolved!.version!.content).toBe("# Hello");
      expect(resolved!.shareId).toBe(share!.id);
      expect(resolved!.expiresAt).toBeNull(); // null = never expires
    });

    it("resolves to the CURRENT version after re-publish", async () => {
      // Share created pointing at v1
      const share = await createShareOk("test-doc", "Alice", "admin");
      // Publish v2
      await publishDoc({ ...BASE_DOC, content: "# Hello v2" });

      const resolved = await resolveShare(share!.token);
      expect(resolved).not.toBeNull();
      expect(resolved!.version!.content).toBe("# Hello v2");
    });

    it("returns null for unknown token", async () => {
      const result = await resolveShare("A".repeat(43));
      expect(result).toBeNull();
    });

    it("returns null for revoked share", async () => {
      const share = await createShareOk("test-doc", "Alice", "admin");
      await revokeShare(share!.id);
      const result = await resolveShare(share!.token);
      expect(result).toBeNull();
    });

    it("returns null for expired share", async () => {
      // Insert share with expiresAt in the past directly
      const { db } = await import("@/db");
      const { shares } = await import("@/db/schema");
      const { mintToken, hashToken } = await import("@/lib/tokens");
      const token = mintToken();
      const hash = hashToken(token);

      // Get the doc id
      const { docs } = await import("@/db/schema");
      const { eq } = await import("drizzle-orm");
      const docRows = await db.select().from(docs).where(eq(docs.slug, "test-doc"));
      const docId = docRows[0].id;

      const pastDate = new Date(Date.now() - 1000 * 60 * 60); // 1 hour ago
      await db.insert(shares).values({
        tokenHash: hash,
        docId,
        label: "expired",
        createdBy: "admin",
        expiresAt: pastDate,
      });

      const result = await resolveShare(token);
      expect(result).toBeNull();
    });

    it("returns null when doc is unpublished after share created", async () => {
      const share = await createShareOk("test-doc", "Alice", "admin");
      await unpublishDoc("test-doc");
      const result = await resolveShare(share!.token);
      expect(result).toBeNull();
    });
  });

  // ── revokeShare ───────────────────────────────────────────────────────────

  describe("revokeShare", () => {
    it("revokeShare returns true on first call", async () => {
      const share = await createShareOk("test-doc", "Alice", "admin");
      const result = await revokeShare(share!.id);
      expect(result).toBe(true);
    });

    it("revokeShare returns false on second call (idempotent — already revoked)", async () => {
      const share = await createShareOk("test-doc", "Alice", "admin");
      await revokeShare(share!.id);
      const result = await revokeShare(share!.id);
      expect(result).toBe(false);
    });

    it("revokeShare returns false for unknown id", async () => {
      const result = await revokeShare(99999);
      expect(result).toBe(false);
    });
  });

  // ── recordView ────────────────────────────────────────────────────────────

  describe("recordView", () => {
    it("inserts a row in share_views", async () => {
      const share = await createShareOk("test-doc", "Alice", "admin");
      const resolved = await resolveShare(share!.token);
      expect(resolved).not.toBeNull();
      const versionId = resolved!.version!.id;

      await recordView(share!.id, versionId, "1.2.3.4", "Mozilla/5.0");

      const { db } = await import("@/db");
      const { shareViews } = await import("@/db/schema");
      const { eq } = await import("drizzle-orm");
      const rows = await db
        .select()
        .from(shareViews)
        .where(eq(shareViews.shareId, share!.id));
      expect(rows).toHaveLength(1);
      expect(rows[0].ip).toBe("1.2.3.4");
      expect(rows[0].userAgent).toBe("Mozilla/5.0");
    });

    it("caps long ip (64 chars) and userAgent (512 chars) before insert", async () => {
      const share = await createShareOk("test-doc", "Alice", "admin");
      const resolved = await resolveShare(share!.token);
      const versionId = resolved!.version!.id;

      const longIp = "9".repeat(300);
      const longUa = "A".repeat(2000);
      await recordView(share!.id, versionId, longIp, longUa);

      const { db } = await import("@/db");
      const { shareViews } = await import("@/db/schema");
      const { eq } = await import("drizzle-orm");
      const rows = await db
        .select()
        .from(shareViews)
        .where(eq(shareViews.shareId, share!.id));
      expect(rows).toHaveLength(1);
      expect(rows[0].ip).toHaveLength(64);
      expect(rows[0].userAgent).toHaveLength(512);
      expect(rows[0].ip).toBe("9".repeat(64));
      expect(rows[0].userAgent).toBe("A".repeat(512));
    });

    it("inserts without optional ip/userAgent", async () => {
      const share = await createShareOk("test-doc", "Alice", "admin");
      const resolved = await resolveShare(share!.token);
      const versionId = resolved!.version!.id;

      await recordView(share!.id, versionId);

      const { db } = await import("@/db");
      const { shareViews } = await import("@/db/schema");
      const { eq } = await import("drizzle-orm");
      const rows = await db
        .select()
        .from(shareViews)
        .where(eq(shareViews.shareId, share!.id));
      expect(rows).toHaveLength(1);
      expect(rows[0].ip).toBeNull();
    });
  });

  // ── listShares ────────────────────────────────────────────────────────────

  describe("listShares", () => {
    it("returns per-share summary with viewCount and lastViewedAt", async () => {
      const share = await createShareOk("test-doc", "Alice share", "admin");
      const resolved = await resolveShare(share!.token);
      const versionId = resolved!.version!.id;

      await recordView(share!.id, versionId, "1.1.1.1");
      await recordView(share!.id, versionId, "2.2.2.2");

      const list = await listShares();
      expect(list).toHaveLength(1);
      const item = list[0];
      expect(item.id).toBe(share!.id);
      expect(item.label).toBe("Alice share");
      expect(item.docSlug).toBe("test-doc");
      expect(item.createdBy).toBe("admin");
      expect(item.viewCount).toBe(2);
      expect(item.lastViewedAt).not.toBeNull();
      expect(item.revokedAt).toBeNull();
    });

    it("viewCount is 0 for share with no views", async () => {
      await createShareOk("test-doc", "No views", "admin");
      const list = await listShares();
      expect(list).toHaveLength(1);
      expect(list[0].viewCount).toBe(0);
      expect(list[0].lastViewedAt).toBeNull();
    });

    it("lists multiple shares", async () => {
      await createShareOk("test-doc", "Share A", "admin");
      await createShareOk("test-doc", "Share B", "admin");
      const list = await listShares();
      expect(list).toHaveLength(2);
    });
  });

  // ── listSharesForDoc ──────────────────────────────────────────────────────────

  describe("listSharesForDoc", () => {
    const OTHER_DOC = { ...BASE_DOC, slug: "other-doc", sourcePath: "os/other.md" };

    it("returns only shares for the given doc (SQL-filtered, not cross-contaminated)", async () => {
      await publishDoc(OTHER_DOC);
      await createShareOk("test-doc", "Mine A", "admin");
      await createShareOk("test-doc", "Mine B", "admin");
      await createShareOk("other-doc", "Theirs", "admin");

      const mine = await listSharesForDoc("test-doc");
      expect(mine).toHaveLength(2);
      expect(mine.every((s) => s.docSlug === "test-doc")).toBe(true);

      const theirs = await listSharesForDoc("other-doc");
      expect(theirs).toHaveLength(1);
      expect(theirs[0].label).toBe("Theirs");
    });

    it("returns [] for a doc with no shares", async () => {
      const list = await listSharesForDoc("test-doc");
      expect(list).toEqual([]);
    });

    it("returns [] for an unknown slug", async () => {
      const list = await listSharesForDoc("does-not-exist");
      expect(list).toEqual([]);
    });

    it("carries view stats, expiry, revoke and allowComments state", async () => {
      const share = await createShareOk("test-doc", "Alice", "admin");
      const resolved = await resolveShare(share!.token);
      await recordView(share!.id, resolved!.version!.id, "1.1.1.1");
      await revokeShare(share!.id);

      const [item] = await listSharesForDoc("test-doc");
      expect(item.id).toBe(share!.id);
      expect(item.viewCount).toBe(1);
      expect(item.lastViewedAt).not.toBeNull();
      expect(item.revokedAt).not.toBeNull();
      expect(item.allowComments).toBe(true);
    });

    it("orders newest-first by createdAt", async () => {
      const a = await createShareOk("test-doc", "First", "admin");
      const b = await createShareOk("test-doc", "Second", "admin");
      const list = await listSharesForDoc("test-doc");
      // Same-instant createdAt falls back to id desc — newest id first.
      expect(list.map((s) => s.id)).toEqual([b!.id, a!.id]);
    });
  });

  // ── listViews ───────────────────────────────────────────────────────────────

  describe("listViews", () => {
    it("returns view rows newest-first with ip/userAgent/docVersionId", async () => {
      const share = await createShareOk("test-doc", "Alice", "admin");
      const resolved = await resolveShare(share!.token);
      const versionId = resolved!.version!.id;

      const { db } = await import("@/db");
      const { shareViews } = await import("@/db/schema");
      // Insert two views with explicit, distinct viewedAt so order is deterministic.
      await db.insert(shareViews).values({
        shareId: share!.id,
        docVersionId: versionId,
        viewedAt: new Date("2026-06-01T10:00:00Z"),
        ip: "1.1.1.1",
        userAgent: "old-ua",
      });
      await db.insert(shareViews).values({
        shareId: share!.id,
        docVersionId: versionId,
        viewedAt: new Date("2026-06-09T10:00:00Z"),
        ip: "2.2.2.2",
        userAgent: "new-ua",
      });

      const views = await listViews(share!.id);
      expect(views).toHaveLength(2);
      // newest first
      expect(views[0].userAgent).toBe("new-ua");
      expect(views[0].ip).toBe("2.2.2.2");
      expect(views[0].docVersionId).toBe(versionId);
      expect(views[1].userAgent).toBe("old-ua");
    });

    it("returns ip/userAgent unsanitized (raw passthrough — render layer escapes)", async () => {
      const share = await createShareOk("test-doc", "Alice", "admin");
      const resolved = await resolveShare(share!.token);
      const versionId = resolved!.version!.id;
      const hostile = '<img src=x onerror=alert(1)>';
      await recordView(share!.id, versionId, "9.9.9.9", hostile);

      const views = await listViews(share!.id);
      expect(views).toHaveLength(1);
      // Service does NOT sanitize — the string is returned verbatim.
      expect(views[0].userAgent).toBe(hostile);
    });

    it("empty list for a share with no views", async () => {
      const share = await createShareOk("test-doc", "No views", "admin");
      const views = await listViews(share!.id);
      expect(views).toEqual([]);
    });

    it("empty list for an unknown shareId", async () => {
      const views = await listViews(999999);
      expect(views).toEqual([]);
    });
  });

  // ── resolveShareState ─────────────────────────────────────────────────────────

  describe("resolveShareState", () => {
    it("unknown token → { state: 'gone' }", async () => {
      const result = await resolveShareState("A".repeat(43));
      expect(result.state).toBe("gone");
    });

    it("active share → { state: 'ok' }", async () => {
      const share = await createShareOk("test-doc", "active", "admin", null);
      const result = await resolveShareState(share.token);
      expect(result.state).toBe("ok");
    });

    it("revoked share → { state: 'gone' }", async () => {
      const share = await createShareOk("test-doc", "revoke-me", "admin", null);
      await revokeShare(share.id);
      const result = await resolveShareState(share.token);
      expect(result.state).toBe("gone");
    });

    it("expired share (not revoked/deleted) → { state: 'expired', expiresAt }", async () => {
      const { db } = await import("@/db");
      const { shares, docs } = await import("@/db/schema");
      const { eq } = await import("drizzle-orm");
      const { mintToken, hashToken } = await import("@/lib/tokens");
      const docRows = await db.select().from(docs).where(eq(docs.slug, "test-doc"));
      const token = mintToken();
      const pastDate = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago
      await db.insert(shares).values({
        tokenHash: hashToken(token),
        docId: docRows[0].id,
        label: "expired",
        createdBy: "admin",
        expiresAt: pastDate,
      });
      const result = await resolveShareState(token);
      expect(result.state).toBe("expired");
      if (result.state === "expired") {
        expect(result.expiresAt.getTime()).toBeCloseTo(pastDate.getTime(), -2);
      }
    });

    it("deleted share → { state: 'gone' }", async () => {
      const { deleteShare } = await import("./shares");
      const share = await createShareOk("test-doc", "delete-me", "admin", null);
      await deleteShare(share.id);
      const result = await resolveShareState(share.token);
      expect(result.state).toBe("gone");
    });
  });

  // ── createDirectoryShare label auto-name ──────────────────────────────────────

  describe("createDirectoryShare — label optional", () => {
    it("omitted label → auto-named as 'Folder: <prefix>'", async () => {
      const result = await createDirectoryShare("finance", undefined, "admin");
      if (!result.ok) throw new Error("Expected ok");
      expect(result.label).toBe("Folder: finance");
    });

    it("explicit label is preserved", async () => {
      const result = await createDirectoryShare("finance", "Q3 finance pack", "admin");
      if (!result.ok) throw new Error("Expected ok");
      expect(result.label).toBe("Q3 finance pack");
    });
  });

  // ── countRecentViews ─────────────────────────────────────────────────────────

  describe("countRecentViews", () => {
    it("counts only views within the window", async () => {
      const share = await createShareOk("test-doc", "Alice", "admin");
      const resolved = await resolveShare(share!.token);
      const versionId = resolved!.version!.id;

      const { db } = await import("@/db");
      const { shareViews } = await import("@/db/schema");
      // Two recent (now), one old (30 days ago).
      await recordView(share!.id, versionId, "1.1.1.1");
      await recordView(share!.id, versionId, "2.2.2.2");
      await db.insert(shareViews).values({
        shareId: share!.id,
        docVersionId: versionId,
        viewedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      });

      expect(await countRecentViews(7)).toBe(2);
      // a wide window catches all three
      expect(await countRecentViews(60)).toBe(3);
    });

    it("returns 0 when there are no views", async () => {
      expect(await countRecentViews(7)).toBe(0);
    });
  });
});
