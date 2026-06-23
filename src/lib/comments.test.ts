import { describe, it, expect, beforeEach } from "vitest";
import { resetDb, createShareOk, publishDocOk } from "@/test/db";
import { listDocs } from "@/lib/docs";
import {
  listComments,
  addComment,
  resolveComment,
  deleteComment,
  unresolvedCommentCounts,
  docIdForSlug,
} from "./comments";
import { MAX_COMMENT_CHARS } from "@/lib/limits";

const BASE_DOC = {
  slug: "test-doc",
  title: "Test Doc",
  sourcePath: "os/test.md",
  audience: "team",
  format: "md" as const,
  content: "# Hello",
  by: "lucas",
};

// Resolve the doc id + current version id for the seeded doc.
async function docHandle(slug = "test-doc") {
  const docId = (await docIdForSlug(slug))!;
  const { getDocBySlug } = await import("@/lib/docs");
  const result = await getDocBySlug(slug, { includeUnpublished: true });
  const versionId = result!.version!.id;
  return { docId, versionId };
}

describe("comments service", () => {
  beforeEach(async () => {
    await resetDb();
    await publishDocOk(BASE_DOC);
  });

  describe("addComment", () => {
    it("inserts and returns the row, trimming the body", async () => {
      const { docId, versionId } = await docHandle();
      const row = await addComment({
        docId,
        versionId,
        authorName: "Dev Admin",
        authorKind: "admin",
        body: "  hello world  ",
      });
      expect(row).not.toBeNull();
      expect(row!.body).toBe("hello world");
      expect(row!.authorKind).toBe("admin");
      expect(row!.shareId).toBeNull();
      expect(row!.resolvedAt).toBeNull();
    });

    it("rejects an empty / whitespace-only body → null", async () => {
      const { docId, versionId } = await docHandle();
      expect(
        await addComment({ docId, versionId, authorName: "A", authorKind: "admin", body: "   " }),
      ).toBeNull();
    });

    it("rejects an oversize body → null", async () => {
      const { docId, versionId } = await docHandle();
      const big = "x".repeat(MAX_COMMENT_CHARS + 1);
      expect(
        await addComment({ docId, versionId, authorName: "A", authorKind: "admin", body: big }),
      ).toBeNull();
    });

    it("accepts a body exactly at the cap", async () => {
      const { docId, versionId } = await docHandle();
      const atCap = "x".repeat(MAX_COMMENT_CHARS);
      const row = await addComment({
        docId,
        versionId,
        authorName: "A",
        authorKind: "admin",
        body: atCap,
      });
      expect(row).not.toBeNull();
      expect(row!.body.length).toBe(MAX_COMMENT_CHARS);
    });

    it("rejects an empty author name → null", async () => {
      const { docId, versionId } = await docHandle();
      expect(
        await addComment({ docId, versionId, authorName: "  ", authorKind: "admin", body: "hi" }),
      ).toBeNull();
    });

    it("stores shareId + link author kind for share-posted comments", async () => {
      const { docId, versionId } = await docHandle();
      // Make a share so the FK is satisfiable.
            const share = await createShareOk("test-doc", "Microsoft", "lucas");
      const row = await addComment({
        docId,
        versionId,
        shareId: share.id,
        authorName: "Microsoft",
        authorKind: "link:Microsoft",
        body: "from the link",
      });
      expect(row!.shareId).toBe(share.id);
      expect(row!.authorKind).toBe("link:Microsoft");
    });
  });

  describe("listComments", () => {
    it("returns comments oldest-first", async () => {
      const { docId, versionId } = await docHandle();
      await addComment({ docId, versionId, authorName: "A", authorKind: "admin", body: "first" });
      await addComment({ docId, versionId, authorName: "B", authorKind: "member", body: "second" });
      const rows = await listComments(docId);
      expect(rows.map((r) => r.body)).toEqual(["first", "second"]);
    });

    it("excludes resolved by default, includes with includeResolved", async () => {
      const { docId, versionId } = await docHandle();
      const a = await addComment({ docId, versionId, authorName: "A", authorKind: "admin", body: "open" });
      const b = await addComment({ docId, versionId, authorName: "B", authorKind: "admin", body: "done" });
      await resolveComment(b!.id);

      const open = await listComments(docId);
      expect(open.map((r) => r.body)).toEqual(["open"]);

      const all = await listComments(docId, { includeResolved: true });
      expect(all.map((r) => r.body)).toEqual(["open", "done"]);
      expect(all.find((r) => r.id === a!.id)!.resolvedAt).toBeNull();
    });

    it("scopes by docId", async () => {
      const { docId, versionId } = await docHandle();
      await publishDocOk({ ...BASE_DOC, slug: "other", content: "# Other" });
      const other = await docHandle("other");
      await addComment({ docId, versionId, authorName: "A", authorKind: "admin", body: "on first" });
      await addComment({
        docId: other.docId,
        versionId: other.versionId,
        authorName: "A",
        authorKind: "admin",
        body: "on other",
      });
      expect((await listComments(docId)).map((r) => r.body)).toEqual(["on first"]);
      expect((await listComments(other.docId)).map((r) => r.body)).toEqual(["on other"]);
    });
  });

  describe("resolveComment", () => {
    it("marks resolved and returns true", async () => {
      const { docId, versionId } = await docHandle();
      const c = await addComment({ docId, versionId, authorName: "A", authorKind: "admin", body: "x" });
      expect(await resolveComment(c!.id)).toBe(true);
      const all = await listComments(docId, { includeResolved: true });
      expect(all[0].resolvedAt).not.toBeNull();
    });

    it("unknown id → false", async () => {
      expect(await resolveComment(99999)).toBe(false);
    });

    it("re-resolving keeps the original timestamp (returns true, no move)", async () => {
      const { docId, versionId } = await docHandle();
      const c = await addComment({ docId, versionId, authorName: "A", authorKind: "admin", body: "x" });
      await resolveComment(c!.id);
      const first = (await listComments(docId, { includeResolved: true }))[0].resolvedAt;
      expect(await resolveComment(c!.id)).toBe(true);
      const second = (await listComments(docId, { includeResolved: true }))[0].resolvedAt;
      expect(second!.getTime()).toBe(first!.getTime());
    });
  });

  describe("deleteComment", () => {
    it("removes the row and returns true", async () => {
      const { docId, versionId } = await docHandle();
      const c = await addComment({ docId, versionId, authorName: "A", authorKind: "admin", body: "x" });
      expect(await deleteComment(c!.id)).toBe(true);
      expect(await listComments(docId, { includeResolved: true })).toHaveLength(0);
    });

    it("unknown id → false", async () => {
      expect(await deleteComment(99999)).toBe(false);
    });
  });

  describe("unresolvedCommentCounts + listDocs badge", () => {
    it("counts only unresolved, keyed by docId", async () => {
      const { docId, versionId } = await docHandle();
      await addComment({ docId, versionId, authorName: "A", authorKind: "admin", body: "open1" });
      const r2 = await addComment({ docId, versionId, authorName: "A", authorKind: "admin", body: "open2" });
      const r3 = await addComment({ docId, versionId, authorName: "A", authorKind: "admin", body: "done" });
      await resolveComment(r3!.id);

      const counts = await unresolvedCommentCounts();
      expect(counts.get(docId)).toBe(2);

      // listDocs carries the same number in unresolvedComments.
      const docs = await listDocs({ includeUnpublished: true });
      const row = docs.find((d) => d.slug === "test-doc")!;
      expect(row.unresolvedComments).toBe(2);

      await resolveComment(r2!.id);
      const docs2 = await listDocs({ includeUnpublished: true });
      expect(docs2.find((d) => d.slug === "test-doc")!.unresolvedComments).toBe(1);
    });

    it("docs with no comments report 0 (absent from the map)", async () => {
      const counts = await unresolvedCommentCounts();
      const id = await docIdForSlug("test-doc");
      expect(counts.get(id!)).toBeUndefined();
      const docs = await listDocs({ includeUnpublished: true });
      expect(docs.find((d) => d.slug === "test-doc")!.unresolvedComments).toBe(0);
    });
  });

  describe("docIdForSlug", () => {
    it("returns id for a known slug, null otherwise", async () => {
      expect(await docIdForSlug("test-doc")).not.toBeNull();
      expect(await docIdForSlug("nope")).toBeNull();
    });
  });
});
