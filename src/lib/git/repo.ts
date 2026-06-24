/**
 * On-disk bare-repo layout + low-level git plumbing for the document host.
 *
 * Truth lives in bare git repos on the host's disk (design-document-host.md §2,
 * §3): one per space, at
 *
 *     <DATA_DIR>/spaces/<owner-slug>/<space-slug>.git
 *
 * This module owns path construction (no traversal — segments are validated
 * slug-alphabet), bare-repo creation, and the small set of read-only git
 * commands the indexer/import need (list files at a ref, read a blob, the tip
 * sha). Everything is spawned against the SYSTEM `git` binary; we never embed a
 * git implementation. AUTH note: nothing here makes an access decision — the
 * route's middleware (resolveSpaceRole) gates every call. These helpers assume
 * the caller already authorized the space.
 */
import { spawn } from "node:child_process";
import { mkdir, access, writeFile, chmod, readdir } from "node:fs/promises";
import { constants as FS } from "node:fs";
import path from "node:path";
import { preReceivePolicyHookScript } from "./push-policy";

/** Root of all on-disk state. Configurable; defaults to <repo>/.desk-data so a
 * dev box works with zero config. Production sets DESK_DATA_DIR to a backed-up
 * volume (the NO-BACKUPS standing risk, §11 — bare repos are the canon). */
export function dataDir(): string {
  return process.env.DESK_DATA_DIR ?? path.join(process.cwd(), ".desk-data");
}

/** Directory holding every space's bare repo. */
export function spacesRoot(): string {
  return path.join(dataDir(), "spaces");
}

const SEG_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * The absolute path to a space's bare repo. Both segments MUST be slug-alphabet
 * (validated) so the join can never escape spacesRoot via `..` or a slash — a
 * hard traversal guard on the security-sensitive path.
 */
export function bareRepoPath(ownerSlug: string, spaceSlug: string): string {
  if (!SEG_RE.test(ownerSlug)) throw new Error(`invalid owner segment: ${ownerSlug}`);
  if (!SEG_RE.test(spaceSlug)) throw new Error(`invalid space segment: ${spaceSlug}`);
  return path.join(spacesRoot(), ownerSlug, `${spaceSlug}.git`);
}

/** True iff a bare repo already exists on disk at the given path. */
export async function repoExists(repoPath: string): Promise<boolean> {
  try {
    await access(path.join(repoPath, "HEAD"), FS.F_OK);
    return true;
  } catch {
    return false;
  }
}

export type GitRunResult = { code: number; stdout: Buffer; stderr: string };

/**
 * Run a git command in `cwd`, capturing stdout as a Buffer (blobs may be
 * binary) and stderr as a string. Optional `input` is written to stdin. Never
 * throws on a non-zero exit — returns the code so callers decide. `env` is
 * merged over a minimal inherited env.
 */
export function runGit(
  args: string[],
  opts: { cwd?: string; input?: Buffer | string; env?: Record<string, string | undefined> } = {},
): Promise<GitRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
    });
    const out: Buffer[] = [];
    let err = "";
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({ code: code ?? 0, stdout: Buffer.concat(out), stderr: err }),
    );
    if (opts.input != null) {
      child.stdin.write(opts.input);
    }
    child.stdin.end();
  });
}

/**
 * Initialize a bare repo at `repoPath` (idempotent — a no-op if it already
 * exists, EXCEPT the policy hook, which is always (re)installed so an existing
 * repo can't be left without the E2 write-boundary enforcement). Enables
 * `http.receivepack` so the smart-HTTP push path works, installs the
 * push-policy `pre-receive` hook (E2 enforcement — see push-policy.ts), and
 * installs the post-receive re-projection hook when `hookScript` is given.
 * Returns the repo path.
 */
