/**
 * Materialization backfill for legacy DB-only docs (convergence fix-pass, Slice
 * 4a — Slice-4 GitHub-mirror prep).
 *
 * Before Slice 2, a doc could be created by a DB-direct `publishDoc` that wrote
 * Postgres rows WITHOUT committing a file to git. Slice 2 converged every
 * production write onto a git commit, but pre-existing DB-only docs still have
 * NO blob at `main` in their space repo. They render fine (from the projection)
 * but are ABSENT from a fresh `git clone` — so the upcoming GitHub mirror (Slice
 * 4b) and any clone would silently omit them, and the deferred `update_doc`
 * rename-as-commit / `unpublish_doc` delete-as-commit stay blocked on them.
 *
 * `materializeDbOnlyDocs()` is the one-time boot backfill (wired into
 * `instrumentation.register`, the same best-effort/idempotent precedent as
 * `backfillShareSpaceIds` / `backfillPolicyHooks`). It commits every such doc's
 * CURRENT version content into its space repo on `main`, then the reindex the
 * commit triggers projects it (a no-op for the version row — the content hash
 * dedups against the existing current version — but it keeps the projection's
 * "built from" marker consistent).
 *
 * TRUTH DIRECTION IS ONE-WAY: this only ever fills a MISSING blob. If a blob
 * already exists at a doc's `sourcePath`, git is the source of truth and the
 * projection is NEVER written back over it — that doc is skipped.
 *
 * CHEAP ON A CLEAN INSTANCE: per space it reads the `main` tree ONCE
 * (`listTree`) into a path Set; every live doc is a Set lookup. A fully-
 * materialized space finds nothing missing → zero commits, zero per-doc git
 * spawns.
 *
 * NOT AN ACCESS DECISION: materialization is a system operation. It commits with
 * a synthetic "Desk (materialization)" author and role forced to `owner` (an
 * authoritative backfill, exactly like an accept), so it never resolves a
 * principal or membership.
 */
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { docs, docVersions, spaces, users } from "@/db/schema";
import { ownerSlugForUser } from "@/lib/spaces";
import {
  bareRepoPath,
  refTip,
  listTree,
  repoExists,
  DEFAULT_BRANCH,
} from "@/lib/git/repo";
import { isSafeRepoPath } from "@/lib/git/web-commit";
import { webAuthorCommit, type WebAuthorIdentity } from "@/lib/web-author";

export type MaterializeResult = {
  /** Spaces that held ≥1 live doc (were scanned). */
  spacesScanned: number;
  /** Spaces that received a materialization commit. */
  spacesCommitted: number;
  /** DB-only docs committed into git (one per unique missing sourcePath). */
  docsMaterialized: number;
  /** Live docs skipped because another live doc in the same space already
   *  claims their sourcePath in THIS backfill (Slice-2 collision). */
  collisions: number;
  /** Live docs skipped because they have no current version content to commit. */
  skippedNoVersion: number;
  /** Live docs skipped because their sourcePath is not a safe repo path. */
  skippedUnsafePath: number;
  /** Spaces whose commit or scan failed (logged, never thrown — best-effort). */
  errors: number;
};

/** Synthetic identity for a materialization commit. Author is distinct so the
 * git log shows a backfill; `webAuthorCommit` forces committer = Desk. The
 * `handle` is never used for routing (role is forced to `owner` → `main`). */
const MATERIALIZE_IDENTITY: WebAuthorIdentity = {
  name: "Desk (materialization)",
  email: "materialization@desk.localhost",
  handle: "materialization",
};

type LiveDocRow = {
  docId: number;
  slug: string;
  sourcePath: string;
  spaceId: number;
  currentVersionId: number | null;
  content: string | null;
  spaceSlug: string;
  spaceOwnerUserId: number;
  ownerTokenName: string | null;
  ownerEmail: string | null;
};

type SpaceGroup = { spaceSlug: string; ownerSlug: string; docs: LiveDocRow[] };

