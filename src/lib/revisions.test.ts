import { describe, it, expect, beforeEach } from "vitest";
import { resetDb, seedAudiences } from "@/test/db";
import { publishDoc, getDocBySlug, listVersions, getVersionContent } from "@/lib/docs";
import { docIdForSlug } from "@/lib/comments";
import {
  createRevision,
  listRevisions,
  getRevision,
  acceptRevision,
  rejectRevision,
  openRevisionCount,
  getRevisionBaseContent,
} from "./revisions";
import { MAX_CONTENT_CHARS, MAX_REVISION_NOTE_CHARS } from "@/lib/limits";

const BASE_DOC = {
  slug: "test-doc",
  title: "Test Doc",
  sourcePath: "os/test.md",
  audience: "team",
  format: "md" as const,
  content: "# Hello\n\noriginal body\n",
  by: "admin",
};
const HIDDEN_DOC = { ...BASE_DOC, slug: "alice-doc", audience: "alice" };
const HTML_DOC = { ...BASE_DOC, slug: "html-doc", format: "html" as const, content: "<p>hi</p>" };

const adminScope = { viewer: "admin" as const };
const memberScope = { viewer: "member" as const };

async function currentVersionId(slug: string): Promise<number> {
  const r = await getDocBySlug(slug, { includeUnpublished: true });
  return r!.version!.id;
}

