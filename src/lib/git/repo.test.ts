import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runGit, changedPaths, type ChangedPath } from "./repo";

const GIT_ENV = {
  GIT_AUTHOR_NAME: "T",
  GIT_AUTHOR_EMAIL: "t@x",
  GIT_COMMITTER_NAME: "T",
  GIT_COMMITTER_EMAIL: "t@x",
};

/** Write a file into the work tree, creating parent dirs as needed. */
async function write(repo: string, rel: string, content: string): Promise<void> {
  const dst = path.join(repo, rel);
  await mkdir(path.dirname(dst), { recursive: true });
  await writeFile(dst, content);
}

/** Stage everything and commit; return the new tip sha. */
async function commit(repo: string, msg: string): Promise<string> {
  const add = await runGit(["add", "-A"], { cwd: repo });
  if (add.code !== 0) throw new Error("add failed: " + add.stderr);
  const c = await runGit(["commit", "-m", msg], { cwd: repo, env: GIT_ENV });
  if (c.code !== 0) throw new Error("commit failed: " + c.stderr);
  const rev = await runGit(["rev-parse", "HEAD"], { cwd: repo });
  return rev.stdout.toString().trim();
}

/** Find the entry for a given (new) path. */
function at(entries: ChangedPath[], p: string): ChangedPath | undefined {
  return entries.find((e) => e.path === p);
}

describe("changedPaths — -z -M parser", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(path.join(tmpdir(), "desk-repo-"));
    const init = await runGit(["init", "--initial-branch=main", repo]);
    if (init.code !== 0) throw new Error("init failed: " + init.stderr);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("reports A / M / D across two commits", async () => {
    await write(repo, "a.md", "# A\nv1");
    await write(repo, "b.md", "# B\nv1");
    const sha1 = await commit(repo, "c1");

    await write(repo, "a.md", "# A\nv2"); // modify
    await runGit(["rm", "b.md"], { cwd: repo }); // delete
    await write(repo, "c.md", "# C\nnew"); // add
    const sha2 = await commit(repo, "c2");

    const changes = await changedPaths(repo, sha1, sha2);
    expect(changes).toHaveLength(3);
    expect(at(changes, "a.md")).toEqual({ status: "M", path: "a.md" });
    expect(at(changes, "b.md")).toEqual({ status: "D", path: "b.md" });
    expect(at(changes, "c.md")).toEqual({ status: "A", path: "c.md" });
  });

  it("reports a pure `git mv` as a single R record with oldPath + path", async () => {
    await write(repo, "a.md", "# A\nsome stable body content\n");
    const sha1 = await commit(repo, "c1");

    const mv = await runGit(["mv", "a.md", "b.md"], { cwd: repo });
    if (mv.code !== 0) throw new Error("mv failed: " + mv.stderr);
    const sha2 = await commit(repo, "c2");

    const changes = await changedPaths(repo, sha1, sha2);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual({ status: "R", oldPath: "a.md", path: "b.md" });
  });

  it("DESYNC GUARD: a modify AND a rename in one commit — both parse, record after rename kept", async () => {
    await write(repo, "a.md", "# A\nstable body\n");
    await write(repo, "keep.md", "# keep\nkeepbody\n");
    const sha1 = await commit(repo, "c1");

    // Rename a.md → b.md (pure, R100) AND modify keep.md, same commit.
    const mv = await runGit(["mv", "a.md", "b.md"], { cwd: repo });
    if (mv.code !== 0) throw new Error("mv failed: " + mv.stderr);
    await write(repo, "keep.md", "# keep\nkeepbody modified\n");
    const sha2 = await commit(repo, "c2");

    const changes = await changedPaths(repo, sha1, sha2);
    // The rename record carries TWO paths; a fixed i+=2 stride desyncs here and
    // drops the record that follows the rename. Both must survive.
    expect(changes).toHaveLength(2);
    expect(at(changes, "b.md")).toEqual({ status: "R", oldPath: "a.md", path: "b.md" });
    expect(at(changes, "keep.md")).toEqual({ status: "M", path: "keep.md" });
  });

  it("detects delete + re-add of IDENTICAL bytes at a new path (one commit) as R", async () => {
    await write(repo, "a.md", "identical bytes here\n");
    const sha1 = await commit(repo, "c1");

    await runGit(["rm", "a.md"], { cwd: repo });
    await write(repo, "b.md", "identical bytes here\n"); // exact same bytes, new path
    const sha2 = await commit(repo, "c2");

    const changes = await changedPaths(repo, sha1, sha2);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual({ status: "R", oldPath: "a.md", path: "b.md" });
  });

  it("fromSha == null reports every tree path as A", async () => {
    await write(repo, "a.md", "# A");
    await write(repo, "dir/c.md", "# C");
    await write(repo, "data/registry.yml", "x: 1");
    const sha1 = await commit(repo, "c1");

    const changes = await changedPaths(repo, null, sha1);
    expect(changes).toHaveLength(3);
    expect(changes.every((c) => c.status === "A")).toBe(true);
    expect(changes.map((c) => c.path).sort()).toEqual([
      "a.md",
      "data/registry.yml",
      "dir/c.md",
    ]);
  });
});
