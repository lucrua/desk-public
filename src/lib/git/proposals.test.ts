/**
 * Service-level tests for the proposals git-plumbing layer (lib/git/proposals.ts)
 * — list / diff / accept (ff + non-ff) / reject — driven against a real bare
 * repo seeded with the system `git` CLI (no socket / no transport). Complements
 * the transport e2e (proposals-e2e.test.ts) with finer-grained merge assertions.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { initBareRepo, refTip } from "./repo";
import {
  listProposals,
  getProposal,
  proposalDiff,
  acceptProposal,
  rejectProposal,
} from "./proposals";

const run = promisify(execFile);
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "T",
  GIT_AUTHOR_EMAIL: "t@x",
  GIT_COMMITTER_NAME: "T",
  GIT_COMMITTER_EMAIL: "t@x",
};

let HAVE_GIT = true;
try {
  await run("git", ["--version"]);
} catch {
  HAVE_GIT = false;
}

describe.skipIf(!HAVE_GIT)("proposals git-plumbing", () => {
  let root: string;
  let bare: string;

  // Helper: a throwaway working clone to push refs from.
  async function withClone(fn: (work: string) => Promise<void>): Promise<void> {
    const work = await mkdtemp(path.join(tmpdir(), "prop-work-"));
    try {
      await run("git", ["clone", bare, work], { env: GIT_ENV });
      await fn(work);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  async function commitFile(work: string, file: string, body: string, msg: string): Promise<void> {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(work, file), body);
    await run("git", ["add", "-A"], { cwd: work, env: GIT_ENV });
    await run("git", ["commit", "-m", msg], { cwd: work, env: GIT_ENV });
  }

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "prop-root-"));
    bare = path.join(root, "space.git");
    await initBareRepo(bare);
    // Seed main with a base commit + two proposals: `dv` (divergent — main moves
    // after it), and `ff` (a clean fast-forward — branched off the LATEST main
    // with no main movement after it). Order matters: create `dv`, move main,
    // THEN create `ff` so `ff` is still a true FF when accepted first.
    await withClone(async (work) => {
      await commitFile(work, "base.md", "# base\n", "seed");
      await run("git", ["push", "origin", "HEAD:main"], { cwd: work, env: GIT_ENV });

      // Divergent proposal: off the base main; main will move after it.
      await run("git", ["checkout", "-b", "dv"], { cwd: work, env: GIT_ENV });
      await commitFile(work, "dv.md", "# dv\n", "dv add");
      await run("git", ["push", "origin", "HEAD:proposals/dv"], { cwd: work, env: GIT_ENV });

      // Move main independently so `dv` is no longer a FF.
      await run("git", ["checkout", "main"], { cwd: work, env: GIT_ENV });
      await commitFile(work, "main2.md", "# main2\n", "main moves");
      await run("git", ["push", "origin", "HEAD:main"], { cwd: work, env: GIT_ENV });

      // FF proposal: branched off the CURRENT (latest) main → a true fast-forward.
      await run("git", ["checkout", "-b", "ff"], { cwd: work, env: GIT_ENV });
      await commitFile(work, "ff.md", "# ff\n", "ff add");
      await run("git", ["push", "origin", "HEAD:proposals/ff"], { cwd: work, env: GIT_ENV });
    });
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("listProposals returns both proposals, newest-first, with metadata", async () => {
    const list = await listProposals(bare);
    const names = list.map((p) => p.name).sort();
    expect(names).toEqual(["dv", "ff"]);
    for (const p of list) {
      expect(p.tipSha).toMatch(/^[0-9a-f]{40}$/);
      expect(p.ref.startsWith("refs/heads/proposals/")).toBe(true);
      expect(p.pusher.length).toBeGreaterThan(0);
    }
  });

  it("getProposal finds a known proposal, null for an unknown/malformed name", async () => {
    expect(await getProposal(bare, "ff")).not.toBeNull();
    expect(await getProposal(bare, "missing")).toBeNull();
    expect(await getProposal(bare, "../escape")).toBeNull();
  });

  it("proposalDiff returns base..tip patch + file list", async () => {
    const d = await proposalDiff(bare, "ff");
    expect(d).not.toBeNull();
    if (d) {
      expect(d.base).toMatch(/^[0-9a-f]{40}$/); // merge-base with main
      expect(d.files.some((f) => f.path === "ff.md" && f.status === "A")).toBe(true);
      expect(d.patch).toContain("ff.md");
    }
  });

  it("acceptProposal (FF) fast-forwards main + deletes the ref", async () => {
    const out = await acceptProposal(bare, "ff", { name: "Owner", email: "o@x" });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.merged).toBe("fast-forward");
    // ff.md now on main.
    const ls = await run("git", ["ls-tree", "--name-only", "main"], { cwd: bare, env: GIT_ENV });
    expect(ls.stdout).toContain("ff.md");
    // ref gone.
    expect(await getProposal(bare, "ff")).toBeNull();
  });

  it("acceptProposal (non-FF) makes a merge commit + lands both lines", async () => {
    const mainBefore = await refTip(bare, "main");
    const out = await acceptProposal(bare, "dv", { name: "Owner", email: "o@x" });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.merged).toBe("merge-commit");
      expect(out.newMainSha).not.toBe(mainBefore);
    }
    const ls = await run("git", ["ls-tree", "--name-only", "main"], { cwd: bare, env: GIT_ENV });
    expect(ls.stdout).toContain("dv.md"); // from the proposal
    expect(ls.stdout).toContain("main2.md"); // from main's independent move
    expect(await getProposal(bare, "dv")).toBeNull();
  });

  it("acceptProposal on an unknown name → not-found", async () => {
    const out = await acceptProposal(bare, "ghost", { name: "Owner", email: "o@x" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("not-found");
  });

  it("rejectProposal deletes the ref and leaves main untouched", async () => {
    // Add a fresh proposal to reject.
    await withClone(async (work) => {
      await run("git", ["checkout", "-b", "rej"], { cwd: work, env: GIT_ENV });
      await commitFile(work, "rej.md", "# rej\n", "rej add");
      await run("git", ["push", "origin", "HEAD:proposals/rej"], { cwd: work, env: GIT_ENV });
    });
    const mainBefore = await refTip(bare, "main");
    const out = await rejectProposal(bare, "rej");
    expect(out.ok).toBe(true);
    expect(await getProposal(bare, "rej")).toBeNull();
    expect(await refTip(bare, "main")).toBe(mainBefore);
    const ls = await run("git", ["ls-tree", "--name-only", "main"], { cwd: bare, env: GIT_ENV });
    expect(ls.stdout).not.toContain("rej.md");
  });

  it("rejectProposal on an unknown name → not-found", async () => {
    const out = await rejectProposal(bare, "ghost");
    expect(out.ok).toBe(false);
  });
});
