import { describe, it, expect, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { resetDb, seedAudiences, publishDocOk } from "@/test/db";
import {
  publishDoc,
  unpublishDoc,
  getDocBySlug,
  listDocs,
  listVersions,
  canSeeAudience,
  type PublishInput,
} from "./docs";

function sha256(content: string) {
  return createHash("sha256").update(content).digest("hex");
}

const base: PublishInput = {
  slug: "test-doc",
  title: "Test Doc",
  sourcePath: "os/test.md",
  audience: "team",
  format: "md",
  content: "# Hello\nWorld",
  by: "admin",
};

describe("docs service", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("publish creates doc + v1, sets currentVersionId, returns isNewVersion true", async () => {
    const result = await publishDocOk(base);
    expect(result.slug).toBe("test-doc");
    expect(typeof result.versionId).toBe("number");
    expect(result.isNewVersion).toBe(true);
    expect(result.versionNumber).toBe(1);
    expect(result.isNewDoc).toBe(true);

    const doc = await getDocBySlug("test-doc");
    expect(doc).not.toBeNull();
    expect(doc!.doc.currentVersionId).toBe(result.versionId);
    expect(doc!.doc.slug).toBe("test-doc");
    expect(doc!.doc.title).toBe("Test Doc");

    const versions = await listVersions("test-doc");
    expect(versions).toHaveLength(1);
    expect(versions[0].id).toBe(result.versionId);
    expect(versions[0].contentHash).toBe(sha256(base.content));
  });

  it("republish same content → same versionId, isNewVersion false, still 1 version", async () => {
    const first = await publishDocOk(base);
    const second = await publishDocOk(base);

    expect(second.versionId).toBe(first.versionId);
    expect(second.isNewVersion).toBe(false);
    expect(second.versionNumber).toBe(1);
    expect(second.isNewDoc).toBe(false);

    const versions = await listVersions("test-doc");
    expect(versions).toHaveLength(1);
  });

  it("changed content → v2 current, 2 versions retained (newest first)", async () => {
    const first = await publishDocOk(base);
    const newContent = "# Updated\nNew content here";
    const second = await publishDocOk({ ...base, content: newContent });

    expect(second.isNewVersion).toBe(true);
    expect(second.isNewDoc).toBe(false);
    expect(second.versionNumber).toBe(2);
    expect(second.versionId).not.toBe(first.versionId);

    const doc = await getDocBySlug("test-doc");
    expect(doc!.doc.currentVersionId).toBe(second.versionId);

    const versions = await listVersions("test-doc");
    expect(versions).toHaveLength(2);
    // newest first
    expect(versions[0].id).toBe(second.versionId);
    expect(versions[1].id).toBe(first.versionId);
  });

  it("publishDoc base_version_id mismatch → conflict result (no new version)", async () => {
    const v1 = await publishDocOk(base);
    const v2 = await publishDocOk({ ...base, content: "# v2" });

    const out = await publishDoc({
      ...base,
      content: "# v3 from stale base",
      baseVersionId: v1.versionId, // stale — current is v2
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.currentVersionId).toBe(v2.versionId);
      expect(out.currentContentHash).toBe(sha256("# v2"));
    }

    // No third version was created.
    expect(await listVersions("test-doc")).toHaveLength(2);
  });

  it("publishDoc with matching base_version_id appends a new version", async () => {
    const v1 = await publishDocOk(base);
    const out = await publishDoc({
      ...base,
      content: "# v2",
      baseVersionId: v1.versionId,
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.isNewVersion).toBe(true);
  });

  it("unpublishDoc sets unpublishedAt; getDocBySlug returns null; includeUnpublished returns it", async () => {
    await publishDocOk(base);

    const ok = await unpublishDoc("test-doc");
    expect(ok).toBe(true);

    const hidden = await getDocBySlug("test-doc");
    expect(hidden).toBeNull();

    const found = await getDocBySlug("test-doc", { includeUnpublished: true });
    expect(found).not.toBeNull();
    expect(found!.doc.unpublishedAt).toBeInstanceOf(Date);
  });

  it("unpublishDoc returns false if not found", async () => {
    const ok = await unpublishDoc("does-not-exist");
    expect(ok).toBe(false);
  });

  it("republish after unpublish clears unpublishedAt", async () => {
    await publishDocOk(base);
    await unpublishDoc("test-doc");

    const hidden = await getDocBySlug("test-doc");
    expect(hidden).toBeNull();

    await publishDocOk(base);

    const visible = await getDocBySlug("test-doc");
    expect(visible).not.toBeNull();
    expect(visible!.doc.unpublishedAt).toBeNull();
  });

  it("listDocs returns published docs; admin variant includes unpublished", async () => {
    await publishDocOk(base);
    await publishDocOk({ ...base, slug: "second-doc", title: "Second Doc" });
    await unpublishDoc("second-doc");

    const published = await listDocs();
    expect(published).toHaveLength(1);
    expect(published[0].slug).toBe("test-doc");
    expect(published[0]).toHaveProperty("versionCount");
    expect(published[0]).toHaveProperty("updatedAt");
    expect(published[0]).toHaveProperty("audience");
    expect(published[0]).toHaveProperty("format");

    const all = await listDocs({ includeUnpublished: true });
    expect(all).toHaveLength(2);
  });

  it("listDocs versionCount increments with versions", async () => {
    await publishDocOk(base);
    await publishDocOk({ ...base, content: "v2 content" });

    const docs = await listDocs();
    expect(docs[0].versionCount).toBe(2);
  });

  it("listVersions does NOT include full content — only id, contentHash, publishedAt, publishedBy", async () => {
    await publishDocOk(base);
    const versions = await listVersions("test-doc");
    expect(versions[0]).not.toHaveProperty("content");
    expect(versions[0]).toHaveProperty("id");
    expect(versions[0]).toHaveProperty("contentHash");
    expect(versions[0]).toHaveProperty("publishedAt");
    expect(versions[0]).toHaveProperty("publishedBy");
  });

  it("contentHash is sha256 hex of content", async () => {
    await publishDocOk(base);
    const versions = await listVersions("test-doc");
    expect(versions[0].contentHash).toBe(sha256(base.content));
    expect(versions[0].contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("publish updates title/sourcePath/audience/format on re-publish", async () => {
    await publishDocOk(base);
    await publishDocOk({ ...base, content: "new content", title: "Updated Title", audience: "alice" });

    const doc = await getDocBySlug("test-doc");
    expect(doc!.doc.title).toBe("Updated Title");
    expect(doc!.doc.audience).toBe("alice");
  });

  it("getDocBySlug returns doc + currentVersion row", async () => {
    const { versionId } = await publishDocOk(base);
    const result = await getDocBySlug("test-doc");

    expect(result).not.toBeNull();
    expect(result!.version).not.toBeNull();
    expect(result!.version!.id).toBe(versionId);
    expect(result!.version!.content).toBe(base.content);
  });
});

// ── Audience scoping — canSeeAudience predicate ───────────────────────────────

describe("canSeeAudience (DB-driven)", () => {
  beforeEach(async () => {
    await resetDb();
    await seedAudiences([{ key: "external:Acme", label: "Acme", memberVisible: false }]);
  });

  it("admin sees every audience", async () => {
    for (const aud of ["team", "alice", "bob", "external:Acme", "any-string"]) {
      expect(await canSeeAudience("admin", aud)).toBe(true);
    }
  });

  it("member sees only member-visible audiences (team by default)", async () => {
    expect(await canSeeAudience("member", "team")).toBe(true);
    expect(await canSeeAudience("member", "alice")).toBe(false);
    expect(await canSeeAudience("member", "bob")).toBe(false);
    expect(await canSeeAudience("member", "external:Acme")).toBe(false);
    expect(await canSeeAudience("member", "unknown-key")).toBe(false);
  });

  it("flipping member_visible exposes/hides an audience for members", async () => {
    const { setAudienceMemberVisible, listAudiences } = await import("./audiences");
    const alice = (await listAudiences()).find((a) => a.key === "alice")!;

    expect(await canSeeAudience("member", "alice")).toBe(false);
    await setAudienceMemberVisible(alice.id, true);
    expect(await canSeeAudience("member", "alice")).toBe(true);
    await setAudienceMemberVisible(alice.id, false);
    expect(await canSeeAudience("member", "alice")).toBe(false);
  });
});

// ── Audience scoping — service layer (listDocs + getDocBySlug with scope) ────

describe("docs service: audience scoping via scope option", () => {
  beforeEach(async () => {
    await resetDb();
    await seedAudiences([{ key: "external:Acme", label: "Acme", memberVisible: false }]);
  });

  it("listDocs with member scope excludes alice / bob / external docs", async () => {
    await publishDocOk({ ...base, slug: "team-doc", audience: "team" });
    await publishDocOk({ ...base, slug: "alice-doc", audience: "alice" });
    await publishDocOk({ ...base, slug: "bob-doc", audience: "bob" });
    await publishDocOk({ ...base, slug: "ext-doc", audience: "external:Acme" });

    const memberDocs = await listDocs({ scope: { viewer: "member" } });
    expect(memberDocs.map((d) => d.slug)).toEqual(["team-doc"]);
  });

  it("listDocs with admin scope returns all docs regardless of audience", async () => {
    await publishDocOk({ ...base, slug: "team-doc", audience: "team" });
    await publishDocOk({ ...base, slug: "alice-doc", audience: "alice" });
    await publishDocOk({ ...base, slug: "bob-doc", audience: "bob" });

    const adminDocs = await listDocs({ scope: { viewer: "admin" } });
    expect(adminDocs).toHaveLength(3);
  });

  it("listDocs without scope returns all published docs (backwards compatible)", async () => {
    await publishDocOk({ ...base, slug: "team-doc", audience: "team" });
    await publishDocOk({ ...base, slug: "alice-doc", audience: "alice" });

    const allDocs = await listDocs();
    expect(allDocs).toHaveLength(2);
  });

  it("getDocBySlug with member scope returns null for a alice doc (no existence signal)", async () => {
    await publishDocOk({ ...base, slug: "alice-doc", audience: "alice" });

    const result = await getDocBySlug("alice-doc", { scope: { viewer: "member" } });
    expect(result).toBeNull();
  });

  it("getDocBySlug with member scope returns null for a bob doc", async () => {
    await publishDocOk({ ...base, slug: "bob-doc", audience: "bob" });

    const result = await getDocBySlug("bob-doc", { scope: { viewer: "member" } });
    expect(result).toBeNull();
  });

  it("getDocBySlug with member scope returns null for an external doc", async () => {
    await publishDocOk({ ...base, slug: "ext-doc", audience: "external:Acme" });

    const result = await getDocBySlug("ext-doc", { scope: { viewer: "member" } });
    expect(result).toBeNull();
  });

  it("getDocBySlug with member scope returns the doc for a team doc", async () => {
    await publishDocOk({ ...base, slug: "team-doc", audience: "team" });

    const result = await getDocBySlug("team-doc", { scope: { viewer: "member" } });
    expect(result).not.toBeNull();
    expect(result!.doc.slug).toBe("team-doc");
  });

  it("getDocBySlug with admin scope returns alice doc", async () => {
    await publishDocOk({ ...base, slug: "alice-doc", audience: "alice" });

    const result = await getDocBySlug("alice-doc", { scope: { viewer: "admin" } });
    expect(result).not.toBeNull();
    expect(result!.doc.slug).toBe("alice-doc");
  });

  it("getDocBySlug with member scope: null is indistinguishable from missing slug (same null)", async () => {
    await publishDocOk({ ...base, slug: "alice-doc", audience: "alice" });

    // Both audience-denied and missing-slug return null — no existence signal.
    const denied = await getDocBySlug("alice-doc", { scope: { viewer: "member" } });
    const missing = await getDocBySlug("no-such-slug", { scope: { viewer: "member" } });
    expect(denied).toBeNull();
    expect(missing).toBeNull();
  });

  it("member scope composes with includeUnpublished (member + unpublished alice doc stays null)", async () => {
    await publishDocOk({ ...base, slug: "alice-doc", audience: "alice" });
    await unpublishDoc("alice-doc");

    // Even with includeUnpublished: true, member cannot see alice docs.
    const result = await getDocBySlug("alice-doc", {
      includeUnpublished: true,
      scope: { viewer: "member" },
    });
    expect(result).toBeNull();
  });

  it("flipping member_visible exposes/hides a doc for members (listDocs + getDocBySlug)", async () => {
    const { setAudienceMemberVisible, listAudiences } = await import("./audiences");
    await publishDocOk({ ...base, slug: "alice-doc", audience: "alice" });
    const alice = (await listAudiences()).find((a) => a.key === "alice")!;

    // Hidden by default.
    expect((await listDocs({ scope: { viewer: "member" } })).map((d) => d.slug)).toEqual([]);
    expect(await getDocBySlug("alice-doc", { scope: { viewer: "member" } })).toBeNull();

    // Flip ON → member now sees it.
    await setAudienceMemberVisible(alice.id, true);
    expect((await listDocs({ scope: { viewer: "member" } })).map((d) => d.slug)).toEqual(["alice-doc"]);
    expect(await getDocBySlug("alice-doc", { scope: { viewer: "member" } })).not.toBeNull();

    // Flip OFF → hidden again.
    await setAudienceMemberVisible(alice.id, false);
    expect((await listDocs({ scope: { viewer: "member" } })).map((d) => d.slug)).toEqual([]);
    expect(await getDocBySlug("alice-doc", { scope: { viewer: "member" } })).toBeNull();
  });
});
