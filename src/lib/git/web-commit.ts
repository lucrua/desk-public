/**
 * Web-commit primitive (Web-author, Slice W1) — the FRESH-COMMIT-FROM-NEW-BYTES
 * sibling to `acceptProposal` (proposals.ts). The proposals layer only *moves
 * refs between commits that already exist*; nothing in the codebase builds a new
 * commit from bytes a server-side caller supplies. This module does exactly that
 * and nothing more.
 *
 * Truth = the file in the space's bare git repo (architecture §2, §13). A web
 * save (new doc / edit / upload) becomes ONE real commit on a target ref. Author
 * = the user's principal; committer = `Desk <desk@localhost>` (kept distinct —
 * architecture §13.2). Concurrency is a single CAS on the ref (`update-ref <ref>
 * <new> <expected-old>`): if the tip moved since the editor loaded, the update
 * is rejected as `stale` and `main`/the target is left untouched, so the caller
 * preserves the client's draft (architecture §13.3 — no CRDT, no auto-merge).
 *
 * MECHANISM (mirrors proposals.ts:222-254): a THROWAWAY worktree -
 *   mkdtemp -> `git worktree add -f <wt> <expectedTip>` (or an empty worktree
 *   when the repo has no commits) -> write/delete files in it (binary-safe
 *   `fs.writeFile(Buffer)`) -> `git add -A` -> `git commit` with split
 *   author/committer env (GIT_AUTHOR_x / GIT_COMMITTER_x) -> CAS
 *   `git update-ref <ref> <new> <expectedTip>`. CAS failure => `stale`. The
 *   worktree is ALWAYS removed + pruned in `finally`.
 *
 * AUTH-SENSITIVE on the path side only: the WRITE-boundary (who may commit to
 * which ref under which push_policy) is the CALLER's job — this module assumes
 * the gate already passed, exactly like proposals.ts/repo.ts ("nothing here
 * makes an access decision"). What this module DOES own is the on-disk safety
 * invariant: every supplied `path` is validated against a traversal/segment
 * guard before it touches the worktree, so a malicious path can never escape it.
 */
import { mkdtemp, rm, writeFile, mkdir, rm as rmFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runGit } from "./repo";

export type CommitFilesResult =
  | { ok: true; newSha: string }
  | { ok: false; reason: "stale" | "conflict" | "error"; detail?: string };

export type FileWrite = { path: string; bytes: Buffer };

export type CommitFilesInput = {
  /** The full ref to update, e.g. "refs/heads/main" or
   * "refs/heads/proposals/<handle>". */
  ref: string;
  /** The CAS guard on the TARGET ref: the sha the caller believes `ref` points
   * at right now. `null` = the ref must currently be ABSENT (create-only). A
   * moved/created ref since the caller read it ⇒ `stale`. */
  expectedTip: string | null;
  /**
   * The commit to BUILD the new commit on top of (the worktree's starting
   * tree). Defaults to `expectedTip` — the common case (a `main` edit builds on
   * `main`'s tip; a first commit builds on nothing). It is supplied SEPARATELY
   * only when the target ref differs from the base — e.g. opening a NEW
   * `proposals/<handle>` ref off `main`'s tip: `baseCommit` = main tip,
   * `expectedTip` = null (the proposal ref does not exist yet). `null` = an
   * empty tree (the repo has no commits, or a fresh orphan branch).
   */
  baseCommit?: string | null;
  /** Files to create/overwrite (binary-safe). */
  writes: FileWrite[];
  /** Repo-relative paths to delete (optional). */
  deletes?: string[];
  author: { name: string; email: string };
  committer: { name: string; email: string };
  message: string;
};

/**
 * Validate a repo-relative path is safe to write inside the worktree. POSIX
 * segments only; no absolute path, no `.`/`..` segment, no empty/double slash,
 * no NUL or backslash. Mirrors the slug-alphabet posture of `bareRepoPath`'s
 * traversal guard (repo.ts:42), but for an arbitrary file path (so it permits
 * dots in a filename like `a.b.md`, just never a `..` SEGMENT). This is the
 * on-disk safety boundary — a rejected path NEVER reaches the worktree.
 */
export function isSafeRepoPath(p: string): boolean {
  if (typeof p !== "string") return false;
  if (p.length === 0 || p.length > 1024) return false;
  if (p.includes("\0") || p.includes("\\")) return false;
  if (p.startsWith("/")) return false; // no absolute
  // Windows drive-letter absolute (defense in depth).
  if (/^[a-zA-Z]:/.test(p)) return false;
  const segs = p.split("/");
  for (const seg of segs) {
    if (seg.length === 0) return false; // empty (leading/trailing/double slash)
    if (seg === "." || seg === "..") return false; // traversal
    // A segment may not start with '.git' as a whole segment (block writing into
    // the repo's own metadata namespace, e.g. ".git/config").
    if (seg === ".git") return false;
  }
  return true;
}

/**
 * Commit a set of file writes/deletes onto `ref`, asserting `expectedTip` via a
 * compare-and-swap on the ref. Returns the new sha on success; `stale` when the
 * CAS lost (the tip moved); `conflict`/`error` for a git-plumbing failure. Never
 * throws for an expected failure — returns the reason so the caller decides the
 * HTTP status.
 *
 * AUTH: assumes the caller already authorized this write to this ref (push-policy
 * re-applied off-transport). This is the git-plumbing layer.
 */
