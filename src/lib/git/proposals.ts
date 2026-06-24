/**
 * Proposals (PR) service — the E2 review surface (External Collaboration, Slice
 * E2). A `proposals/<name>` ref on a space's bare repo IS a proposal: a non-owner
 * writer's contribution that, in `proposal` push-policy mode, the transport
 * routed away from `main` (push-policy.ts). The owner reviews the diff and
 * ACCEPTS (server-side merge into `main` → reindex → delete the ref) or REJECTS
 * (delete the ref).
 *
 * Truth stays in git (architecture §2): a proposal is just a branch; this module
 * reads/merges/deletes refs on the bare repo and lets the existing indexer
 * re-project `main`. AUTH-SENSITIVE on the WRITE side (accept mutates `main`) —
 * the caller (route / MCP) gates accept/reject to owner-or-admin; this module
 * assumes that gate already passed (it is the git-plumbing layer, mirroring
 * lib/git/repo.ts's "nothing here makes an access decision" note).
 *
 * MERGE IN A BARE REPO: a bare repo has no worktree, so `git merge` can't run in
 * place. Accept uses a TEMPORARY worktree (`git worktree add`): check out `main`,
 * merge the proposal tip (fast-forward when possible, else a merge commit
 * authored by the accepting owner), push the new `main` back into the bare repo
 * (it's the same object store — the worktree IS the bare repo's worktree, so the
 * ref move is local), then remove the worktree. A conflicting merge aborts
 * cleanly and reports `conflict` without touching `main`.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runGit, refTip, DEFAULT_BRANCH } from "./repo";
import {
  PROPOSALS_PREFIX,
  proposalRef,
  isValidProposalName,
} from "./push-policy";

export type ProposalItem = {
  /** The `<name>` in refs/heads/proposals/<name>. */
  name: string;
  /** The full ref. */
  ref: string;
  /** The proposal branch tip sha. */
  tipSha: string;
  /** The pusher recorded in the tip commit (committer name — REMOTE_USER is the
   * user id; the commit author/committer is what the client set). Best-effort. */
  pusher: string;
  /** Tip commit subject (first line) — a cheap "what is this" for the list. */
  subject: string;
  /** Tip commit timestamp (author date) as an ISO string. */
  createdAt: string;
};

/**
 * List every `proposals/*` ref on a space's bare repo, newest-first by tip
 * commit date. Returns [] for a repo with no proposals (or no commits). Pure
 * read; no access decision (the caller scopes who may see the list).
 */
