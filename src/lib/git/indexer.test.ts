import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq, and } from "drizzle-orm";
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
    const bySlug = Object.fromEntries(docs.map((d) => [d.slug, d]));
    expect(Object.keys(bySlug).sort()).toEqual(["os-guide", "page", "readme"]);

    // Frontmatter projected.
    const guide = bySlug["os-guide"];
    expect(guide.title).toBe("The Guide");
    expect(guide.parsedFrontmatter).toMatchObject({ title: "The Guide", tags: ["a", "b"] });
    expect(guide.path).toBe("os"); // folder derived from repo dir
    expect(guide.format).toBe("md");

    // HTML doc.
    expect(bySlug["page"].format).toBe("html");

    // currentCommit set + a version row exists.
    expect(guide.currentCommit).not.toBeNull();
    const versions = await db.select().from(schema.docVersions).where(eq(schema.docVersions.docId, guide.id));
    expect(versions.length).toBe(1);
  });

  it("is idempotent — re-running full reindex creates no new versions", async () => {
    await commitFiles(bareRepo, { "a.md": "# A\nv1" }, "init");
    await reindexSpaceFull("acme", bareRepo, "tester");
    const [doc1] = await db.select().from(schema.docs).where(eq(schema.docs.slug, "a"));
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
      .where(eq(schema.docs.slug, "a"));
    expect(aVersions.length).toBe(2); // v1 + v2

    // Delete b.md → tombstone.
    const sha3 = await commitFiles(bareRepo, {}, "c3", ["b.md"]);
    const r3 = await reindexSpaceByDisk("acme", bareRepo, { fromSha: sha2, toSha: sha3, actorName: "tester" });
    expect(r3.tombstoned).toBe(1);
    const [bDoc] = await db.select().from(schema.docs).where(eq(schema.docs.slug, "b"));
    expect(bDoc.unpublishedAt).not.toBeNull();
  });

  it("reindex of an empty repo is a clean no-op", async () => {
    const res = await reindexSpaceFull("acme", bareRepo, "tester");
    expect(res).toMatchObject({ indexed: 0, commit: null });
  });
});
