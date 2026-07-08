/**
 * Import an existing docs repo as the first space (document-host Phase 1, §14,
 * §13.6).
 *
 * Creates a space + its bare repo, seeds an INITIAL COMMIT from the source
 * repo's GIT-TRACKED files only (so gitignored junk and untracked scratch never
 * enter), then backfills the projection by full-reindexing. This is a one-way
 * SEED, not a sync — Desk hosts the result thereafter.
 *
 * EXCLUSIONS (always, on top of the source's .gitignore — §14):
 *   - .env, .env.* (secrets)
 *   - personal/** (private working notes)
 *   - CLAUDE.local.md (private agent instructions)
 *   - .git/** and Desk's own .desk-data/** (never re-import host state)
 * Sensitive content must never become Desk's sole home (NO-BACKUPS risk, §11):
 * import is additive seeding from a repo that REMAINS the off-box backup.
 *
 * For build+test we validate against a small fixture repo, not a production
 * cutover.
 */
import { mkdtemp, rm, mkdir, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runGit, initBareRepo, DEFAULT_BRANCH } from "./repo";
import { reindexSpaceFull } from "./indexer";
import {
  createSpace,
  getSpaceBySlug,
  type SpaceVisibility,
} from "@/lib/spaces";
import { spaceRepoPath } from "@/lib/space-repo-path";

/** Patterns excluded from import regardless of the source's .gitignore. A path
 * (POSIX, repo-relative) is excluded if it matches any. */
export function isExcludedFromImport(repoPath: string): boolean {
  const p = repoPath.replace(/^\.\//, "");
  if (p === ".env" || p.startsWith(".env.") || /(^|\/)\.env(\.|$)/.test(p)) return true;
  if (p === "personal" || p.startsWith("personal/")) return true;
  if (p === "CLAUDE.local.md" || p.endsWith("/CLAUDE.local.md")) return true;
  if (p.startsWith(".git/") || p === ".git") return true;
  if (p.startsWith(".desk-data/") || p === ".desk-data") return true;
  return false;
}

/**
 * List the source repo's git-tracked files, with the import exclusions applied.
 * Uses `git ls-files` so ONLY tracked files appear (untracked + gitignored are
 * never returned). Returns repo-relative POSIX paths.
 */
export async function trackedImportFiles(sourceDir: string): Promise<string[]> {
  const r = await runGit(["ls-files", "-z"], { cwd: sourceDir });
  if (r.code !== 0) throw new Error(`git ls-files failed in ${sourceDir}: ${r.stderr}`);
  return r.stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .filter((p) => !isExcludedFromImport(p));
}

export type ImportResult = {
  spaceSlug: string;
  spaceId: number;
  repoPath: string;
  committed: number; // files in the initial commit
  excluded: number; // tracked files dropped by exclusions
  indexed: number; // docs projected
  commit: string | null;
};

/**
 * Import `sourceDir` (a git repo) as a new space. Idempotent guard: refuses if
 * the slug already exists (re-importing would need an explicit reset). The
 * initial commit's author/committer is Desk (system); content provenance lives
 * in the source repo's own history, which we do NOT carry over (a single
 * seed commit — simpler and avoids importing private history).
 */
export async function importRepoAsSpace(opts: {
  sourceDir: string;
  slug: string;
  ownerUserId: number;
  visibility?: SpaceVisibility;
  actorName?: string;
}): Promise<ImportResult> {
  const { sourceDir, slug, ownerUserId } = opts;
  const actorName = opts.actorName ?? "system";

  if (await getSpaceBySlug(slug)) {
    throw new Error(`space '${slug}' already exists — refusing to re-import`);
  }

  // Create the space row first (owner mirrored as member).
  const created = await createSpace(slug, ownerUserId, opts.visibility ?? "private", actorName);
  if (!created.ok) throw new Error(`createSpace failed: ${created.error}`);
  const space = created.space;

  const repoPath = await spaceRepoPath(space);
  await initBareRepo(repoPath);

  // Determine the included file set.
  const files = await trackedImportFiles(sourceDir);
  const allTracked = (await runGit(["ls-files", "-z"], { cwd: sourceDir })).stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  const excluded = allTracked.length - files.length;

  // Build the initial commit in a throwaway working tree, then push to the bare
  // repo. (A temp clone keeps the bare repo's reflog clean and avoids needing a
  // tree-builder.)
  const work = await mkdtemp(path.join(tmpdir(), "desk-import-"));
  let commit: string | null = null;
  try {
    await runGit(["init", `--initial-branch=${DEFAULT_BRANCH}`, work]);
    // Copy each included file (preserving its relative path) into the work tree.
    for (const rel of files) {
      const src = path.join(sourceDir, rel);
      const dst = path.join(work, rel);
      await mkdir(path.dirname(dst), { recursive: true });
      await cp(src, dst);
    }
    await runGit(["add", "-A"], { cwd: work });
    // Identify the commit deterministically (no reliance on a global gitconfig).
    const env = {
      GIT_AUTHOR_NAME: "Desk",
      GIT_AUTHOR_EMAIL: "desk@localhost",
      GIT_COMMITTER_NAME: "Desk",
      GIT_COMMITTER_EMAIL: "desk@localhost",
    };
    const commitRes = await runGit(
      ["commit", "-m", `Import ${slug} (initial seed)`, "--allow-empty"],
      { cwd: work, env },
    );
    if (commitRes.code !== 0) throw new Error(`initial commit failed: ${commitRes.stderr}`);
    // Push the seed into the bare repo's default branch.
    const push = await runGit(["push", repoPath, `HEAD:${DEFAULT_BRANCH}`], { cwd: work, env });
    if (push.code !== 0) throw new Error(`seed push failed: ${push.stderr}`);
    const rev = await runGit(["rev-parse", "HEAD"], { cwd: work });
    commit = rev.code === 0 ? rev.stdout.toString().trim() : null;
  } finally {
    await rm(work, { recursive: true, force: true });
  }

  // Backfill the projection.
  const reindex = await reindexSpaceFull(slug, repoPath, actorName);

  return {
    spaceSlug: slug,
    spaceId: space.id,
    repoPath,
    committed: files.length,
    excluded,
    indexed: reindex.indexed,
    commit,
  };
}