export async function listProposals(repoPath: string): Promise<ProposalItem[]> {
  // for-each-ref with a NUL-delimited custom format keeps parsing robust against
  // odd subjects. Fields: refname, objectname, committername, subject, authordate.
  const r = await runGit(
    [
      "for-each-ref",
      "--format=%(refname)%00%(objectname)%00%(committername)%00%(contents:subject)%00%(authordate:iso-strict)%01",
      "refs/heads/proposals/",
    ],
    { cwd: repoPath },
  );
  if (r.code !== 0) return [];
  const out: ProposalItem[] = [];
  for (const rec of r.stdout.toString("utf8").split("\x01")) {
    const line = rec.replace(/^\n/, "");
    if (!line.trim()) continue;
    const [refname, objectname, committername, subject, authordate] = line.split("\x00");
    if (!refname || !objectname) continue;
    const name = refname.slice(PROPOSALS_PREFIX.length);
    if (!isValidProposalName(name)) continue; // ignore malformed refs defensively
    out.push({
      name,
      ref: refname,
      tipSha: objectname,
      pusher: committername || "unknown",
      subject: subject || "",
      createdAt: authordate || "",
    });
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return out;
}

/** Fetch one proposal by name, or null when it doesn't exist / is malformed. */
export async function getProposal(
  repoPath: string,
  name: string,
): Promise<ProposalItem | null> {
  if (!isValidProposalName(name)) return null;
  const all = await listProposals(repoPath);
  return all.find((p) => p.name === name) ?? null;
}

/**
 * The merge-base of `main` and the proposal tip — the diff base (the spec's
 * `merge-base(main, proposal)..proposal`). Null when there's no common ancestor
 * (e.g. an orphan proposal, or `main` has no commits — a first-ever push as a
 * proposal). Callers diff `base..tip` (or, when base is null, the whole tip
 * tree).
 */
export async function mergeBaseWithMain(
  repoPath: string,
  tipSha: string,
): Promise<string | null> {
  const mainTip = await refTip(repoPath, DEFAULT_BRANCH);
  if (mainTip === null) return null; // no main yet → diff the whole tree
  const r = await runGit(["merge-base", mainTip, tipSha], { cwd: repoPath });
  if (r.code !== 0) return null;
  const sha = r.stdout.toString().trim();
  return sha.length > 0 ? sha : null;
}

export type ProposalDiff = {
  base: string | null; // merge-base sha, or null when main is empty
  tip: string;
  /** Unified diff text (base..tip, or the full tip tree when base is null). */
  patch: string;
  /** Per-file name + status, for a compact file list above the diff. */
  files: { path: string; status: string }[];
};

/**
 * The review diff for a proposal: `merge-base(main, proposal)..proposal` (per
 * the spec), or the whole tip tree when `main` is empty. Read-only.
 */
export async function proposalDiff(
  repoPath: string,
  name: string,
): Promise<ProposalDiff | null> {
  const p = await getProposal(repoPath, name);
  if (!p) return null;
  const base = await mergeBaseWithMain(repoPath, p.tipSha);

  // File name-status list.
  const nameStatusArgs = base
    ? ["diff", "--name-status", "-z", "--no-renames", base, p.tipSha]
    : ["show", "--name-status", "-z", "--no-renames", "--format=", p.tipSha];
  const ns = await runGit(nameStatusArgs, { cwd: repoPath });
  const files: { path: string; status: string }[] = [];
  const toks = ns.stdout.toString("utf8").split("\0").filter(Boolean);
  for (let i = 0; i + 1 < toks.length; i += 2) {
    files.push({ status: toks[i][0], path: toks[i + 1] });
  }

  // Unified patch text.
  const patchArgs = base
    ? ["diff", "--no-color", base, p.tipSha]
    : ["show", "--no-color", "--format=", p.tipSha];
  const pr = await runGit(patchArgs, { cwd: repoPath });
  const patch = pr.stdout.toString("utf8");

  return { base, tip: p.tipSha, patch, files };
}

export type AcceptOutcome =
  | { ok: true; merged: "fast-forward" | "merge-commit"; newMainSha: string; tipSha: string }
  | { ok: false; reason: "not-found" | "conflict" | "error"; detail?: string };

/**
 * Accept a proposal: merge `proposals/<name>` into `main`, then DELETE the
 * proposal ref. The merge runs in a TEMPORARY worktree on the bare repo (a bare
 * repo has no worktree of its own). Prefers a fast-forward; otherwise creates a
 * merge commit authored + committed by `acceptedBy`. On a content conflict the
 * merge is aborted and `main` is left untouched (reason: "conflict").
 *
 * This does NOT reindex — the caller reindexes the space after a successful
 * accept (the route/MCP owns the projection refresh, mirroring the push path).
 * Returns the new `main` sha so the caller can decide what changed.
 *
 * AUTH: assumes the caller already authorized this as owner/admin.
 */
export async function acceptProposal(
  repoPath: string,
  name: string,
  acceptedBy: { name: string; email: string },
): Promise<AcceptOutcome> {
  const p = await getProposal(repoPath, name);
  if (!p) return { ok: false, reason: "not-found" };

  const mainTip = await refTip(repoPath, DEFAULT_BRANCH);

  // Identity for any merge commit (and to satisfy git when committing).
  const idEnv = {
    GIT_AUTHOR_NAME: acceptedBy.name || "Desk",
    GIT_AUTHOR_EMAIL: acceptedBy.email || "desk@localhost",
    GIT_COMMITTER_NAME: acceptedBy.name || "Desk",
    GIT_COMMITTER_EMAIL: acceptedBy.email || "desk@localhost",
  };

  // Case A: main has no commits yet — accepting just makes the proposal tip the
  // new main (a fast-forward from nothing). Plumbing only; no worktree needed.
  if (mainTip === null) {
    const upd = await runGit(
      ["update-ref", `refs/heads/${DEFAULT_BRANCH}`, p.tipSha],
      { cwd: repoPath },
    );
    if (upd.code !== 0) return { ok: false, reason: "error", detail: upd.stderr };
    await deleteRef(repoPath, proposalRef(name));
    return { ok: true, merged: "fast-forward", newMainSha: p.tipSha, tipSha: p.tipSha };
  }

  // Case B: fast-forward possible iff main is an ancestor of the proposal tip.
  const isAncestor = await runGit(
    ["merge-base", "--is-ancestor", mainTip, p.tipSha],
    { cwd: repoPath },
  );
  if (isAncestor.code === 0) {
    const upd = await runGit(
      ["update-ref", `refs/heads/${DEFAULT_BRANCH}`, p.tipSha, mainTip],
      { cwd: repoPath },
    );
    if (upd.code !== 0) return { ok: false, reason: "error", detail: upd.stderr };
    await deleteRef(repoPath, proposalRef(name));
    return { ok: true, merged: "fast-forward", newMainSha: p.tipSha, tipSha: p.tipSha };
  }

  // Case C: divergent → a real merge commit. Do it in a throwaway worktree.
  const wt = await mkdtemp(path.join(tmpdir(), "desk-merge-"));
  try {
    const add = await runGit(
      ["worktree", "add", "--quiet", "-f", wt, DEFAULT_BRANCH],
      { cwd: repoPath },
    );
    if (add.code !== 0) return { ok: false, reason: "error", detail: add.stderr };

    const merge = await runGit(
      [
        "merge",
        "--no-ff",
        "-m",
        `Accept proposal ${name}`,
        p.tipSha,
      ],
      { cwd: wt, env: idEnv },
    );
    if (merge.code !== 0) {
      // Conflict (or other merge failure) — abort and leave main untouched.
      await runGit(["merge", "--abort"], { cwd: wt });
      return { ok: false, reason: "conflict", detail: merge.stderr || merge.stdout.toString() };
    }
    const newMainSha = await refTip(repoPath, DEFAULT_BRANCH);
    if (!newMainSha) return { ok: false, reason: "error", detail: "main vanished after merge" };
    await deleteRef(repoPath, proposalRef(name));
    return { ok: true, merged: "merge-commit", newMainSha, tipSha: p.tipSha };
  } finally {
    // Remove the worktree (force — it has the merge state) and prune the admin record.
    await runGit(["worktree", "remove", "--force", wt], { cwd: repoPath }).catch(() => {});
    await runGit(["worktree", "prune"], { cwd: repoPath }).catch(() => {});
    await rm(wt, { recursive: true, force: true }).catch(() => {});
  }
}

export type RejectOutcome =
  | { ok: true }
  | { ok: false; reason: "not-found" };

/**
 * Reject a proposal: DELETE the `proposals/<name>` ref. `main` is never touched.
 * AUTH: assumes the caller already authorized this as owner/admin.
 */
export async function rejectProposal(
  repoPath: string,
  name: string,
): Promise<RejectOutcome> {
  const p = await getProposal(repoPath, name);
  if (!p) return { ok: false, reason: "not-found" };
  await deleteRef(repoPath, proposalRef(name));
  return { ok: true };
}

/** Delete a ref (best-effort; used after accept/reject). */
async function deleteRef(repoPath: string, ref: string): Promise<void> {
  await runGit(["update-ref", "-d", ref], { cwd: repoPath });
}