export async function materializeDbOnlyDocs(): Promise<MaterializeResult> {
  const result: MaterializeResult = {
    spacesScanned: 0,
    spacesCommitted: 0,
    docsMaterialized: 0,
    collisions: 0,
    skippedNoVersion: 0,
    skippedUnsafePath: 0,
    errors: 0,
  };

  // 1) Enumerate LIVE docs only (skip unpublished + tombstoned/deleted), joined
  //    to their space + owner (for the on-disk repo path) and their CURRENT
  //    version content. Ordered by (space, id) so grouping is contiguous and the
  //    collision "first wins" is deterministic (lowest id).
  const rows: LiveDocRow[] = await db
    .select({
      docId: docs.id,
      slug: docs.slug,
      sourcePath: docs.sourcePath,
      spaceId: docs.spaceId,
      currentVersionId: docs.currentVersionId,
      content: docVersions.content,
      spaceSlug: spaces.slug,
      spaceOwnerUserId: spaces.ownerUserId,
      ownerTokenName: users.tokenName,
      ownerEmail: users.email,
    })
    .from(docs)
    .innerJoin(spaces, eq(spaces.id, docs.spaceId))
    .innerJoin(users, eq(users.id, spaces.ownerUserId))
    .leftJoin(docVersions, eq(docVersions.id, docs.currentVersionId))
    .where(and(isNull(docs.deletedAt), isNull(docs.unpublishedAt)))
    .orderBy(docs.spaceId, docs.id);

  // 2) Group by space, deriving the owner segment ONCE per space (same function
  //    webAuthorCommit's repoPathForSpace uses → identical on-disk path).
  const bySpace = new Map<number, SpaceGroup>();
  for (const r of rows) {
    let g = bySpace.get(r.spaceId);
    if (!g) {
      const ownerSlug = ownerSlugForUser(
        { tokenName: r.ownerTokenName, email: r.ownerEmail },
        r.spaceOwnerUserId,
      );
      g = { spaceSlug: r.spaceSlug, ownerSlug, docs: [] };
      bySpace.set(r.spaceId, g);
    }
    g.docs.push(r);
  }

  // 3) Per space: read the main tree ONCE, find the DB-only docs (no blob at
  //    their sourcePath), and commit them all in ONE commit.
  for (const g of bySpace.values()) {
    result.spacesScanned++;
    try {
      const repoPath = bareRepoPath(g.ownerSlug, g.spaceSlug);
      // A space whose bare repo doesn't exist yet has no committed blobs — every
      // live doc is DB-only, and webAuthorCommit's initBareRepo creates it.
      const exists = await repoExists(repoPath);
      const tip = exists ? await refTip(repoPath, DEFAULT_BRANCH) : null;
      const existingPaths = tip
        ? new Set((await listTree(repoPath, tip)).map((e) => e.path))
        : new Set<string>();

      // Build the write set: one entry per MISSING sourcePath (Set lookups only —
      // no per-doc git spawns when nothing is missing).
      const byPath = new Map<string, { slug: string; content: string }>();
      for (const d of g.docs) {
        // A blob already exists → git is truth; NEVER overwrite it.
        if (existingPaths.has(d.sourcePath)) continue;
        if (d.currentVersionId === null || d.content == null) {
          result.skippedNoVersion++;
          continue;
        }
        if (!isSafeRepoPath(d.sourcePath)) {
          result.skippedUnsafePath++;
          console.error(
            `[materialize] space ${g.spaceSlug}: doc ${d.slug} has an unsafe sourcePath ${JSON.stringify(d.sourcePath)} — skipped`,
          );
          continue;
        }
        if (byPath.has(d.sourcePath)) {
          // Two live docs share a sourcePath in this space (the Slice-2
          // collision). Commit the first (lowest id); log + skip the rest.
          result.collisions++;
          const winner = byPath.get(d.sourcePath)!;
          console.warn(
            `[materialize] space ${g.spaceSlug}: (space, sourcePath) collision at ${d.sourcePath} — committing ${winner.slug}, skipping ${d.slug}`,
          );
          continue;
        }
        byPath.set(d.sourcePath, { slug: d.slug, content: d.content });
      }

      // Nothing missing in this space → cheap no-op (one listTree, set lookups).
      if (byPath.size === 0) continue;

      const writes = [...byPath.entries()].map(([p, v]) => ({
        path: p,
        bytes: Buffer.from(v.content, "utf8"),
      }));

      // Commit onto main (owner role → main regardless of push_policy), building
      // on the live tip we read. webAuthorCommit creates the repo if absent and
      // reindexes so the projection stays consistent.
      const commit = await webAuthorCommit(g.spaceSlug, {
        role: "owner",
        identity: MATERIALIZE_IDENTITY,
        writes,
        baseMainTip: tip,
        message: `materialize ${writes.length} legacy DB-only doc(s)`,
      });

      if (!commit.ok) {
        result.errors++;
        console.error(
          `[materialize] commit failed for space ${g.spaceSlug}: ${commit.reason}` +
            (commit.detail ? ` — ${commit.detail}` : ""),
        );
        continue;
      }
      result.spacesCommitted++;
      result.docsMaterialized += writes.length;
    } catch (e) {
      // Best-effort: one bad space (missing git, odd repo) must not crash boot.
      result.errors++;
      console.error(
        `[materialize] space ${g.spaceSlug} failed:`,
        (e as Error)?.message,
      );
    }
  }

  return result;
}
