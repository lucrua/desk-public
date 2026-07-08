import { describe, it, expect, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import {
  resetDb,
  publishDocOk,
  seedUser,
  seedSpace,
  seedSpaceMember,
} from "@/test/db";
import { db, schema } from "@/db";
import { mintToken, hashToken } from "@/lib/tokens";
import { resolveShareDoc } from "./shares";
import {
  publishDoc,
  unpublishDoc,
  getDocBySlug,
  listDocs,
  listVersions,
  canSeeDocSpace,
  type PublishInput,
} from "./docs";

function sha256(content: string) {
  return createHash("sha256").update(content).digest("hex");
}

const base: PublishInput = {
  slug: "test-doc",
  title: "Test Doc",
  sourcePath: "os/test.md",
  format: "md",
  content: "# Hello\nWorld",
  by: "lucas",
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
    expect(published[0]).toHaveProperty("format");
    expect(published[0]).toHaveProperty("spaceSlug");

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

  it("publish updates title/sourcePath/format on re-publish", async () => {
    await publishDocOk(base);
    await publishDocOk({ ...base, content: "new content", title: "Updated Title" });

    const doc = await getDocBySlug("test-doc");
    expect(doc!.doc.title).toBe("Updated Title");
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

// ── Space scoping — canSeeDocSpace predicate ──────────────────────────────────
//
// Read access is space-scoped (Gen-2 consolidation): a doc is visible iff the
// principal is an admin, a member of the doc's space, the space is public/
// unlisted, or a capability share carries it. `canSeeDocSpace` is the single-doc
// predicate; the matrix below proves it fail-closed.

describe("canSeeDocSpace (space-scoped)", () => {
  let adminId: number;
  let memberId: number;
  let outsiderId: number;
  let privateSpace: number;
  let publicSpace: number;
  let unlistedSpace: number;

  beforeEach(async () => {
    await resetDb();
    adminId = await seedUser({ email: "admin@x", displayName: "Admin", role: "admin" });
    memberId = await seedUser({ email: "member@x", displayName: "Member", role: "member" });
    outsiderId = await seedUser({ email: "outsider@x", displayName: "Outsider", role: "member" });
    privateSpace = await seedSpace({ slug: "private-space", ownerId: adminId, visibility: "private" });
    publicSpace = await seedSpace({ slug: "public-space", ownerId: adminId, visibility: "public" });
    unlistedSpace = await seedSpace({ slug: "unlisted-space", ownerId: adminId, visibility: "unlisted" });
    // The member belongs to the private space; the outsider does not.
    await seedSpaceMember(privateSpace, memberId, "reader");
  });

  it("admin sees every space's docs", async () => {
    for (const s of [privateSpace, publicSpace, unlistedSpace]) {
      expect(await canSeeDocSpace("admin", s)).toBe(true);
    }
  });

  it("member sees a private space they belong to", async () => {
    expect(await canSeeDocSpace("member", privateSpace, memberId)).toBe(true);
  });

  it("non-member does NOT see a private space they're not in", async () => {
    expect(await canSeeDocSpace("member", privateSpace, outsiderId)).toBe(false);
  });

  it("any member sees a public or unlisted space (no membership needed)", async () => {
    expect(await canSeeDocSpace("member", publicSpace, outsiderId)).toBe(true);
    expect(await canSeeDocSpace("member", unlistedSpace, outsiderId)).toBe(true);
  });

  it("a member with no users row (userId null) sees only public/unlisted spaces", async () => {
    expect(await canSeeDocSpace("member", privateSpace, null)).toBe(false);
    expect(await canSeeDocSpace("member", publicSpace, null)).toBe(true);
    expect(await canSeeDocSpace("member", unlistedSpace, null)).toBe(true);
  });

  it("an unknown space id is fail-closed for a member", async () => {
    expect(await canSeeDocSpace("member", 999999, memberId)).toBe(false);
  });
});

// ── Two owners, SAME slug: the read boundary holds INDEPENDENTLY (S3, D2) ──────
//
// alice and bob each own a space named `reports` (composite key allows it). The
// space-scope read boundary is keyed on the space ID, so it resolves per-space,
// never per-slug: a member of alice's `reports` gets NO read into bob's same-slug
// `reports`, visibility is decided per-space (same slug, opposite visibility), and
// a capability share bound to one owner's space never carries the other's doc.
describe("two same-slug owners: space-scoped read boundary is isolated (S3)", () => {
  let alice: number;
  let bob: number;
  let aliceMember: number;
  let bobMember: number;
  let outsider: number;

  beforeEach(async () => {
    await resetDb();
    alice = await seedUser({ email: "alice@x", displayName: "Alice", role: "member" });
    bob = await seedUser({ email: "bob@x", displayName: "Bob", role: "member" });
    aliceMember = await seedUser({ email: "am@x", displayName: "AliceMember", role: "member" });
    bobMember = await seedUser({ email: "bm@x", displayName: "BobMember", role: "member" });
    outsider = await seedUser({ email: "out@x", displayName: "Outsider", role: "member" });
  });

  it("PRIVATE same-slug: each owner's member sees only THEIR space; cross-owner + anon fail-closed", async () => {
    const aliceReports = await seedSpace({ slug: "reports", ownerId: alice, visibility: "private" });
    const bobReports = await seedSpace({ slug: "reports", ownerId: bob, visibility: "private" });
    expect(aliceReports).not.toBe(bobReports);
    await seedSpaceMember(aliceReports, aliceMember, "reader");
    await seedSpaceMember(bobReports, bobMember, "reader");

    // admin sees both same-slug spaces.
    expect(await canSeeDocSpace("admin", aliceReports)).toBe(true);
    expect(await canSeeDocSpace("admin", bobReports)).toBe(true);

    // alice's member: sees alice/reports, NOT bob/reports.
    expect(await canSeeDocSpace("member", aliceReports, aliceMember)).toBe(true);
    expect(await canSeeDocSpace("member", bobReports, aliceMember)).toBe(false);

    // bob's member: sees bob/reports, NOT alice/reports.
    expect(await canSeeDocSpace("member", bobReports, bobMember)).toBe(true);
    expect(await canSeeDocSpace("member", aliceReports, bobMember)).toBe(false);

    // non-member + anonymous (null) → fail-closed on both (no existence leak).
    expect(await canSeeDocSpace("member", aliceReports, outsider)).toBe(false);
    expect(await canSeeDocSpace("member", bobReports, outsider)).toBe(false);
    expect(await canSeeDocSpace("member", aliceReports, null)).toBe(false);
    expect(await canSeeDocSpace("member", bobReports, null)).toBe(false);
  });

  it("SAME slug, OPPOSITE visibility: visibility is per-space, not per-slug", async () => {
    // alice's `shared` is PUBLIC; bob's `shared` is PRIVATE. An outsider member
    // sees alice's public one but NOT bob's private same-slug one.
    const alicePublic = await seedSpace({ slug: "shared", ownerId: alice, visibility: "public" });
    const bobPrivate = await seedSpace({ slug: "shared", ownerId: bob, visibility: "private" });
    expect(await canSeeDocSpace("member", alicePublic, outsider)).toBe(true);
    expect(await canSeeDocSpace("member", bobPrivate, outsider)).toBe(false);
    // ...and an UNLISTED same-slug space for a third case is likewise per-space.
    const carol = await seedUser({ email: "carol@x", displayName: "Carol", role: "member" });
    const carolUnlisted = await seedSpace({ slug: "shared", ownerId: carol, visibility: "unlisted" });
    expect(await canSeeDocSpace("member", carolUnlisted, outsider)).toBe(true);
    expect(await canSeeDocSpace("member", bobPrivate, null)).toBe(false);
  });

  it("SHARE axis: a directory share bound to alice's space never carries bob's same-slug doc", async () => {
    const aliceReports = await seedSpace({ slug: "reports", ownerId: alice, visibility: "private" });
    const bobReports = await seedSpace({ slug: "reports", ownerId: bob, visibility: "private" });

    // A published doc under `reports/` in EACH owner's same-slug space.
    const aDoc = await publishDocOk({
      ...base, slug: "alice-report", sourcePath: "reports/a.md", path: "reports",
      by: "alice", ownerUserId: alice, spaceId: aliceReports,
    });
    const bDoc = await publishDocOk({
      ...base, slug: "bob-report", sourcePath: "reports/b.md", path: "reports",
      by: "bob", ownerUserId: bob, spaceId: bobReports,
    });

    // A directory share BOUND TO ALICE'S SPACE (by id — deterministic across the
    // now-ambiguous slug), covering the `reports/` prefix.
    const token = mintToken();
    await db.insert(schema.shares).values({
      tokenHash: hashToken(token),
      docId: null,
      pathPrefix: "reports",
      spaceId: aliceReports,
      label: "Folder: reports",
      createdBy: "alice",
      allowComments: 1,
    });

    // Resolves alice's doc through the share...
    const okDoc = await resolveShareDoc(token, aDoc.slug);
    expect(okDoc?.doc.slug).toBe("alice-report");
    // ...but bob's same-slug-space doc is fail-closed (space guard → uniform null).
    expect(await resolveShareDoc(token, bDoc.slug)).toBeNull();
  });
});

// ── Space scoping — service layer (listDocs + getDocBySlug with scope) ────────

describe("docs service: space scoping via scope option", () => {
  let adminId: number;
  let memberId: number;
  let outsiderId: number;
  let privSpace: number;
  let pubSpace: number;

  beforeEach(async () => {
    await resetDb();
    adminId = await seedUser({ email: "admin@x", displayName: "Admin", role: "admin" });
    memberId = await seedUser({ email: "member@x", displayName: "Member", role: "member" });
    outsiderId = await seedUser({ email: "outsider@x", displayName: "Outsider", role: "member" });
    privSpace = await seedSpace({ slug: "priv", ownerId: adminId, visibility: "private" });
    pubSpace = await seedSpace({ slug: "pub", ownerId: adminId, visibility: "public" });
    await seedSpaceMember(privSpace, memberId, "reader");
    // A doc in the private space, a doc in the public space.
    await publishDocOk({ ...base, slug: "priv-doc", spaceId: privSpace });
    await publishDocOk({ ...base, slug: "pub-doc", spaceId: pubSpace });
  });

  it("listDocs with a member-of-private scope sees BOTH the private + public docs", async () => {
    const docs = await listDocs({ scope: { viewer: "member", userId: memberId } });
    expect(docs.map((d) => d.slug).sort()).toEqual(["priv-doc", "pub-doc"]);
  });

  it("listDocs with an outsider scope sees ONLY the public doc (private excluded)", async () => {
    const docs = await listDocs({ scope: { viewer: "member", userId: outsiderId } });
    expect(docs.map((d) => d.slug)).toEqual(["pub-doc"]);
  });

  it("listDocs with userId null sees only public/unlisted docs (fail-closed)", async () => {
    const docs = await listDocs({ scope: { viewer: "member", userId: null } });
    expect(docs.map((d) => d.slug)).toEqual(["pub-doc"]);
  });

  it("listDocs with admin scope returns every doc regardless of space", async () => {
    const docs = await listDocs({ scope: { viewer: "admin" } });
    expect(docs.map((d) => d.slug).sort()).toEqual(["priv-doc", "pub-doc"]);
  });

  it("listDocs without scope returns all published docs (backwards compatible)", async () => {
    const docs = await listDocs();
    expect(docs).toHaveLength(2);
  });

  it("getDocBySlug: outsider gets null on a private-space doc (no existence signal)", async () => {
    const result = await getDocBySlug("priv-doc", { scope: { viewer: "member", userId: outsiderId } });
    expect(result).toBeNull();
  });

  it("getDocBySlug: member-of-the-space sees the private-space doc", async () => {
    const result = await getDocBySlug("priv-doc", { scope: { viewer: "member", userId: memberId } });
    expect(result).not.toBeNull();
    expect(result!.doc.slug).toBe("priv-doc");
  });

  it("getDocBySlug: any member sees a public-space doc", async () => {
    const result = await getDocBySlug("pub-doc", { scope: { viewer: "member", userId: outsiderId } });
    expect(result).not.toBeNull();
    expect(result!.doc.slug).toBe("pub-doc");
  });

  it("getDocBySlug: admin sees the private-space doc", async () => {
    const result = await getDocBySlug("priv-doc", { scope: { viewer: "admin" } });
    expect(result).not.toBeNull();
    expect(result!.doc.slug).toBe("priv-doc");
  });

  it("getDocBySlug: a denied private doc is indistinguishable from a missing slug (both null)", async () => {
    const denied = await getDocBySlug("priv-doc", { scope: { viewer: "member", userId: outsiderId } });
    const missing = await getDocBySlug("no-such-slug", { scope: { viewer: "member", userId: outsiderId } });
    expect(denied).toBeNull();
    expect(missing).toBeNull();
  });

  it("space scope composes with includeUnpublished (outsider + unpublished private doc stays null)", async () => {
    await unpublishDoc("priv-doc");
    const result = await getDocBySlug("priv-doc", {
      includeUnpublished: true,
      scope: { viewer: "member", userId: outsiderId },
    });
    expect(result).toBeNull();
  });

  it("adding the outsider to the private space exposes the doc (list + getDocBySlug)", async () => {
    // Hidden before membership.
    expect((await listDocs({ scope: { viewer: "member", userId: outsiderId } })).map((d) => d.slug)).toEqual(["pub-doc"]);
    expect(await getDocBySlug("priv-doc", { scope: { viewer: "member", userId: outsiderId } })).toBeNull();

    await seedSpaceMember(privSpace, outsiderId, "reader");

    // Visible after membership.
    expect((await listDocs({ scope: { viewer: "member", userId: outsiderId } })).map((d) => d.slug).sort()).toEqual(["priv-doc", "pub-doc"]);
    expect(await getDocBySlug("priv-doc", { scope: { viewer: "member", userId: outsiderId } })).not.toBeNull();
  });
});
