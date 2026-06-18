/**
 * Tests for the lifecycle-and-distribution batch:
 *   1. Crypto: encryptToken / decryptToken round-trips
 *   2. Share link retrieval: revealShareUrl
 *   3. Share stage-2 delete: deleteShare
 *   4. Doc stage-2 delete: deleteDoc
 *      - Tombstone + content purge
 *      - CRITICAL read-path sweep: deleted doc 404s on EVERY public surface
 *      - Slug reuse via partial-unique index
 *   5. Distribution: byAudience, byUser, links
 *   6. MCP parity (verify new tools exist in registry)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq, and, isNull, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { docs, docVersions, shares, shareViews } from "@/db/schema";
import { resetDb, publishDocOk, seedAudiences, seedUser, seedMembership, createShareOk } from "@/test/db";
import {
  publishDoc,
  unpublishDoc,
  deleteDoc,
  getDocBySlug,
  listDocs,
  searchDocs,
  listVersions,
  getVersionContent,
  scopeForPrincipal,
} from "@/lib/docs";
import {
  createShare,
  createDirectoryShare,
  resolveShare,
  resolveDirectoryShare,
  resolveShareDoc,
  listDocsUnderShare,
  listShares,
  listSharesForDoc,
  revealShareUrl,
  deleteShare,
  revokeShare,
} from "@/lib/shares";
import { encryptToken, decryptToken } from "@/lib/crypto";
import {
  distributionByAudience,
  distributionByUser,
  distributionLinks,
} from "@/lib/distribution";
import { TOOLS } from "@/lib/mcp/tools";

// ── Helpers ──────────────────────────────────────────────────────────────────

function docBase(over: Partial<Parameters<typeof publishDocOk>[0]> = {}) {
  return {
    slug: "test-doc",
    title: "Test Doc",
    sourcePath: "os/test.md",
    audience: "team",
    format: "md" as const,
    content: "# Hello world content for search",
    by: "admin",
    ...over,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// 1. Crypto helper
// ══════════════════════════════════════════════════════════════════════════════

describe("crypto — encryptToken / decryptToken", () => {
  const VALID_KEY = Buffer.alloc(32, 0xab).toString("base64");
  const OTHER_KEY = Buffer.alloc(32, 0xcd).toString("base64");

  afterEach(() => {
    delete process.env.DESK_TOKEN_KEY;
  });

  it("round-trip: encrypt then decrypt returns original token", () => {
    process.env.DESK_TOKEN_KEY = VALID_KEY;
    const raw = "my-secret-token-12345";
    const enc = encryptToken(raw);
    expect(enc).not.toBeNull();
    const dec = decryptToken(enc!);
    expect(dec).toBe(raw);
  });

  it("each encryption produces a different ciphertext (random IV)", () => {
    process.env.DESK_TOKEN_KEY = VALID_KEY;
    const raw = "same-token";
    const enc1 = encryptToken(raw);
    const enc2 = encryptToken(raw);
    expect(enc1).not.toEqual(enc2);
    // But both decrypt to the same plaintext.
    expect(decryptToken(enc1!)).toBe(raw);
    expect(decryptToken(enc2!)).toBe(raw);
  });

  it("DESK_TOKEN_KEY unset → encryptToken returns null (graceful degrade)", () => {
    delete process.env.DESK_TOKEN_KEY;
    expect(encryptToken("anything")).toBeNull();
  });

  it("DESK_TOKEN_KEY unset → decryptToken returns null (no crash)", () => {
    delete process.env.DESK_TOKEN_KEY;
    expect(decryptToken("iv.ct.tag")).toBeNull();
  });

  it("wrong key → decryptToken returns null (auth tag mismatch)", () => {
    process.env.DESK_TOKEN_KEY = VALID_KEY;
    const enc = encryptToken("secret");
    process.env.DESK_TOKEN_KEY = OTHER_KEY;
    expect(decryptToken(enc!)).toBeNull();
  });

  it("tampered ciphertext → decryptToken returns null", () => {
    process.env.DESK_TOKEN_KEY = VALID_KEY;
    const enc = encryptToken("my-token")!;
    const tampered = enc.slice(0, -3) + "xxx";
    expect(decryptToken(tampered)).toBeNull();
  });

  it("malformed format → decryptToken returns null", () => {
    process.env.DESK_TOKEN_KEY = VALID_KEY;
    expect(decryptToken("notdotted")).toBeNull();
    expect(decryptToken("a.b")).toBeNull(); // only 2 parts
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. Share link retrieval (revealShareUrl)
// ══════════════════════════════════════════════════════════════════════════════

describe("revealShareUrl", () => {
  const VALID_KEY = Buffer.alloc(32, 0xde).toString("base64");

  beforeEach(async () => {
    await resetDb();
    await seedAudiences();
    process.env.DESK_TOKEN_KEY = VALID_KEY;
  });

  afterEach(() => {
    delete process.env.DESK_TOKEN_KEY;
  });

  it("reveal returns the SAME URL that resolves the share", async () => {
    await publishDocOk(docBase());
    const created = await createShareOk("test-doc", "Alice", "admin");
    const revealed = await revealShareUrl(created.id);
    expect(revealed).toBe(created.shareUrl);
  });

  it("reveal on a directory share returns the same URL", async () => {
    await publishDocOk(docBase({ path: "finance" }));
    const result = await createDirectoryShare("finance", "Folder", "admin");
    expect(result.ok).toBe(true);
    const created = result as { ok: true; id: number; shareUrl: string };
    const revealed = await revealShareUrl(created.id);
    expect(revealed).toBe(created.shareUrl);
  });

  it("reveal on unknown id → null", async () => {
    expect(await revealShareUrl(9999)).toBeNull();
  });

  it("reveal on pre-migration share (no token_enc) → null", async () => {
    // Insert a share row manually with no token_enc
    await publishDocOk(docBase());
    const [doc] = await db.select({ id: docs.id }).from(docs).where(eq(docs.slug, "test-doc")).limit(1);
    const { hashToken, mintToken } = await import("@/lib/tokens");
    const tok = mintToken();
    const [row] = await db.insert(shares).values({
      tokenHash: hashToken(tok),
      tokenEnc: null, // simulate pre-migration
      docId: doc.id,
      label: "Old share",
      createdBy: "admin",
    }).returning({ id: shares.id });
    expect(await revealShareUrl(row.id)).toBeNull();
  });

  it("reveal on stage-2 deleted share → null", async () => {
    await publishDocOk(docBase());
    const created = await createShareOk("test-doc", "Alice", "admin");
    await deleteShare(created.id);
    expect(await revealShareUrl(created.id)).toBeNull();
  });

  it("reveal on revoked (but not deleted) share → returns URL (admin wants to see which link was revoked)", async () => {
    await publishDocOk(docBase());
    const created = await createShareOk("test-doc", "Alice", "admin");
    await revokeShare(created.id);
    const revealed = await revealShareUrl(created.id);
    expect(revealed).toBe(created.shareUrl);
  });

  it("DESK_TOKEN_KEY unset → create still works, canCopy=false, reveal null", async () => {
    delete process.env.DESK_TOKEN_KEY;
    await publishDocOk(docBase());
    const result = await createShare("test-doc", "Alice", "admin");
    expect(result.ok).toBe(true);
    // canCopy should be false (no token_enc stored)
    const list = await listSharesForDoc("test-doc");
    expect(list[0].canCopy).toBe(false);
    // reveal returns null
    expect(await revealShareUrl(list[0].id)).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. Share stage-2 delete
// ══════════════════════════════════════════════════════════════════════════════

describe("deleteShare (stage-2)", () => {
  const VALID_KEY = Buffer.alloc(32, 0xde).toString("base64");

  beforeEach(async () => {
    await resetDb();
    await seedAudiences();
    process.env.DESK_TOKEN_KEY = VALID_KEY;
  });

  afterEach(() => {
    delete process.env.DESK_TOKEN_KEY;
  });

  it("revoke (stage 1) → link 404s, share still listed with status=revoked", async () => {
    await publishDocOk(docBase());
    const created = await createShareOk("test-doc", "Alice", "admin");
    await revokeShare(created.id);

    // Link 404s
    const resolved = await resolveShare(created.token);
    expect(resolved).toBeNull();

    // Still listed
    const list = await listShares();
    const found = list.find((s) => s.id === created.id);
    expect(found).toBeDefined();
    expect(found!.status).toBe("revoked");
  });

  it("delete (stage 2) → link 404s AND gone from list", async () => {
    await publishDocOk(docBase());
    const created = await createShareOk("test-doc", "Alice", "admin");
    await deleteShare(created.id);

    // Link 404s
    expect(await resolveShare(created.token)).toBeNull();

    // Gone from listShares
    const list = await listShares();
    expect(list.find((s) => s.id === created.id)).toBeUndefined();

    // Gone from listSharesForDoc
    const docList = await listSharesForDoc("test-doc");
    expect(docList.find((s) => s.id === created.id)).toBeUndefined();
  });

  it("delete sets deleted_at AND revokedAt when not already revoked", async () => {
    await publishDocOk(docBase());
    const created = await createShareOk("test-doc", "Alice", "admin");
    await deleteShare(created.id);

    const [row] = await db
      .select({ deletedAt: shares.deletedAt, revokedAt: shares.revokedAt })
      .from(shares)
      .where(eq(shares.id, created.id));
    expect(row.deletedAt).not.toBeNull();
    expect(row.revokedAt).not.toBeNull();
  });

  it("delete is idempotent (calling twice returns true)", async () => {
    await publishDocOk(docBase());
    const created = await createShareOk("test-doc", "Alice", "admin");
    expect(await deleteShare(created.id)).toBe(true);
    expect(await deleteShare(created.id)).toBe(true);
  });

  it("delete on unknown id returns false", async () => {
    expect(await deleteShare(9999)).toBe(false);
  });

  it("row is KEPT after delete (share_views FK integrity)", async () => {
    await publishDocOk(docBase());
    const created = await createShareOk("test-doc", "Alice", "admin");
    await deleteShare(created.id);

    // Row still exists in DB
    const [row] = await db
      .select({ id: shares.id })
      .from(shares)
      .where(eq(shares.id, created.id));
    expect(row).toBeDefined();
  });

  it("delete implies revoke if not already revoked", async () => {
    await publishDocOk(docBase());
    const created = await createShareOk("test-doc", "Alice", "admin");
    // No explicit revoke first
    await deleteShare(created.id);
    const [row] = await db
      .select({ revokedAt: shares.revokedAt })
      .from(shares)
      .where(eq(shares.id, created.id));
    expect(row.revokedAt).not.toBeNull();
  });

  it("delete after revoke keeps original revokedAt", async () => {
    await publishDocOk(docBase());
    const created = await createShareOk("test-doc", "Alice", "admin");
    await revokeShare(created.id);
    const [before] = await db
      .select({ revokedAt: shares.revokedAt })
      .from(shares)
      .where(eq(shares.id, created.id));
    const originalRevoked = before.revokedAt!;

    await deleteShare(created.id);
    const [after] = await db
      .select({ revokedAt: shares.revokedAt })
      .from(shares)
      .where(eq(shares.id, created.id));
    // revokedAt should remain the original value (not overwritten)
    expect(after.revokedAt!.getTime()).toBe(originalRevoked.getTime());
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 4. Doc stage-2 delete
// ══════════════════════════════════════════════════════════════════════════════

describe("deleteDoc (stage-2)", () => {
  beforeEach(async () => {
    await resetDb();
    await seedAudiences();
  });

  it("unpublish (stage 1) keeps content + row (reversible)", async () => {
    const { versionId } = await publishDocOk(docBase());
    await unpublishDoc("test-doc");

    // Row still there
    const [docRow] = await db
      .select()
      .from(docs)
      .where(eq(docs.slug, "test-doc"));
    expect(docRow).toBeDefined();
    expect(docRow.deletedAt).toBeNull();

    // Content still there
    const [ver] = await db
      .select({ content: docVersions.content })
      .from(docVersions)
      .where(eq(docVersions.id, versionId));
    expect(ver.content).not.toBe("");

    // Republishable (reversible)
    const result = await publishDocOk(docBase());
    expect(result.slug).toBe("test-doc");
  });

  it("deleteDoc sets deleted_at, purges content, emits doc.deleted", async () => {
    const { versionId } = await publishDocOk(docBase());
    const result = await deleteDoc("test-doc", "admin");
    expect(result).toBe(true);

    // Tombstone set
    const [docRow] = await db
      .select({ deletedAt: docs.deletedAt })
      .from(docs)
      .where(eq(docs.slug, "test-doc"));
    expect(docRow.deletedAt).not.toBeNull();

    // Content purged
    const [ver] = await db
      .select({ content: docVersions.content })
      .from(docVersions)
      .where(eq(docVersions.id, versionId));
    expect(ver.content).toBe("");

    // doc.deleted event emitted
    const { events } = await import("@/db/schema");
    const [evt] = await db
      .select()
      .from(events)
      .where(eq(events.kind, "doc.deleted"))
      .orderBy(events.id);
    expect(evt).toBeDefined();
    expect((evt.payload as { slug: string }).slug).toBe("test-doc");
  });

  it("deleteDoc returns false for unknown slug", async () => {
    expect(await deleteDoc("ghost-doc", "admin")).toBe(false);
  });

  it("deleteDoc returns false for already-deleted doc (idempotent false)", async () => {
    await publishDocOk(docBase());
    await deleteDoc("test-doc", "admin");
    expect(await deleteDoc("test-doc", "admin")).toBe(false);
  });

  it("deleteDoc works on unpublished doc too", async () => {
    await publishDocOk(docBase());
    await unpublishDoc("test-doc");
    expect(await deleteDoc("test-doc", "admin")).toBe(true);

    const [row] = await db
      .select({ deletedAt: docs.deletedAt })
      .from(docs)
      .where(eq(docs.slug, "test-doc"));
    expect(row.deletedAt).not.toBeNull();
  });

  it("deleteDoc stage-2 deletes all doc-shares (revoked+deleted)", async () => {
    await publishDocOk(docBase());
    const s1 = await createShareOk("test-doc", "Alice", "admin");
    const s2 = await createShareOk("test-doc", "Team", "admin");

    await deleteDoc("test-doc", "admin");

    const shareRows = await db
      .select({ id: shares.id, deletedAt: shares.deletedAt, revokedAt: shares.revokedAt })
      .from(shares)
      .where(eq(shares.docId, (await db.select({ id: docs.id }).from(docs).where(eq(docs.slug, "test-doc")).limit(1))[0].id));

    for (const row of shareRows) {
      expect(row.deletedAt).not.toBeNull();
      expect(row.revokedAt).not.toBeNull();
    }
  });

  // ── CRITICAL read-path sweep ────────────────────────────────────────────────

  it("deleted doc 404s on getDocBySlug", async () => {
    await publishDocOk(docBase());
    await deleteDoc("test-doc", "admin");
    expect(await getDocBySlug("test-doc")).toBeNull();
    expect(await getDocBySlug("test-doc", { includeUnpublished: true })).toBeNull();
  });

  it("deleted doc excluded from listDocs", async () => {
    await publishDocOk(docBase());
    await publishDocOk(docBase({ slug: "other-doc", title: "Other" }));
    await deleteDoc("test-doc", "admin");

    const list = await listDocs({ includeUnpublished: true });
    expect(list.find((d) => d.slug === "test-doc")).toBeUndefined();
    expect(list.find((d) => d.slug === "other-doc")).toBeDefined();
  });

  it("deleted doc excluded from searchDocs / FTS", async () => {
    await publishDocOk(docBase({ content: "unique-searchterm-xyz hello world" }));
    await deleteDoc("test-doc", "admin");

    const results = await searchDocs("unique-searchterm-xyz");
    expect(results.find((d) => d.slug === "test-doc")).toBeUndefined();
  });

  it("deleted doc 404s on resolveShare (doc-share path)", async () => {
    await publishDocOk(docBase());
    const created = await createShareOk("test-doc", "Alice", "admin");
    await deleteDoc("test-doc", "admin");

    // Doc share resolves null (the share itself wasn't revoked, but doc is gone)
    const resolved = await resolveShare(created.token);
    expect(resolved).toBeNull();
  });

  it("deleted doc 404s on listDocsUnderShare (directory-share index)", async () => {
    await publishDocOk(docBase({ path: "finance" }));
    const dirShare = await createDirectoryShare("finance", "Folder", "admin");
    expect(dirShare.ok).toBe(true);
    const dirShareOk = dirShare as { ok: true; id: number; token: string };

    await deleteDoc("test-doc", "admin");
    const listed = await listDocsUnderShare(dirShareOk.id);
    expect(listed.find((d) => d.slug === "test-doc")).toBeUndefined();
  });

  it("deleted doc 404s on resolveShareDoc (directory-share per-doc path)", async () => {
    await publishDocOk(docBase({ path: "finance" }));
    const dirShare = await createDirectoryShare("finance", "Folder", "admin");
    expect(dirShare.ok).toBe(true);
    const dirShareOk = dirShare as { ok: true; id: number; token: string };

    await deleteDoc("test-doc", "admin");
    const resolved = await resolveShareDoc(dirShareOk.token, "test-doc");
    expect(resolved).toBeNull();
  });

  it("deleted doc 404s on listVersions", async () => {
    await publishDocOk(docBase());
    await deleteDoc("test-doc", "admin");
    const versions = await listVersions("test-doc");
    expect(versions).toHaveLength(0);
  });

  it("deleted doc 404s on getVersionContent", async () => {
    const { versionId } = await publishDocOk(docBase());
    await deleteDoc("test-doc", "admin");
    const content = await getVersionContent("test-doc", versionId);
    expect(content).toBeNull();
  });

  it("deleted doc excluded from audience scoping for admin", async () => {
    await publishDocOk(docBase({ audience: "team" }));
    await deleteDoc("test-doc", "admin");

    const list = await listDocs({
      includeUnpublished: true,
      scope: { viewer: "admin" },
    });
    expect(list.find((d) => d.slug === "test-doc")).toBeUndefined();
  });

  it("deleted doc excluded from audience scoping for member", async () => {
    await publishDocOk(docBase({ audience: "team" }));
    const userId = await seedUser({ displayName: "Alice", email: "alice@test.com" });
    await deleteDoc("test-doc", "admin");

    const list = await listDocs({
      scope: { viewer: "member", userId },
    });
    expect(list.find((d) => d.slug === "test-doc")).toBeUndefined();
  });

  // ── Slug reuse ────────────────────────────────────────────────────────────

  it("slug reuse: republish at deleted slug creates NEW doc_id + fresh version chain", async () => {
    // First publish
    const first = await publishDocOk(docBase({ content: "first content" }));

    // Get original doc_id
    const [origRow] = await db
      .select({ id: docs.id })
      .from(docs)
      .where(eq(docs.slug, "test-doc"))
      .limit(1);
    const origDocId = origRow.id;

    // Delete
    await deleteDoc("test-doc", "admin");

    // Republish at the same slug
    const second = await publishDocOk(docBase({ content: "brand new content" }));

    // New doc_id
    const [newRow] = await db
      .select({ id: docs.id, deletedAt: docs.deletedAt })
      .from(docs)
      .where(and(eq(docs.slug, "test-doc"), isNull(docs.deletedAt)))
      .limit(1);
    expect(newRow.id).not.toBe(origDocId);

    // Old tombstone still there
    const [tombstone] = await db
      .select({ id: docs.id, deletedAt: docs.deletedAt })
      .from(docs)
      .where(eq(docs.id, origDocId));
    expect(tombstone.deletedAt).not.toBeNull();

    // Fresh version chain (only one version on the new doc)
    const versions = await listVersions("test-doc");
    expect(versions).toHaveLength(1);
    expect(versions[0].id).toBe(second.versionId);
    expect(versions[0].id).not.toBe(first.versionId);
  });

  it("partial unique index: allows one live + N deleted at same slug", async () => {
    // First doc at slug
    await publishDocOk(docBase());
    await deleteDoc("test-doc", "admin");

    // Second doc at same slug
    await publishDocOk(docBase({ content: "v2" }));
    await deleteDoc("test-doc", "admin");

    // Third doc at same slug — should succeed (no unique constraint violation)
    const result = await publishDoc(docBase({ content: "v3" }));
    expect(result.ok).toBe(true);

    // Two tombstoned rows + one live row all at slug "test-doc"
    const allRows = await db
      .select({ id: docs.id, deletedAt: docs.deletedAt })
      .from(docs)
      .where(eq(docs.slug, "test-doc"));
    expect(allRows.length).toBe(3);
    const live = allRows.filter((r) => r.deletedAt === null);
    const deleted = allRows.filter((r) => r.deletedAt !== null);
    expect(live).toHaveLength(1);
    expect(deleted).toHaveLength(2);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 5. Distribution
// ══════════════════════════════════════════════════════════════════════════════

describe("distribution", () => {
  const KEY = Buffer.alloc(32, 0xab).toString("base64");

  beforeEach(async () => {
    await resetDb();
    await seedAudiences();
    process.env.DESK_TOKEN_KEY = KEY;
  });

  afterEach(() => {
    delete process.env.DESK_TOKEN_KEY;
  });

  // ── byAudience ──────────────────────────────────────────────────────────────

  it("byAudience: correct doc counts + member lists", async () => {
    await publishDocOk(docBase({ slug: "doc-a", audience: "team" }));
    await publishDocOk(docBase({ slug: "doc-b", audience: "team" }));
    await publishDocOk(docBase({ slug: "doc-c", audience: "alice" }));

    const userId = await seedUser({ displayName: "Alice", email: "alice@example.com" });
    await seedMembership("alice", userId);

    const result = await distributionByAudience();
    const team = result.find((a) => a.key === "team");
    const alice = result.find((a) => a.key === "alice");

    expect(team).toBeDefined();
    expect(team!.docCount).toBe(2);

    expect(alice).toBeDefined();
    expect(alice!.docCount).toBe(1);
    expect(alice!.memberCount).toBe(1);
    expect(alice!.members).toContain("Alice");
  });

  it("byAudience: deleted docs excluded", async () => {
    await publishDocOk(docBase({ slug: "doc-live", audience: "team" }));
    await publishDocOk(docBase({ slug: "doc-dead", audience: "team" }));
    await deleteDoc("doc-dead", "admin");

    const result = await distributionByAudience();
    const team = result.find((a) => a.key === "team");
    expect(team!.docCount).toBe(1);
    expect(team!.docs.find((d) => d.slug === "doc-dead")).toBeUndefined();
  });

  // ── byUser ─────────────────────────────────────────────────────────────────

  it("byUser: member visibleDocCount matches audiences-v2 scoping", async () => {
    await publishDocOk(docBase({ slug: "team-doc", audience: "team" }));
    await publishDocOk(docBase({ slug: "alice-doc", audience: "alice" }));

    const userId = await seedUser({ displayName: "Alice", email: "alice@example.com" });
    await seedMembership("alice", userId);

    const result = await distributionByUser();
    const alice = result.find((u) => u.displayName === "Alice");
    expect(alice).toBeDefined();
    // team (member_visible=1) + alice (member) → 2 docs
    expect(alice!.visibleDocCount).toBe(2);
    expect(alice!.audienceKeys).toContain("team");
    expect(alice!.audienceKeys).toContain("alice");
  });

  it("byUser: deleted docs excluded from visibleDocCount", async () => {
    await publishDocOk(docBase({ slug: "team-doc", audience: "team" }));
    await publishDocOk(docBase({ slug: "dead-doc", audience: "team" }));
    await deleteDoc("dead-doc", "admin");

    const userId = await seedUser({ displayName: "Alice", email: "alice@example.com" });
    const result = await distributionByUser();
    const alice = result.find((u) => u.displayName === "Alice");
    expect(alice!.visibleDocCount).toBe(1);
  });

  it("byUser: admin sees all docs", async () => {
    await publishDocOk(docBase({ slug: "doc-a", audience: "team" }));
    await publishDocOk(docBase({ slug: "doc-b", audience: "alice" }));

    const adminId = await seedUser({ displayName: "Admin", email: "admin@example.com", role: "admin" });
    const result = await distributionByUser();
    const admin = result.find((u) => u.displayName === "Admin");
    expect(admin!.visibleDocCount).toBe(2);
  });

  // ── links ──────────────────────────────────────────────────────────────────

  it("links: includes doc shares and directory shares", async () => {
    await publishDocOk(docBase({ path: "finance" }));
    const docShare = await createShareOk("test-doc", "Alice", "admin");
    const dirResult = await createDirectoryShare("finance", "Finance folder", "admin");
    expect(dirResult.ok).toBe(true);

    const links = await distributionLinks();
    const docLink = links.find((l) => l.id === docShare.id);
    const dirLink = links.find((l) => l.mode === "dir");

    expect(docLink).toBeDefined();
    expect(docLink!.mode).toBe("doc");

    expect(dirLink).toBeDefined();
    expect(dirLink!.mode).toBe("dir");
    expect("pathPrefix" in dirLink!.target).toBe(true);
  });

  it("links: deleted shares excluded", async () => {
    await publishDocOk(docBase());
    const created = await createShareOk("test-doc", "Alice", "admin");
    await deleteShare(created.id);

    const links = await distributionLinks();
    expect(links.find((l) => l.id === created.id)).toBeUndefined();
  });

  it("links: canCopy=true for active share with token_enc", async () => {
    await publishDocOk(docBase());
    const created = await createShareOk("test-doc", "Alice", "admin");

    const links = await distributionLinks();
    const link = links.find((l) => l.id === created.id)!;
    expect(link.status).toBe("active");
    expect(link.canCopy).toBe(true);
  });

  it("links: revoked share has status=revoked", async () => {
    await publishDocOk(docBase());
    const created = await createShareOk("test-doc", "Alice", "admin");
    await revokeShare(created.id);

    const links = await distributionLinks();
    const link = links.find((l) => l.id === created.id)!;
    expect(link.status).toBe("revoked");
    expect(link.canCopy).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 6. MCP parity
// ══════════════════════════════════════════════════════════════════════════════

describe("MCP parity — 4 new tools registered", () => {
  it("reveal_share tool exists", () => {
    expect(TOOLS.find((t) => t.name === "reveal_share")).toBeDefined();
  });

  it("delete_share tool exists", () => {
    expect(TOOLS.find((t) => t.name === "delete_share")).toBeDefined();
  });

  it("delete_doc tool exists", () => {
    expect(TOOLS.find((t) => t.name === "delete_doc")).toBeDefined();
  });

  it("distribution_overview tool exists", () => {
    expect(TOOLS.find((t) => t.name === "distribution_overview")).toBeDefined();
  });

  it("total tool count is 63 (57 + 4 lifecycle + 2 doc-ownership)", () => {
    expect(TOOLS.length).toBe(63);
  });
});
