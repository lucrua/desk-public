import { describe, it, expect, beforeEach } from "vitest";
import { resetDb, publishDocOk } from "@/test/db";
import { unpublishDoc, publishDoc } from "@/lib/docs";
import {
  createDirectoryShare,
  resolveDirectoryShare,
  resolveShare,
  resolveShareDoc,
  listDocsUnderShare,
  listShares,
  revokeShare,
  isUnderPrefix,
} from "./shares";

// Seed a folder tree:
//   finance            (finance-root)
//   finance/q3         (finance-q3)
//   finance/q3/notes   (finance-q3-notes)
//   financial          (financial-decoy)  ← MUST NOT match prefix "finance"
//   marketing          (marketing)        ← outside the prefix entirely
function baseDoc(over: Partial<Parameters<typeof publishDocOk>[0]> = {}) {
  return {
    slug: "x",
    title: "X",
    sourcePath: "x.md",
    format: "md" as const,
    content: "# X body content",
    by: "lucas",
    ...over,
  };
}

async function seedTree() {
  await publishDocOk(baseDoc({ slug: "finance-root", title: "Finance Root", path: "finance", content: "# Finance overview text" }));
  await publishDocOk(baseDoc({ slug: "finance-q3", title: "Q3", path: "finance/q3", content: "# Q3 results body" }));
  await publishDocOk(baseDoc({ slug: "finance-q3-notes", title: "Q3 Notes", path: "finance/q3/notes", content: "# Q3 notes body" }));
  await publishDocOk(baseDoc({ slug: "financial-decoy", title: "Financial Decoy", path: "financial", content: "# decoy" }));
  await publishDocOk(baseDoc({ slug: "marketing", title: "Marketing", path: "marketing", content: "# marketing" }));
}