describe("revisions service", () => {
  beforeEach(async () => {
    await resetDb();
    await seedAudiences();
    await publishDoc(BASE_DOC);
    await publishDoc(HIDDEN_DOC);
    await publishDoc(HTML_DOC);
  });

  describe("createRevision", () => {
    it("creates an open revision based on the doc's current version", async () => {
      const baseId = await currentVersionId("test-doc");
      const rev = await createRevision({
        slug: "test-doc",
        authorName: "Alex",
        authorKind: "member",
        scope: memberScope,
        content: "# Hello\n\nrevised body\n",
        note: "fixed the body",
      });
      expect(rev).not.toBeNull();
      expect(rev!.status).toBe("open");
      expect(rev!.baseVersionId).toBe(baseId);
      expect(rev!.authorName).toBe("Alex");
      expect(rev!.note).toBe("fixed the body");
      expect(rev!.decidedAt).toBeNull();
    });

    it("trims an empty note to null", async () => {
      const rev = await createRevision({
        slug: "test-doc",
        authorName: "Alex",
        authorKind: "member",
        scope: memberScope,
        content: "x",
        note: "   ",
      });
      expect(rev!.note).toBeNull();
    });

    it("returns null for an html doc (no editor)", async () => {
      const rev = await createRevision({
        slug: "html-doc",
        authorName: "Alex",
        authorKind: "admin",
        scope: adminScope,
        content: "<p>changed</p>",
      });
      expect(rev).toBeNull();
    });

    it("returns null for a member on a hidden-audience doc (uniform, no leak)", async () => {
      const rev = await createRevision({
        slug: "alice-doc",
        authorName: "Member",
        authorKind: "member",
        scope: memberScope,
        content: "# changed",
      });
      expect(rev).toBeNull();
    });

    it("admin CAN propose on the hidden-audience doc", async () => {
      const rev = await createRevision({
        slug: "alice-doc",
        authorName: "Admin",
        authorKind: "admin",
        scope: adminScope,
        content: "# changed",
      });
      expect(rev).not.toBeNull();
    });

    it("returns null for a missing doc", async () => {
      const rev = await createRevision({
        slug: "nope",
        authorName: "Alex",
        authorKind: "admin",
        scope: adminScope,
        content: "x",
      });
      expect(rev).toBeNull();
    });

    it("rejects empty content → null", async () => {
      expect(
        await createRevision({
          slug: "test-doc",
          authorName: "A",
          authorKind: "admin",
          scope: adminScope,
          content: "",
        }),
      ).toBeNull();
    });

    it("rejects oversize content → null", async () => {
      const big = "x".repeat(MAX_CONTENT_CHARS + 1);
      expect(
        await createRevision({
          slug: "test-doc",
          authorName: "A",
          authorKind: "admin",
          scope: adminScope,
          content: big,
        }),
      ).toBeNull();
    });

    it("accepts content exactly at the cap", async () => {
      const atCap = "x".repeat(MAX_CONTENT_CHARS);
      const rev = await createRevision({
        slug: "test-doc",
        authorName: "A",
        authorKind: "admin",
        scope: adminScope,
        content: atCap,
      });
      expect(rev).not.toBeNull();
    });

    it("rejects an oversize note → null", async () => {
      const note = "x".repeat(MAX_REVISION_NOTE_CHARS + 1);
      expect(
        await createRevision({
          slug: "test-doc",
          authorName: "A",
          authorKind: "admin",
          scope: adminScope,
          content: "x",
          note,
        }),
      ).toBeNull();
    });

    it("rejects an empty author name → null", async () => {
      expect(
        await createRevision({
          slug: "test-doc",
          authorName: "  ",
          authorKind: "admin",
          scope: adminScope,
          content: "x",
        }),
      ).toBeNull();
    });
  });

  describe("listRevisions / getRevision / openRevisionCount", () => {
    it("lists newest-first, filters by status, counts open", async () => {
      const docId = (await docIdForSlug("test-doc"))!;
      const r1 = await createRevision({
        slug: "test-doc", authorName: "A", authorKind: "admin", scope: adminScope, content: "v1",
      });
      const r2 = await createRevision({
        slug: "test-doc", authorName: "B", authorKind: "admin", scope: adminScope, content: "v2",
      });
      const all = await listRevisions(docId);
      // newest-first → r2 before r1
      expect(all.map((r) => r.id)).toEqual([r2!.id, r1!.id]);
      expect(await openRevisionCount(docId)).toBe(2);

      await rejectRevision(r1!.id);
      expect((await listRevisions(docId, { status: "open" })).map((r) => r.id)).toEqual([r2!.id]);
      expect((await listRevisions(docId, { status: "rejected" })).map((r) => r.id)).toEqual([r1!.id]);
      expect(await openRevisionCount(docId)).toBe(1);
    });

    it("getRevision returns the row or null", async () => {
      const r = await createRevision({
        slug: "test-doc", authorName: "A", authorKind: "admin", scope: adminScope, content: "x",
      });
      expect((await getRevision(r!.id))!.id).toBe(r!.id);
      expect(await getRevision(99999)).toBeNull();
    });

    it("scopes by docId", async () => {
      const docId = (await docIdForSlug("test-doc"))!;
      const otherId = (await docIdForSlug("alice-doc"))!;
      await createRevision({ slug: "test-doc", authorName: "A", authorKind: "admin", scope: adminScope, content: "on first" });
      await createRevision({ slug: "alice-doc", authorName: "A", authorKind: "admin", scope: adminScope, content: "on other" });
      expect((await listRevisions(docId)).map((r) => r.content)).toEqual(["on first"]);
      expect((await listRevisions(otherId)).map((r) => r.content)).toEqual(["on other"]);
    });
  });

  describe("acceptRevision", () => {
    it("publishes the content as a new version and marks accepted", async () => {
      const before = await listVersions("test-doc");
      const rev = await createRevision({
        slug: "test-doc", authorName: "Alex", authorKind: "member", scope: memberScope,
        content: "# Hello\n\nACCEPTED body\n",
      });
      const res = await acceptRevision(rev!.id, { by: "Dev Admin" });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.isNewVersion).toBe(true);
      expect(res.staleBase).toBe(false);

      const after = await listVersions("test-doc");
      expect(after.length).toBe(before.length + 1);
      // new current content is the revision content, published by the accepting admin
      const cur = await getDocBySlug("test-doc", { includeUnpublished: true });
      const content = await getVersionContent("test-doc", cur!.version!.id);
      expect(content).toBe("# Hello\n\nACCEPTED body\n");
      expect(after[0].publishedBy).toBe("Dev Admin");

      const persisted = await getRevision(rev!.id);
      expect(persisted!.status).toBe("accepted");
      expect(persisted!.decidedAt).not.toBeNull();
      // attribution retained on the revision row
      expect(persisted!.authorName).toBe("Alex");
    });

    it("does not change title / audience / sourcePath (content only)", async () => {
      const rev = await createRevision({
        slug: "test-doc", authorName: "A", authorKind: "admin", scope: adminScope, content: "# new",
      });
      await acceptRevision(rev!.id, { by: "Admin" });
      const doc = (await getDocBySlug("test-doc", { includeUnpublished: true }))!.doc;
      expect(doc.title).toBe("Test Doc");
      expect(doc.audience).toBe("team");
      expect(doc.sourcePath).toBe("os/test.md");
      expect(doc.format).toBe("md");
    });

    it("flags staleBase when the doc moved past the base version", async () => {
      const rev = await createRevision({
        slug: "test-doc", authorName: "A", authorKind: "admin", scope: adminScope, content: "# rev-content",
      });
      // The doc moves on after the proposal.
      await publishDoc({ ...BASE_DOC, content: "# Hello\n\nmoved on\n" });
      const res = await acceptRevision(rev!.id, { by: "Admin" });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.staleBase).toBe(true);
      // accept still applied — current content is the revision's
      const cur = await getDocBySlug("test-doc", { includeUnpublished: true });
      const content = await getVersionContent("test-doc", cur!.version!.id);
      expect(content).toBe("# rev-content");
    });

    it("unknown id → not-found", async () => {
      const res = await acceptRevision(99999, { by: "Admin" });
      expect(res).toEqual({ ok: false, reason: "not-found" });
    });

    it("double-decide → already-decided (accept then accept)", async () => {
      const rev = await createRevision({
        slug: "test-doc", authorName: "A", authorKind: "admin", scope: adminScope, content: "# x",
      });
      await acceptRevision(rev!.id, { by: "Admin" });
      const again = await acceptRevision(rev!.id, { by: "Admin" });
      expect(again).toEqual({ ok: false, reason: "already-decided" });
    });
  });

  describe("rejectRevision", () => {
    it("marks rejected with a decidedAt", async () => {
      const rev = await createRevision({
        slug: "test-doc", authorName: "A", authorKind: "admin", scope: adminScope, content: "# x",
      });
      const res = await rejectRevision(rev!.id);
      expect(res).toEqual({ ok: true });
      const persisted = await getRevision(rev!.id);
      expect(persisted!.status).toBe("rejected");
      expect(persisted!.decidedAt).not.toBeNull();
    });

    it("unknown id → not-found", async () => {
      expect(await rejectRevision(99999)).toEqual({ ok: false, reason: "not-found" });
    });

    it("reject then accept → already-decided", async () => {
      const rev = await createRevision({
        slug: "test-doc", authorName: "A", authorKind: "admin", scope: adminScope, content: "# x",
      });
      await rejectRevision(rev!.id);
      expect(await acceptRevision(rev!.id, { by: "Admin" })).toEqual({
        ok: false,
        reason: "already-decided",
      });
    });
  });

  describe("getRevisionBaseContent", () => {
    it("returns the base version's content", async () => {
      const rev = await createRevision({
        slug: "test-doc", authorName: "A", authorKind: "admin", scope: adminScope, content: "# changed",
      });
      const base = await getRevisionBaseContent(rev!);
      expect(base).toBe("# Hello\n\noriginal body\n");
    });
  });
});