export async function commitFilesToRef(
  repoPath: string,
  input: CommitFilesInput,
): Promise<CommitFilesResult> {
  // 1) Validate every path BEFORE we touch disk. A single bad path fails closed —
  //    nothing is written.
  for (const w of input.writes) {
    if (!isSafeRepoPath(w.path)) {
      return { ok: false, reason: "error", detail: `unsafe path: ${w.path}` };
    }
  }
  for (const d of input.deletes ?? []) {
    if (!isSafeRepoPath(d)) {
      return { ok: false, reason: "error", detail: `unsafe path: ${d}` };
    }
  }
  if (input.writes.length === 0 && (input.deletes?.length ?? 0) === 0) {
    return { ok: false, reason: "error", detail: "no writes or deletes" };
  }

  const idEnv = {
    GIT_AUTHOR_NAME: input.author.name || "Desk",
    GIT_AUTHOR_EMAIL: input.author.email || "desk@localhost",
    GIT_COMMITTER_NAME: input.committer.name || "Desk",
    GIT_COMMITTER_EMAIL: input.committer.email || "desk@localhost",
  };

  // The tree to start from. Defaults to expectedTip (edit-on-main / first-commit);
  // distinct only when opening a new ref off another base (proposal off main).
  const baseCommit =
    input.baseCommit !== undefined ? input.baseCommit : input.expectedTip;

  const wt = await mkdtemp(path.join(tmpdir(), "desk-web-commit-"));
  // A unique throwaway branch name for the orphan (empty-base) case. The worktree
  // is detached/removed immediately after, so this branch never persists — but it
  // must be unique to avoid colliding with a concurrent web-commit.
  const orphanBranch = `desk-web-${path.basename(wt)}`;
  let worktreeAdded = false;
  let orphanBranchCreated = false;
  try {
    // 2) A throwaway worktree. With a base commit, check it out DETACHED so an
    //    EDIT re-uses every other file (delete-by-omission would otherwise wipe
    //    the tree). With no base (empty repo / a brand-new orphan ref), an
    //    `--orphan` worktree gives a working HEAD with an empty tree, so
    //    `git add -A` builds the commit from just what we write.
    if (baseCommit) {
      const add = await runGit(
        ["worktree", "add", "--quiet", "--detach", "-f", wt, baseCommit],
        { cwd: repoPath },
      );
      if (add.code !== 0) {
        // A bad/absent base is a stale base, not a server error.
        return { ok: false, reason: "stale", detail: add.stderr };
      }
      worktreeAdded = true;
    } else {
      const add = await runGit(
        ["worktree", "add", "--orphan", "-b", orphanBranch, wt],
        { cwd: repoPath },
      );
      if (add.code !== 0) {
        return { ok: false, reason: "error", detail: add.stderr };
      }
      worktreeAdded = true;
      orphanBranchCreated = true;
    }

    // 3) Apply deletes then writes inside the worktree.
    for (const d of input.deletes ?? []) {
      await rmFile(path.join(wt, d), { force: true }).catch(() => {});
    }
    for (const w of input.writes) {
      const dest = path.join(wt, w.path);
      // Defense in depth: the resolved path must stay within the worktree even
      // after symlink-free join (isSafeRepoPath already blocked `..`).
      if (!dest.startsWith(wt + path.sep) && dest !== wt) {
        return { ok: false, reason: "error", detail: `path escaped worktree: ${w.path}` };
      }
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, w.bytes);
    }

    // 4) Stage everything (adds, modifies, and the deletes) and commit.
    const addAll = await runGit(["add", "-A"], { cwd: wt });
    if (addAll.code !== 0) {
      return { ok: false, reason: "error", detail: addAll.stderr };
    }
    // Allow an empty commit? No — an edit that changes nothing should be a
    // no-op the caller can treat as success-without-move; but the spec wants one
    // commit per save, and `git commit` without --allow-empty fails on no change.
    // We pass --allow-empty so a save always yields a commit (idempotent re-save
    // is still one commit; the indexer dedups by content hash).
    const commit = await runGit(
      ["commit", "--allow-empty", "-q", "-m", input.message],
      { cwd: wt, env: idEnv },
    );
    if (commit.code !== 0) {
      return { ok: false, reason: "error", detail: commit.stderr };
    }

    // 5) Resolve the new commit sha (HEAD of the detached worktree).
    const rev = await runGit(["rev-parse", "HEAD"], { cwd: wt });
    if (rev.code !== 0) {
      return { ok: false, reason: "error", detail: rev.stderr };
    }
    const newSha = rev.stdout.toString().trim();
    if (!newSha) return { ok: false, reason: "error", detail: "no new sha" };

    // 6) CAS the ref. `update-ref <ref> <new> <old>` fails iff <ref> != <old>.
    //    With expectedTip null we create the ref only if it is still absent
    //    (old = the 40-zero sha — git's "must not exist" sentinel).
    const oldArg = input.expectedTip ?? "0000000000000000000000000000000000000000";
    const upd = await runGit(
      ["update-ref", input.ref, newSha, oldArg],
      { cwd: repoPath },
    );
    if (upd.code !== 0) {
      // CAS lost — the tip moved (or the ref appeared) since we read it.
      return { ok: false, reason: "stale", detail: upd.stderr };
    }
    return { ok: true, newSha };
  } catch (e) {
    return { ok: false, reason: "error", detail: (e as Error)?.message };
  } finally {
    if (worktreeAdded) {
      await runGit(["worktree", "remove", "--force", wt], { cwd: repoPath }).catch(() => {});
      await runGit(["worktree", "prune"], { cwd: repoPath }).catch(() => {});
    }
    // The orphan branch is an artifact of the empty-base path — delete it so it
    // never shows up as a stray branch (the commit it pointed at is preserved by
    // the target ref we CAS'd, or is unreachable on failure and will be GC'd).
    if (orphanBranchCreated) {
      await runGit(["branch", "-D", orphanBranch], { cwd: repoPath }).catch(() => {});
    }
    await rm(wt, { recursive: true, force: true }).catch(() => {});
  }
}
