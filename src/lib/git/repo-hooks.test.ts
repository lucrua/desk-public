/**
 * Tests for the E2 push-policy hook installation + backfill (repo.ts):
 *   - initBareRepo installs the pre-receive policy hook on a NEW repo,
 *   - it (re)installs it on an EXISTING repo (so a pre-E2 repo gains it),
 *   - backfillPolicyHooks sweeps every bare repo under spacesRoot and installs
 *     the hook, tolerating odd entries.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, stat, mkdir, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  initBareRepo,
  installPolicyHook,
  backfillPolicyHooks,
  bareRepoPath,
  spacesRoot,
} from "./repo";

async function hookBody(repoPath: string): Promise<string> {
  return readFile(path.join(repoPath, "hooks", "pre-receive"), "utf8");
}

describe("push-policy hook install + backfill", () => {
  let dataDir: string;
  let prev: string | undefined;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "desk-hooks-"));
    prev = process.env.DESK_DATA_DIR;
    process.env.DESK_DATA_DIR = dataDir;
  });
  afterEach(async () => {
    if (prev === undefined) delete process.env.DESK_DATA_DIR;
    else process.env.DESK_DATA_DIR = prev;
    await rm(dataDir, { recursive: true, force: true });
  });

  it("initBareRepo installs an EXECUTABLE pre-receive policy hook on a new repo", async () => {
    const repoPath = bareRepoPath("o", "s");
    await initBareRepo(repoPath);
    const body = await hookBody(repoPath);
    expect(body).toContain("DESK_PUSH_POLICY");
    expect(body).toContain("refs/heads/proposals/");
    const st = await stat(path.join(repoPath, "hooks", "pre-receive"));
    // Executable bit set (owner at least).
    expect(st.mode & 0o100).toBe(0o100);
  });

  it("initBareRepo re-installs the hook on an EXISTING repo missing it (pre-E2 repo)", async () => {
    const repoPath = bareRepoPath("o", "s2");
    await initBareRepo(repoPath);
    // Simulate a pre-E2 repo: delete the hook.
    await unlink(path.join(repoPath, "hooks", "pre-receive"));
    // Re-init must restore it.
    await initBareRepo(repoPath);
    const body = await hookBody(repoPath);
    expect(body).toContain("DESK_PUSH_POLICY");
  });

  it("installPolicyHook overwrites an existing (stale) hook with the current script", async () => {
    const repoPath = bareRepoPath("o", "s3");
    await initBareRepo(repoPath);
    await writeFile(path.join(repoPath, "hooks", "pre-receive"), "#!/bin/sh\nexit 0\n");
    await installPolicyHook(repoPath);
    const body = await hookBody(repoPath);
    expect(body).toContain("DESK_PUSH_POLICY");
  });

  it("backfillPolicyHooks installs the hook on every existing bare repo + tolerates junk", async () => {
    // Two real repos under two owners + a stray non-repo dir + a stray file.
    const a = bareRepoPath("alice", "x");
    const b = bareRepoPath("bob", "y");
    await initBareRepo(a);
    await initBareRepo(b);
    // Strip the hooks to simulate pre-E2 repos.
    await unlink(path.join(a, "hooks", "pre-receive"));
    await unlink(path.join(b, "hooks", "pre-receive"));
    // Junk: a non-.git dir and a loose file under spacesRoot/owner.
    await mkdir(path.join(spacesRoot(), "alice", "not-a-repo"), { recursive: true });
    await writeFile(path.join(spacesRoot(), "stray.txt"), "x");

    const n = await backfillPolicyHooks();
    expect(n).toBe(2);
    expect(await hookBody(a)).toContain("DESK_PUSH_POLICY");
    expect(await hookBody(b)).toContain("DESK_PUSH_POLICY");
  });

  it("backfillPolicyHooks returns 0 when there is no spaces root yet", async () => {
    // Fresh dataDir with no spaces/ dir.
    const n = await backfillPolicyHooks();
    expect(n).toBe(0);
  });
});