describe("directory shares — security matrix", () => {
  beforeEach(async () => {
    await resetDb();
    await seedTree();
  });

  // ── createDirectoryShare ──────────────────────────────────────────────────
  describe("createDirectoryShare", () => {
    it("creates a directory share with a non-empty prefix (docId null)", async () => {
      const out = await createDirectoryShare("workspace", "finance", "Partner folder", "lucas");
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(out.token).toHaveLength(43);

      const { db } = await import("@/db");
      const { shares } = await import("@/db/schema");
      const { eq } = await import("drizzle-orm");
      const [row] = await db.select().from(shares).where(eq(shares.id, out.id));
      expect(row.pathPrefix).toBe("finance");
      expect(row.docId).toBeNull();
    });

    it("normalizes the prefix (strips slashes)", async () => {
      const out = await createDirectoryShare("workspace", "/finance/q3/", "label", "lucas");
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      const res = await resolveDirectoryShare(out.token);
      expect(res?.pathPrefix).toBe("finance/q3");
    });

    it("DISALLOWS the root prefix ('' ) — required non-empty", async () => {
      const out = await createDirectoryShare("workspace", "", "root", "lucas");
      expect(out.ok).toBe(false);
      if (out.ok) return;
      expect(out.error).toBe("invalid-prefix");
    });

    it("rejects an invalid prefix (bad segment)", async () => {
      const out = await createDirectoryShare("workspace", "Bad Folder!", "x", "lucas");
      expect(out.ok).toBe(false);
    });
  });

  // ── isUnderPrefix (boundary) ──────────────────────────────────────────────
  describe("isUnderPrefix — boundary-safe", () => {
    it("matches the prefix itself and descendants", () => {
      expect(isUnderPrefix("finance", "finance")).toBe(true);
      expect(isUnderPrefix("finance/q3", "finance")).toBe(true);
      expect(isUnderPrefix("finance/q3/notes", "finance")).toBe(true);
    });
    it("does NOT match a sibling sharing a string prefix (financial vs finance)", () => {
      expect(isUnderPrefix("financial", "finance")).toBe(false);
      expect(isUnderPrefix("financialish/x", "finance")).toBe(false);
    });
    it("does NOT match an unrelated path", () => {
      expect(isUnderPrefix("marketing", "finance")).toBe(false);
    });
  });

  // ── index: listDocsUnderShare ─────────────────────────────────────────────
  describe("listDocsUnderShare", () => {
    it("lists only PUBLISHED docs under the prefix, excludes the financial/ decoy and marketing", async () => {
      const out = await createDirectoryShare("workspace", "finance", "Folder", "lucas");
      if (!out.ok) throw new Error("create failed");
      const res = await resolveDirectoryShare(out.token);
      const docs = await listDocsUnderShare(res!.shareId);
      const slugs = docs.map((d) => d.slug).sort();
      expect(slugs).toEqual(["finance-q3", "finance-q3-notes", "finance-root"].sort());
      expect(slugs).not.toContain("financial-decoy");
      expect(slugs).not.toContain("marketing");
    });

    it("excludes an unpublished doc under the prefix", async () => {
      const out = await createDirectoryShare("workspace", "finance", "Folder", "lucas");
      if (!out.ok) throw new Error("create failed");
      const res = await resolveDirectoryShare(out.token);
      await unpublishDoc("finance-q3");
      const docs = await listDocsUnderShare(res!.shareId);
      expect(docs.map((d) => d.slug)).not.toContain("finance-q3");
    });

    it("a NEW doc published under the prefix appears without re-sharing (live window)", async () => {
      const out = await createDirectoryShare("workspace", "finance", "Folder", "lucas");
      if (!out.ok) throw new Error("create failed");
      const res = await resolveDirectoryShare(out.token);
      let docs = await listDocsUnderShare(res!.shareId);
      expect(docs.map((d) => d.slug)).not.toContain("finance-newco");

      await publishDocOk(baseDoc({ slug: "finance-newco", title: "New Co", path: "finance/deals", content: "# new" }));
      docs = await listDocsUnderShare(res!.shareId);
      expect(docs.map((d) => d.slug)).toContain("finance-newco");
    });

    it("carries title, path, updatedAt, excerpt per entry", async () => {
      const out = await createDirectoryShare("workspace", "finance", "Folder", "lucas");
      if (!out.ok) throw new Error("create failed");
      const res = await resolveDirectoryShare(out.token);
      const docs = await listDocsUnderShare(res!.shareId);
      const root = docs.find((d) => d.slug === "finance-root")!;
      expect(root.title).toBe("Finance Root");
      expect(root.path).toBe("finance");
      expect(root.updatedAt).toBeInstanceOf(Date);
      expect(root.excerpt.length).toBeGreaterThan(0);
    });
  });

  // ── resolveShareDoc (THE GUARD) ───────────────────────────────────────────
  describe("resolveShareDoc — the key guard", () => {
    it("resolves a valid published doc under the prefix → content", async () => {
      const out = await createDirectoryShare("workspace", "finance", "Folder", "lucas");
      if (!out.ok) throw new Error("create failed");
      const r = await resolveShareDoc(out.token, "finance-q3");
      expect(r).not.toBeNull();
      expect(r!.doc.slug).toBe("finance-q3");
      expect(r!.version.content).toBe("# Q3 results body");
    });

    it("slug NOT under the prefix → uniform null (marketing)", async () => {
      const out = await createDirectoryShare("workspace", "finance", "Folder", "lucas");
      if (!out.ok) throw new Error("create failed");
      expect(await resolveShareDoc(out.token, "marketing")).toBeNull();
    });

    it("financial/ decoy slug → uniform null (boundary, not raw startsWith)", async () => {
      const out = await createDirectoryShare("workspace", "finance", "Folder", "lucas");
      if (!out.ok) throw new Error("create failed");
      expect(await resolveShareDoc(out.token, "financial-decoy")).toBeNull();
    });

    it("UNPUBLISHED doc under the prefix → uniform null", async () => {
      const out = await createDirectoryShare("workspace", "finance", "Folder", "lucas");
      if (!out.ok) throw new Error("create failed");
      await unpublishDoc("finance-q3");
      expect(await resolveShareDoc(out.token, "finance-q3")).toBeNull();
    });

    it("unknown slug → uniform null", async () => {
      const out = await createDirectoryShare("workspace", "finance", "Folder", "lucas");
      if (!out.ok) throw new Error("create failed");
      expect(await resolveShareDoc(out.token, "no-such-doc")).toBeNull();
    });

    it("a doc under the prefix IS exposed via the capability link (read-boundary bypass by design)", async () => {
      // A capability link is a separate read door — the admin chose to expose the
      // folder, so every published doc under the prefix resolves through it.
      const out = await createDirectoryShare("workspace", "finance", "Folder", "lucas");
      if (!out.ok) throw new Error("create failed");
      const r = await resolveShareDoc(out.token, "finance-root");
      expect(r).not.toBeNull();
      expect(r!.doc.slug).toBe("finance-root");
    });
  });

  // ── revoked / expired token kills everything ──────────────────────────────
  describe("revoked / expired token → uniform null everywhere", () => {
    it("revoked dir token → resolveDirectoryShare + listDocs(via resolve) + resolveShareDoc all null", async () => {
      const out = await createDirectoryShare("workspace", "finance", "Folder", "lucas");
      if (!out.ok) throw new Error("create failed");
      await revokeShare(out.id);
      expect(await resolveDirectoryShare(out.token)).toBeNull();
      expect(await resolveShareDoc(out.token, "finance-q3")).toBeNull();
    });

    it("expired dir token → all null", async () => {
      const out = await createDirectoryShare("workspace", "finance", "Folder", "lucas", undefined);
      if (!out.ok) throw new Error("create failed");
      // Backdate the expiry directly.
      const { db } = await import("@/db");
      const { shares } = await import("@/db/schema");
      const { eq } = await import("drizzle-orm");
      await db.update(shares).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(shares.id, out.id));
      expect(await resolveDirectoryShare(out.token)).toBeNull();
      expect(await resolveShareDoc(out.token, "finance-q3")).toBeNull();
    });
  });

  // ── cross-mode isolation ──────────────────────────────────────────────────
  describe("cross-mode isolation", () => {
    it("resolveShare (doc resolver) returns null for a directory token", async () => {
      const out = await createDirectoryShare("workspace", "finance", "Folder", "lucas");
      if (!out.ok) throw new Error("create failed");
      expect(await resolveShare(out.token)).toBeNull();
    });

    it("resolveDirectoryShare returns null for a doc-share token", async () => {
      const { createShareOk } = await import("@/test/db");
      const docShare = await createShareOk("finance-q3", "doc link", "lucas");
      expect(await resolveDirectoryShare(docShare.token)).toBeNull();
    });

    it("resolveShareDoc returns null for a doc-share token", async () => {
      const { createShareOk } = await import("@/test/db");
      const docShare = await createShareOk("finance-q3", "doc link", "lucas");
      expect(await resolveShareDoc(docShare.token, "finance-q3")).toBeNull();
    });
  });

  // ── listShares includes mode ──────────────────────────────────────────────
  describe("listShares — mode field", () => {
    it("includes directory shares with mode='directory' and pathPrefix; doc shares stay mode='doc'", async () => {
      const { createShareOk } = await import("@/test/db");
      await createShareOk("finance-q3", "doc link", "lucas");
      await createDirectoryShare("workspace", "finance", "folder link", "lucas");

      const list = await listShares();
      const dir = list.find((s) => s.mode === "directory");
      const doc = list.find((s) => s.mode === "doc");
      expect(dir).toBeDefined();
      expect(dir!.pathPrefix).toBe("finance");
      expect(dir!.docSlug).toBeNull();
      expect(doc).toBeDefined();
      expect(doc!.docSlug).toBe("finance-q3");
      expect(doc!.pathPrefix).toBeNull();
    });
  });
});