export async function initBareRepo(
  repoPath: string,
  opts: { hookScript?: string } = {},
): Promise<string> {
  const alreadyExists = await repoExists(repoPath);
  if (!alreadyExists) {
    await mkdir(path.dirname(repoPath), { recursive: true });
    const init = await runGit(["init", "--bare", "--initial-branch=main", repoPath]);
    if (init.code !== 0) {
      throw new Error(`git init --bare failed: ${init.stderr}`);
    }
    // Allow receive-pack over HTTP (the auth gate is in the route middleware).
    await runGit(["config", "http.receivepack", "true"], { cwd: repoPath });
    // Accept pushes to the checked-out branch of a bare repo (no working tree).
    await runGit(["config", "receive.denyCurrentBranch", "ignore"], { cwd: repoPath });
  }
  // ALWAYS (re)install the push-policy pre-receive hook — even on an existing
  // repo — so the E2 write boundary is enforced regardless of when the repo was
  // created (the startup sweep relies on initBareRepo being safe to re-run).
  await installPolicyHook(repoPath);
  if (opts.hookScript) {
    const hookPath = path.join(repoPath, "hooks", "post-receive");
    await writeFile(hookPath, opts.hookScript, { mode: 0o755 });
    await chmod(hookPath, 0o755);
  }
  return repoPath;
}

/**
 * Install (or overwrite) the push-policy `pre-receive` hook on a bare repo — the
 * E2 enforcement point (push-policy.ts). Idempotent: writes the current hook
 * script with 0755 perms every time, so a repo always carries the latest policy
 * logic. AUTH-SENSITIVE — this is the on-disk half of the write boundary.
 */
export async function installPolicyHook(repoPath: string): Promise<void> {
  const hooksDir = path.join(repoPath, "hooks");
  await mkdir(hooksDir, { recursive: true });
  const hookPath = path.join(hooksDir, "pre-receive");
  await writeFile(hookPath, preReceivePolicyHookScript(), { mode: 0o755 });
  await chmod(hookPath, 0o755);
}

/**
 * Backfill the push-policy pre-receive hook onto EVERY existing bare repo under
 * `<DATA_DIR>/spaces/**`. Run once on server startup (instrumentation.register)
 * so spaces created before E2 — which have no policy hook — gain the write-
 * boundary enforcement without a manual touch. Best-effort + tolerant: a single
 * unreadable/odd directory is skipped, never throwing (a backfill failure must
 * not crash boot — but every failure is logged). Returns the count installed.
 */
export async function backfillPolicyHooks(): Promise<number> {
  const root = spacesRoot();
  let installed = 0;
  let ownerDirs: string[];
  try {
    ownerDirs = await readdir(root);
  } catch {
    // No spaces root yet (fresh box) — nothing to backfill.
    return 0;
  }
  for (const owner of ownerDirs) {
    const ownerPath = path.join(root, owner);
    let spaceDirs: string[];
    try {
      spaceDirs = await readdir(ownerPath);
    } catch {
      continue;
    }
    for (const space of spaceDirs) {
      if (!space.endsWith(".git")) continue;
      const repoPath = path.join(ownerPath, space);
      if (!(await repoExists(repoPath))) continue;
      try {
        await installPolicyHook(repoPath);
        installed++;
      } catch (e) {
        console.error(
          `[git] backfill policy hook failed for ${repoPath}:`,
          (e as Error)?.message,
        );
      }
    }
  }
  return installed;
}

/** The default branch ref name we host on. */
export const DEFAULT_BRANCH = "main";

/**
 * The post-receive hook script for a hosted bare repo. It POSTs to the app's
 * reindex endpoint so a push REFRESHES the projection even when it bypasses the
 * Next route (the in-route push path already re-indexes incrementally; this hook
 * is the safety net for server-side / out-of-band pushes). Best-effort: a curl
 * failure must NOT fail the push (the canon is already in git).
 *
 * `internalUrl` is the app's base URL reachable from the host (e.g.
 * http://127.0.0.1:3000); `token` authenticates the call (an admin principal
 * token). `spaceSlug` names the space to reindex.
 */
