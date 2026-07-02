import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq, and, isNull } from "drizzle-orm";
import { resetDb } from "@/test/db";
import { db, schema } from "@/db";
import { createSpace } from "@/lib/spaces";
import { initBareRepo, runGit, refTip } from "./repo";
import {
  reindexSpaceFull,
  reindexSpaceByDisk,
  slugForPath,
  isDocPath,
} from "./indexer";

const GIT_ENV = {
  GIT_AUTHOR_NAME: "T",
  GIT_AUTHOR_EMAIL: "t@x",
  GIT_COMMITTER_NAME: "T",
  GIT_COMMITTER_EMAIL: "t@x",
};

/** Build a working clone, write files, commit, and push to the bare repo.
 * Returns the new tip sha. */
async function commitFiles(
  bareRepo: string,
  files: Record<string, string>,
  msg: string,
  deletes: string[] = [],
): Promise<string> {
  const work = await mkdtemp(path.join(tmpdir(), "desk-idx-work-"));
  try {
    // Clone (empty repos clone fine); fall back to init+remote when empty.
    const clone = await runGit(["clone", bareRepo, work]);
    if (clone.code !== 0) {
      await runGit(["init", "--initial-branch=main", work]);
      await runGit(["remote", "add", "origin", bareRepo], { cwd: work });
    }
    for (const [rel, content] of Object.entries(files)) {
      const dst = path.join(work, rel);
      await mkdir(path.dirname(dst), { recursive: true });
      await writeFile(dst, content);
    }
    for (const del of deletes) {
      await runGit(["rm", del], { cwd: work });
    }
    await runGit(["add", "-A"], { cwd: work });
    await runGit(["commit", "-m", msg], { cwd: work, env: GIT_ENV });
    const push = await runGit(["push", "origin", "HEAD:main"], { cwd: work, env: GIT_ENV });
    if (push.code !== 0) throw new Error("push failed: " + push.stderr);
    const rev = await runGit(["rev-parse", "HEAD"], { cwd: work });
    return rev.stdout.toString().trim();
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

describe("git indexer — pure helpers", () => {
  it("slugForPath is deterministic + path-derived", () => {
    expect(slugForPath("os/canon/CONTEXT.md")).toBe("os-canon-context");
    expect(slugForPath("README.md")).toBe("readme");
    expect(slugForPath("a/b/c.html")).toBe("a-b-c");
  });
  it("isDocPath only matches renderable extensions", () => {
    expect(isDocPath("x.md")).toBe(true);
    expect(isDocPath("x.html")).toBe(true);
    expect(isDocPath("x.txt")).toBe(false);
    expect(isDocPath("x.png")).toBe(false);
    expect(isDocPath("registry.yml")).toBe(false);
  });
});

describe("git indexer — projection", () => {
  let dir: string;
  let bareRepo: string;

  beforeEach(async () => {
    await resetDb();
    // Owner user + space.
    const [owner] = await db
      .insert(schema.users)
      .values({ tokenName: "owner", displayName: "Owner", role: "admin", active: 1 })
      .returning({ id: schema.users.id });
    await createSpace("acme", owner.id, "private", "tester");
    dir = await mkdtemp(path.join(tmpdir(), "desk-idx-"));
    bareRepo = path.join(dir, "acme.git");
    await initBareRepo(bareRepo);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("full reindex projects renderable files, skips non-doc files, parses frontmatter", async () => {
    await commitFiles(
      bareRepo,
      {
        "README.md": "# Readme\nhello",
        "os/guide.md": "---\ntitle: The Guide\ntags: [a, b]\n---\n# Body\ntext",
        "data/registry.yml": "x: 1", // non-doc → skipped
        "page.html": "<h1>Page</h1>",
      },
      "init",
    );

    const res = await reindexSpaceFull("acme", bareRepo, "tester");
    expect(res.indexed).toBe(3); // README, guide, page
    expect(res.skipped).toBe(1); // registry.yml

    const docs = await db.select().from(schema.docs);
    // Identity is now a random opaque slug — docs are keyed by sourcePath.
    const bySource = Object.fromEntries(docs.map((d) => [d.sourcePath, d]));
    expect(Object.keys(bySource).sort()).toEqual(["README.md", "os/guide.md", "page.html"]);

    // Frontmatter projected.
    const guide = bySource["os/guide.md"];
    expect(guide.title).toBe("The Guide");
    expect(guide.parsedFrontmatter).toMatchObject({ title: "The Guide", tags: ["a", "b"] });
    expect(guide.path).toBe("os"); // folder derived from repo dir
    expect(guide.format).toBe("md");

    // HTML doc.
    expect(bySource["page.html"].format).toBe("html");

    // currentCommit set + a version row exists.
    expect(guide.currentCommit).not.toBeNull();
    const versions = await db.select().from(schema.docVersions).where(eq(schema.docVersions.docId, guide.id));
    expect(versions.length).toBe(1);
  });

  it("is idempotent — re-running full reindex creates no new versions", async () => {
    await commitFiles(bareRepo, { "a.md": "# A\nv1" }, "init");
    await reindexSpaceFull("acme", bareRepo, "tester");
    const [doc1] = await db.select().from(schema.docs).where(eq(schema.docs.sourcePath, "a.md"));
    const v1 = await db.select().from(schema.docVersions).where(eq(schema.docVersions.docId, doc1.id));

    await reindexSpaceFull("acme", bareRepo, "tester"); // again, same content
    const v2 = await db.select().from(schema.docVersions).where(eq(schema.docVersions.docId, doc1.id));
    expect(v2.length).toBe(v1.length); // no new version
  });

  it("incremental reindex: add → modify → delete", async () => {
    const sha1 = await commitFiles(bareRepo, { "a.md": "# A\nv1", "b.md": "# B" }, "c1");
    const r1 = await reindexSpaceByDisk("acme", bareRepo, { fromSha: null, toSha: sha1, actorName: "tester" });
    expect(r1.indexed).toBe(2);

    // Modify a.md, add c.md.
    const sha2 = await commitFiles(bareRepo, { "a.md": "# A\nv2", "c.md": "# C" }, "c2");
    const r2 = await reindexSpaceByDisk("acme", bareRepo, { fromSha: sha1, toSha: sha2, actorName: "tester" });
    expect(r2.indexed).toBe(2); // a (modified) + c (added)
    const aVersions = await db
      .select()
      .from(schema.docVersions)
      .innerJoin(schema.docs, eq(schema.docs.id, schema.docVersions.docId))
      .where(eq(schema.docs.sourcePath, "a.md"));
    expect(aVersions.length).toBe(2); // v1 + v2

    // Delete b.md → tombstone.
    const sha3 = await commitFiles(bareRepo, {}, "c3", ["b.md"]);
    const r3 = await reindexSpaceByDisk("acme", bareRepo, { fromSha: sha2, toSha: sha3, actorName: "tester" });
    expect(r3.tombstoned).toBe(1);
    const [bDoc] = await db.select().from(schema.docs).where(eq(schema.docs.sourcePath, "b.md"));
    expect(bDoc.unpublishedAt).not.toBeNull();
  });

  it("reindex of an empty repo is a clean no-op", async () => {
    const res = await reindexSpaceFull("acme", bareRepo, "tester");
    expect(res).toMatchObject({ indexed: 0, commit: null });
  });
});

describe("git indexer — opaque identity + collision-free projection", () => {
  let dir: string;
  let bareRepo: string;
  let acmeSpaceId: number;

  beforeEach(async () => {
    await resetDb();
    const [owner] = await db
      .insert(schema.users)
      .values({ tokenName: "owner", displayName: "Owner", role: "admin", active: 1 })
      .returning({ id: schema.users.id });
    const sp = await createSpace("acme", owner.id, "private", "tester");
    if (!sp.ok) throw new Error("createSpace failed");
    acmeSpaceId = sp.space.id;
    dir = await mkdtemp(path.join(tmpdir(), "desk-idx-id-"));
    bareRepo = path.join(dir, "acme.git");
    await initBareRepo(bareRepo);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // "Live" = projected AND still published (not tombstoned, not deleted).
  const liveDocs = () =>
    db
      .select()
      .from(schema.docs)
      .where(and(isNull(schema.docs.deletedAt), isNull(schema.docs.unpublishedAt)));
  const bySource = (sp: string) =>
    db.select().from(schema.docs).where(eq(schema.docs.sourcePath, sp)).limit(1);

  it("projects a random opaque slug, never a path-derived one", async () => {
    const sha = await commitFiles(bareRepo, { "docs/casa.md": "# Casa\nx" }, "c1");
    await reindexSpaceByDisk("acme", bareRepo, { fromSha: null, toSha: sha, actorName: "tester" });
    const [doc] = await bySource("docs/casa.md");
    expect(doc.slug).toMatch(/^[a-z0-9]{9}$/);
    expect(doc.slug).not.toContain("casa");
  });

  it("same stem, different extension → two independent docs (no shadowing)", async () => {
    const sha = await commitFiles(
      bareRepo,
      { "docs/x.md": "# MD\nmd body", "docs/x.html": "<h1>HTML</h1>" },
      "both",
    );
    await reindexSpaceByDisk("acme", bareRepo, { fromSha: null, toSha: sha, actorName: "tester" });
    const rows = await liveDocs();
    const map = Object.fromEntries(rows.map((d) => [d.sourcePath, d]));
    expect(Object.keys(map).sort()).toEqual(["docs/x.html", "docs/x.md"]);
    expect(map["docs/x.md"].format).toBe("md");
    expect(map["docs/x.html"].format).toBe("html");
    expect(map["docs/x.md"].slug).not.toBe(map["docs/x.html"].slug);
  });

  it("cross-space isolation: two spaces with the same path stay independent", async () => {
    const [owner2] = await db
      .insert(schema.users)
      .values({ tokenName: "o2", displayName: "O2", role: "admin", active: 1 })
      .returning({ id: schema.users.id });
    const sp2 = await createSpace("beta", owner2.id, "private", "tester");
    if (!sp2.ok) throw new Error("createSpace beta failed");
    const bare2 = path.join(dir, "beta.git");
    await initBareRepo(bare2);

    const shaA = await commitFiles(bareRepo, { "README.md": "# Acme readme" }, "a");
    await reindexSpaceByDisk("acme", bareRepo, { fromSha: null, toSha: shaA, actorName: "tester" });
    const shaB = await commitFiles(bare2, { "README.md": "# Beta readme" }, "b");
    await reindexSpaceByDisk("beta", bare2, { fromSha: null, toSha: shaB, actorName: "tester" });

    const rows = await db.select().from(schema.docs).where(eq(schema.docs.sourcePath, "README.md"));
    expect(rows.length).toBe(2);
    expect(new Set(rows.map((r) => r.spaceId)).size).toBe(2); // distinct spaces
    expect(new Set(rows.map((r) => r.slug)).size).toBe(2); // distinct ids
    // Acme's row is untouched by Beta's index (no cross-space write).
    const acme = rows.find((r) => r.spaceId === acmeSpaceId);
    expect(acme?.title).toBe("Acme readme");
  });

  it("rename preserves the doc id + slug (incremental)", async () => {
    const sha1 = await commitFiles(bareRepo, { "a.md": "# A\nbody one two three" }, "c1");
    await reindexSpaceByDisk("acme", bareRepo, { fromSha: null, toSha: sha1, actorName: "tester" });
    const [before] = await bySource("a.md");

    const sha2 = await commitFiles(
      bareRepo,
      { "b.md": "# A\nbody one two three" },
      "rename",
      ["a.md"],
    );
    await reindexSpaceByDisk("acme", bareRepo, { fromSha: sha1, toSha: sha2, actorName: "tester" });

    const live = await liveDocs();
    expect(live.length).toBe(1);
    expect(live[0].id).toBe(before.id);
    expect(live[0].slug).toBe(before.slug); // identity survived the move
    expect(live[0].sourcePath).toBe("b.md");
  });

  it("cross-folder move preserves id and updates the folder path", async () => {
    const sha1 = await commitFiles(bareRepo, { "a.md": "# A\nsome content here" }, "c1");
    await reindexSpaceByDisk("acme", bareRepo, { fromSha: null, toSha: sha1, actorName: "tester" });
    const [before] = await bySource("a.md");

    const sha2 = await commitFiles(
      bareRepo,
      { "moved/a.md": "# A\nsome content here" },
      "move",
      ["a.md"],
    );
    await reindexSpaceByDisk("acme", bareRepo, { fromSha: sha1, toSha: sha2, actorName: "tester" });

    const [after] = await bySource("moved/a.md");
    expect(after.id).toBe(before.id);
    expect(after.path).toBe("moved");
  });

  it("rename doc → non-doc extension tombstones the doc (no orphan)", async () => {
    const sha1 = await commitFiles(bareRepo, { "a.md": "# A\nrenamed to txt soon" }, "c1");
    await reindexSpaceByDisk("acme", bareRepo, { fromSha: null, toSha: sha1, actorName: "tester" });

    const sha2 = await commitFiles(
      bareRepo,
      { "a.txt": "# A\nrenamed to txt soon" },
      "to-txt",
      ["a.md"],
    );
    await reindexSpaceByDisk("acme", bareRepo, { fromSha: sha1, toSha: sha2, actorName: "tester" });

    const [row] = await bySource("a.md");
    expect(row.unpublishedAt).not.toBeNull(); // tombstoned, not left live
    expect((await liveDocs()).length).toBe(0);
  });
});
