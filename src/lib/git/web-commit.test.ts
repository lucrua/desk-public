/**
 * Unit tests for the web-commit primitive (Web-author W1.1). No app socket, no
 * DB — just a real bare repo on disk + `commitFilesToRef`. Covers: new-doc on an
 * empty repo, new-doc + edit on a seeded repo, delete, CAS-stale-rejection (two
 * edits off the same base), and path-traversal rejection (nothing written
 * outside the worktree). Mirrors the skip-if-no-git shape of proposals-e2e.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { commitFilesToRef, isSafeRepoPath } from "./web-commit";
import { runGit, refTip, readBlob, listTree } from "./repo";

const run = promisify(execFile);

let HAVE_GIT = true;
try {
  await run("git", ["--version"]);
} catch {
  HAVE_GIT = false;
}

const AUTHOR = { name: "Lucas", email: "lucas@example.com" };
const COMMITTER = { name: "Desk", email: "desk@localhost" };
const MAIN = "refs/heads/main";

describe("isSafeRepoPath", () => {
  it("accepts normal repo-relative paths", () => {
    expect(isSafeRepoPath("notes.md")).toBe(true);
    expect(isSafeRepoPath("dir/sub/file.a.b.md")).toBe(true);
    expect(isSafeRepoPath("uploads/image.png")).toBe(true);
  });
  it("rejects traversal / absolute / metadata / odd paths", () => {
    expect(isSafeRepoPath("../etc/passwd")).toBe(false);
    expect(isSafeRepoPath("a/../../b")).toBe(false);
    expect(isSafeRepoPath("/etc/passwd")).toBe(false);
    expect(isSafeRepoPath("a//b")).toBe(false);
    expect(isSafeRepoPath("")).toBe(false);
    expect(isSafeRepoPath(".git/config")).toBe(false);
    expect(isSafeRepoPath("a\\b")).toBe(false);
    expect(isSafeRepoPath("a\0b")).toBe(false);
    expect(isSafeRepoPath("C:/x")).toBe(false);
  });
});

describe.skipIf(!HAVE_GIT)("commitFilesToRef", () => {
  let repoPath: string;

  async function initBare(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "desk-wc-bare-"));
    const rp = path.join(dir, "space.git");
    await run("git", ["init", "--bare", "--initial-branch=main", rp]);
    return rp;
  }

  /** Seed main with one commit via a throwaway clone (so refTip(main) is set). */
  async function seedMain(rp: string, file: string, content: string): Promise<string> {
    const work = await mkdtemp(path.join(tmpdir(), "desk-wc-seed-"));
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "Seed",
      GIT_AUTHOR_EMAIL: "s@x",
      GIT_COMMITTER_NAME: "Seed",
      GIT_COMMITTER_EMAIL: "s@x",
    };
    try {
      await run("git", ["clone", rp, work], { env });
      await writeFile(path.join(work, file), content);
      await run("git", ["add", "-A"], { cwd: work, env });
      await run("git", ["commit", "-m", "seed"], { cwd: work, env });
      await run("git", ["push", "origin", "HEAD:main"], { cwd: work, env });
    } finally {
      await rm(work, { recursive: true, force: true });
    }
    return (await refTip(rp, "main"))!;
  }

  beforeEach(async () => {
    repoPath = await initBare();
  });
  afterEach(async () => {
    await rm(path.dirname(repoPath), { recursive: true, force: true }).catch(() => {});
  });

  it("creates the first commit on an empty repo (expectedTip = null)", async () => {
    const res = await commitFilesToRef(repoPath, {
      ref: MAIN,
      expectedTip: null,
      writes: [{ path: "hello.md", bytes: Buffer.from("# Hello\nbody\n") }],
      author: AUTHOR,
      committer: COMMITTER,
      message: "create hello",
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const tip = await refTip(repoPath, "main");
      expect(tip).toBe(res.newSha);
      const blob = await readBlob(repoPath, res.newSha, "hello.md");
      expect(blob?.toString("utf8")).toContain("# Hello");
    }
  });

  it("records split author / committer identity", async () => {
    const res = await commitFilesToRef(repoPath, {
      ref: MAIN,
      expectedTip: null,
      writes: [{ path: "x.md", bytes: Buffer.from("x") }],
      author: AUTHOR,
      committer: COMMITTER,
      message: "id check",
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const show = await runGit(
        ["show", "-s", "--format=%an|%ae|%cn|%ce", res.newSha],
        { cwd: repoPath },
      );
      expect(show.stdout.toString().trim()).toBe(
        "Lucas|lucas@example.com|Desk|desk@localhost",
      );
    }
  });

  it("edits an existing doc and preserves sibling files", async () => {
    const base = await seedMain(repoPath, "a.md", "# A\nold\n");
    // add a sibling so we can prove the edit doesn't drop it
    const base2 = (
      await commitFilesToRef(repoPath, {
        ref: MAIN,
        expectedTip: base,
        writes: [{ path: "b.md", bytes: Buffer.from("# B\n") }],
        author: AUTHOR,
        committer: COMMITTER,
        message: "add b",
      })
    );
    expect(base2.ok).toBe(true);
    if (!base2.ok) return;

    const res = await commitFilesToRef(repoPath, {
      ref: MAIN,
      expectedTip: base2.newSha,
      writes: [{ path: "a.md", bytes: Buffer.from("# A\nNEW\n") }],
      author: AUTHOR,
      committer: COMMITTER,
      message: "edit a",
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const a = await readBlob(repoPath, res.newSha, "a.md");
      expect(a?.toString("utf8")).toContain("NEW");
      // b.md must survive the edit (we checked out the base tree first).
      const b = await readBlob(repoPath, res.newSha, "b.md");
      expect(b?.toString("utf8")).toContain("# B");
      const tree = await listTree(repoPath, res.newSha);
      expect(tree.map((t) => t.path).sort()).toEqual(["a.md", "b.md"]);
    }
  });

  it("commits a binary file byte-for-byte", async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
    const res = await commitFilesToRef(repoPath, {
      ref: MAIN,
      expectedTip: null,
      writes: [{ path: "img.png", bytes }],
      author: AUTHOR,
      committer: COMMITTER,
      message: "upload png",
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const out = await readBlob(repoPath, res.newSha, "img.png");
      expect(out && Buffer.compare(out, bytes)).toBe(0);
    }
  });

  it("deletes a file", async () => {
    const base = await seedMain(repoPath, "gone.md", "bye\n");
    const res = await commitFilesToRef(repoPath, {
      ref: MAIN,
      expectedTip: base,
      writes: [{ path: "kept.md", bytes: Buffer.from("kept\n") }],
      deletes: ["gone.md"],
      author: AUTHOR,
      committer: COMMITTER,
      message: "drop gone",
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(await readBlob(repoPath, res.newSha, "gone.md")).toBeNull();
      expect((await readBlob(repoPath, res.newSha, "kept.md"))?.toString()).toContain("kept");
    }
  });

  it("CAS rejects a stale write (two edits off the same base — second loses)", async () => {
    const base = await seedMain(repoPath, "doc.md", "v0\n");

    const first = await commitFilesToRef(repoPath, {
      ref: MAIN,
      expectedTip: base,
      writes: [{ path: "doc.md", bytes: Buffer.from("v1-first\n") }],
      author: AUTHOR,
      committer: COMMITTER,
      message: "first edit",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // Second edit still asserts the ORIGINAL base -> must be rejected as stale.
    const second = await commitFilesToRef(repoPath, {
      ref: MAIN,
      expectedTip: base,
      writes: [{ path: "doc.md", bytes: Buffer.from("v1-second\n") }],
      author: AUTHOR,
      committer: COMMITTER,
      message: "second edit",
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("stale");

    // The first edit must NOT be clobbered: main tip == first.newSha, content = first.
    const tip = await refTip(repoPath, "main");
    expect(tip).toBe(first.newSha);
    const content = await readBlob(repoPath, "main", "doc.md");
    expect(content?.toString("utf8")).toBe("v1-first\n");
  });

  it("rejects a path-traversal write and moves no ref", async () => {
    const base = await seedMain(repoPath, "safe.md", "safe\n");
    const before = await refTip(repoPath, "main");
    const res = await commitFilesToRef(repoPath, {
      ref: MAIN,
      expectedTip: base,
      writes: [{ path: "../escape.md", bytes: Buffer.from("nope\n") }],
      author: AUTHOR,
      committer: COMMITTER,
      message: "evil",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("error");
    // Ref unchanged.
    expect(await refTip(repoPath, "main")).toBe(before);
  });

  it("writes onto a proposals/<handle> ref without touching main", async () => {
    const base = await seedMain(repoPath, "m.md", "main\n");
    const mainBefore = await refTip(repoPath, "main");
    const res = await commitFilesToRef(repoPath, {
      ref: "refs/heads/proposals/alice",
      expectedTip: null, // the proposal ref does not exist yet (create-only)
      baseCommit: base, // but it is BASED on main's tip
      writes: [{ path: "p.md", bytes: Buffer.from("proposed\n") }],
      author: AUTHOR,
      committer: COMMITTER,
      message: "propose p",
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(await refTip(repoPath, "refs/heads/proposals/alice")).toBe(res.newSha);
      // main is untouched.
      expect(await refTip(repoPath, "main")).toBe(mainBefore);
      expect(await readBlob(repoPath, "main", "p.md")).toBeNull();
    }
  });
});