export function postReceiveHookScript(opts: {
  internalUrl: string;
  spaceSlug: string;
  token: string;
}): string {
  return [
    "#!/bin/sh",
    "# Desk document-host post-receive hook — refresh the projection on push.",
    "# Best-effort: never fail the push on a re-index error.",
    `curl -fsS -m 10 -X POST \\`,
    `  -H "Authorization: Basic $(printf 'git:%s' '${opts.token}' | base64)" \\`,
    `  "${opts.internalUrl.replace(/\/$/, "")}/api/spaces/${opts.spaceSlug}/reindex" \\`,
    "  >/dev/null 2>&1 || true",
    "",
  ].join("\n");
}

/** Resolve the current tip sha of `ref` (default HEAD). Returns null when the
 * repo has no commits yet (a freshly-initialized, never-pushed space). */
export async function refTip(repoPath: string, ref = "HEAD"): Promise<string | null> {
  const r = await runGit(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
    cwd: repoPath,
  });
  if (r.code !== 0) return null;
  const sha = r.stdout.toString().trim();
  return sha.length > 0 ? sha : null;
}

export type TreeEntry = { path: string; sha: string; mode: string };

/**
 * List every blob in the tree at `commitish` (recursive, blobs only). Paths are
 * repo-relative POSIX paths. Empty array when the repo has no commit.
 */
export async function listTree(repoPath: string, commitish: string): Promise<TreeEntry[]> {
  const r = await runGit(["ls-tree", "-r", "-z", "--full-tree", commitish], {
    cwd: repoPath,
  });
  if (r.code !== 0) return [];
  const out: TreeEntry[] = [];
  // Records are NUL-separated; each is `<mode> <type> <sha>\t<path>`.
  for (const rec of r.stdout.toString("utf8").split("\0")) {
    if (!rec) continue;
    const tab = rec.indexOf("\t");
    if (tab < 0) continue;
    const meta = rec.slice(0, tab).split(/\s+/);
    const filePath = rec.slice(tab + 1);
    if (meta.length < 3) continue;
    const [mode, type, sha] = meta;
    if (type !== "blob") continue;
    out.push({ path: filePath, sha, mode });
  }
  return out;
}

/** Read a single blob's bytes at `commitish:path`. Null when the path is absent
 * at that commit. */
export async function readBlob(
  repoPath: string,
  commitish: string,
  filePath: string,
): Promise<Buffer | null> {
  const r = await runGit(["cat-file", "blob", `${commitish}:${filePath}`], {
    cwd: repoPath,
  });
  if (r.code !== 0) return null;
  return r.stdout;
}

/**
 * The paths that CHANGED between two commits (added/modified/deleted), as a
 * {path, status} list. When `fromSha` is null (first push into an empty repo),
 * every path in `toSha`'s tree is reported as added. Used by the incremental
 * indexer.
 */
export type ChangedPath = { path: string; status: "A" | "M" | "D" };

export async function changedPaths(
  repoPath: string,
  fromSha: string | null,
  toSha: string,
): Promise<ChangedPath[]> {
  if (fromSha == null) {
    const tree = await listTree(repoPath, toSha);
    return tree.map((e) => ({ path: e.path, status: "A" as const }));
  }
  const r = await runGit(
    ["diff", "--name-status", "-z", "--no-renames", fromSha, toSha],
    { cwd: repoPath },
  );
  if (r.code !== 0) return [];
  const out: ChangedPath[] = [];
  const tokens = r.stdout.toString("utf8").split("\0").filter(Boolean);
  // With -z and --no-renames, tokens alternate: status, path, status, path…
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const statusChar = tokens[i][0];
    const filePath = tokens[i + 1];
    const status = statusChar === "A" ? "A" : statusChar === "D" ? "D" : "M";
    out.push({ path: filePath, status });
  }
  return out;
}
