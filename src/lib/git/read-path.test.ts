/**
 * Read-path integration (document-host Phase 1, §14 "Read path"): once the
 * indexer projects a git file into `docs` + `doc_versions`, the EXISTING read
 * surfaces (getDocBySlug → current version content; tier-share resolution) serve
 * the projected render of the current commit unchanged. This proves Step 6 — no
 * read-path rewrite was needed, the projection populates the same rows the hub
 * + shares already read — and §15 smoke test #3 (share shows the latest push).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resetDb, createShareOk } from "@/test/db";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
import { createSpace } from "@/lib/spaces";
import { getDocBySlug } from "@/lib/docs";
import { resolveShare } from "@/lib/shares";
import { initBareRepo, runGit } from "./repo";
import { reindexSpaceByDisk } from "./indexer";

const GIT_ENV = {
  GIT_AUTHOR_NAME: "T",
  GIT_AUTHOR_EMAIL: "t@x",
  GIT_COMMITTER_NAME: "T",
  GIT_COMMITTER_EMAIL: "t@x",
};

async function commit(bareRepo: string, files: Record<string, string>, msg: string): Promise<string> {
  const work = await mkdtemp(path.join(tmpdir(), "desk-rp-"));
  try {
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
    await runGit(["add", "-A"], { cwd: work });
    await runGit(["commit", "-m", msg], { cwd: work, env: GIT_ENV });
    await runGit(["push", "origin", "HEAD:main"], { cwd: work, env: GIT_ENV });
    const rev = await runGit(["rev-parse", "HEAD"], { cwd: work });
    return rev.stdout.toString().trim();
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

describe("document-host read path", () => {
  let dir: string;
  let bareRepo: string;

  beforeEach(async () => {
    await resetDb();
    const [owner] = await db
      .insert(schema.users)
      .values({ tokenName: "owner", displayName: "Owner", role: "admin", active: 1 })
      .returning({ id: schema.users.id });
    await createSpace("acme", owner.id, "private", "t");
    // The indexer publishes docs with audience 'private'; make it admin-visible.
    await db.insert(schema.audiences).values({ key: "private", label: "Private", memberVisible: 0 }).onConflictDoNothing();
    dir = await mkdtemp(path.join(tmpdir(), "desk-rp-data-"));
    bareRepo = path.join(dir, "acme.git");
    await initBareRepo(bareRepo);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // Identity is an opaque id now — resolve a doc's real slug by its sourcePath.
  const slugOf = async (sourcePath: string) => {
    const [d] = await db
      .select({ slug: schema.docs.slug })
      .from(schema.docs)
      .where(eq(schema.docs.sourcePath, sourcePath))
      .limit(1);
    return d.slug;
  };

  it("getDocBySlug serves git-sourced content after indexing", async () => {
    const sha = await commit(bareRepo, { "note.md": "# Note\nversion one" }, "c1");
    await reindexSpaceByDisk("acme", bareRepo, { fromSha: null, toSha: sha, actorName: "t" });

    const result = await getDocBySlug(await slugOf("note.md"), { includeUnpublished: true });
    expect(result).not.toBeNull();
    expect(result!.doc.title).toBe("Note");
    expect(result!.version?.content).toContain("version one");
  });

  it("a tier-share over an indexed doc resolves the LATEST pushed version", async () => {
    const sha1 = await commit(bareRepo, { "note.md": "# Note\nv1" }, "c1");
    await reindexSpaceByDisk("acme", bareRepo, { fromSha: null, toSha: sha1, actorName: "t" });

    // Create a live (non-pinned) share over the doc.
    const share = await createShareOk(await slugOf("note.md"), "Coworker", "t");

    // Push a new version + reindex.
    const sha2 = await commit(bareRepo, { "note.md": "# Note\nv2-updated" }, "c2");
    await reindexSpaceByDisk("acme", bareRepo, { fromSha: sha1, toSha: sha2, actorName: "t" });

    // The share resolves the doc's CURRENT version — the just-pushed v2.
    const resolved = await resolveShare(share.token);
    expect(resolved).not.toBeNull();
    expect(resolved!.version?.content).toContain("v2-updated");
  });

  it("deleting a path tombstones the doc; the share then 404s (uniform)", async () => {
    const sha1 = await commit(bareRepo, { "note.md": "# Note\nv1", "keep.md": "# Keep" }, "c1");
    await reindexSpaceByDisk("acme", bareRepo, { fromSha: null, toSha: sha1, actorName: "t" });
    const share = await createShareOk(await slugOf("note.md"), "Coworker", "t");

    // Delete note.md via a commit.
    const work = await mkdtemp(path.join(tmpdir(), "desk-rp-del-"));
    await runGit(["clone", bareRepo, work]);
    await runGit(["rm", "note.md"], { cwd: work });
    await runGit(["commit", "-m", "del"], { cwd: work, env: GIT_ENV });
    await runGit(["push", "origin", "HEAD:main"], { cwd: work, env: GIT_ENV });
    const sha2 = (await runGit(["rev-parse", "HEAD"], { cwd: work })).stdout.toString().trim();
    await rm(work, { recursive: true, force: true });

    await reindexSpaceByDisk("acme", bareRepo, { fromSha: sha1, toSha: sha2, actorName: "t" });

    const doc = await db.select().from(schema.docs).where(eq(schema.docs.sourcePath, "note.md"));
    expect(doc[0].unpublishedAt).not.toBeNull();
    // An unpublished doc's share resolves to null (uniform 404 at the route).
    const resolved = await resolveShare(share.token);
    expect(resolved).toBeNull();
  });
});
