/**
 * Test helpers for the git-truth paths (Convergence fix-pass, Slice 2).
 *
 * The write-convergence work routes doc content through real git commits
 * (webAuthorCommit → commitFilesToRef). Tests that exercise those paths need:
 *   - a real `git` binary (skip gracefully when absent, like the e2e suites),
 *   - an isolated `DESK_DATA_DIR` so bare repos land in a throwaway temp dir
 *     (never the working tree), and
 *   - per-test repo isolation (the DB is reset each test, but on-disk repos
 *     persist across tests in a file — wipe them so each test starts clean).
 *
 * `HAVE_GIT` is resolved once at module load via top-level await (mirrors the
 * existing clone-push-e2e / web-author-e2e suites), so it can drive
 * `describe.skipIf(!HAVE_GIT)` at collection time.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { spacesRoot } from "@/lib/git/repo";

const run = promisify(execFile);

export const HAVE_GIT: boolean = await (async () => {
  try {
    await run("git", ["--version"]);
    return true;
  } catch {
    return false;
  }
})();

/** Point `DESK_DATA_DIR` at a fresh temp dir; returns a restore fn that puts the
 * previous value back and removes the temp dir. Call in beforeAll / afterAll. */
export async function useTempDataDir(): Promise<{ dir: string; restore: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "desk-slice2-"));
  const prev = process.env.DESK_DATA_DIR;
  process.env.DESK_DATA_DIR = dir;
  return {
    dir,
    restore: async () => {
      if (prev === undefined) delete process.env.DESK_DATA_DIR;
      else process.env.DESK_DATA_DIR = prev;
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** Remove every bare repo under the current DESK_DATA_DIR — per-test isolation
 * (the DB reset doesn't touch disk). Safe when the dir doesn't exist yet. */
export async function clearSpaceRepos(): Promise<void> {
  await rm(spacesRoot(), { recursive: true, force: true });
}

/** Clone a space's bare repo to a throwaway working tree and return the utf-8
 * content of `filePath` at HEAD (or null when the file is absent). Proves the
 * bytes are in git — retrievable by a standard client — not only in Postgres. */
export async function readFileFromClone(
  repoPath: string,
  filePath: string,
): Promise<string | null> {
  const { readFile } = await import("node:fs/promises");
  const clone = await mkdtemp(path.join(tmpdir(), "desk-clone-"));
  try {
    const res = await run("git", ["clone", "--quiet", repoPath, clone], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    void res;
    return await readFile(path.join(clone, filePath), "utf8");
  } catch {
    return null;
  } finally {
    await rm(clone, { recursive: true, force: true });
  }
}
