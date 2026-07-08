/**
 * The SINGLE source of a space's on-disk bare-repo path — derived from the
 * owner's STABLE HANDLE, never the mutable email (Owner-namespace Slice S2,
 * decision D3).
 *
 * Before S2 the path was `bareRepoPath(ownerSlugForUser(owner), slug)`, and
 * `ownerSlugForUser` is recomputed live from `users.email` (the local-part). So
 * repointing a user's primary email relocated the path and ORPHANED the existing
 * bare repo (history appeared lost). Keying the path on `users.handle` — a
 * stored, stable, unique column — decouples it from the email and fixes the bug.
 *
 * `spaceRepoPath(space)` is the ONE helper every repo-path consumer now calls
 * (web-author, proposals, mirror, materialize, import, the git transport route,
 * the raw/reindex/docs routes, the catalog reader). The derivation used to be
 * copy-pasted; it now lives here alone.
 *
 * `migrateRepoPathsToHandle()` is the one-time boot migration that re-points
 * EXISTING repos from the legacy email-derived path to the handle-derived path.
 * DATA-SENSITIVE: it MOVES canonical bare repos on disk. It is idempotent,
 * never clobbers an existing target, and logs every intended move / move / skip
 * so a boot reads like a dry-run even as it acts.
 */
import { mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { spaces, users } from "@/db/schema";
import { bareRepoPath, repoExists } from "@/lib/git/repo";
import { assignUserHandle } from "@/lib/user-handle";
import { ownerSlugForUser, type SpaceRow } from "@/lib/spaces";

/**
 * The owner's stable handle for a space's repo path. Loads `users.handle` for the
 * space's owner. If it is somehow still NULL (a pre-backfill race, or a user
 * created outside the assign-on-create paths), ASSIGN one on read
 * (`assignUserHandle`) — we NEVER silently fall back to the mutable email (that
 * is the orphan bug this slice fixes). Throws a clear error only when no handle
 * exists and none can be assigned (the owner row is gone).
 */
async function ownerHandleFor(ownerUserId: number, spaceSlug: string): Promise<string> {
  const owner = await db.query.users.findFirst({ where: eq(users.id, ownerUserId) });
  if (owner?.handle) return owner.handle;
  // Assign-on-read: derive + de-dup + persist a handle (idempotent). This keeps
  // the path stable and handle-derived even if the boot backfill hasn't run.
  const assigned = await assignUserHandle(db, ownerUserId);
  if (assigned) return assigned;
  throw new Error(
    `spaceRepoPath: owner ${ownerUserId} of space ${spaceSlug} has no handle and none could be assigned`,
  );
}

/**
 * The absolute on-disk bare-repo path for a space, derived from the owner's
 * stable `users.handle` + the space slug. This is the ONE place the derivation
 * lives (previously duplicated across web-author / proposals / mirror /
 * materialize / import / the git route). Accepts anything carrying the owner id +
 * slug so callers with a partial row (e.g. the materialize join) can use it too.
 */
export async function spaceRepoPath(
  space: Pick<SpaceRow, "ownerUserId" | "slug">,
): Promise<string> {
  const handle = await ownerHandleFor(space.ownerUserId, space.slug);
  return bareRepoPath(handle, space.slug);
}

export type MigrateRepoPathsResult = {
  /** Spaces examined. */
  scanned: number;
  /** Bare repos MOVED from the legacy email-derived path to the handle path. */
  moved: number;
  /** Spaces skipped (already handle-derived, or no repo at the legacy path). */
  skipped: number;
  /** Spaces where BOTH the legacy and target path exist — left untouched (never
   *  clobber); needs a human to reconcile. */
  conflicts: number;
  /** Spaces whose migration threw (logged, never fatal — best-effort). */
  errors: number;
};

/**
 * One-time, idempotent boot migration (wired into `instrumentation.register`
 * AFTER `backfillUserHandles` and BEFORE `materializeDbOnlyDocs`, which now
 * writes to the handle-derived path).
 *
 * For each space: compute the LEGACY path from the current email-derived owner
 * slug (`ownerSlugForUser`) and the NEW path from the stored handle. Then, only
 * when the legacy repo EXISTS, the two paths DIFFER, and the target does NOT yet
 * exist → move the directory (`fs.rename`).
 *
 * IDEMPOTENT + NON-CLOBBERING:
 *   - legacy === new (the common case, since the handle backfills from the same
 *     email local-part) → skip.
 *   - no repo at the legacy path (never created, or already moved) → skip.
 *   - BOTH paths exist (shouldn't happen) → log a conflict + skip; NEVER clobber.
 *   - a re-run after a successful move finds nothing at the legacy path → skip.
 *
 * Logs every intended move (`would move`), every completed move (`moved`), and
 * every skip/conflict with a `[migrate-repo-path]` prefix so the run is auditable
 * (reads like a dry-run even as it acts). Best-effort per space: one failure logs
 * and continues.
 */
export async function migrateRepoPathsToHandle(): Promise<MigrateRepoPathsResult> {
  const result: MigrateRepoPathsResult = {
    scanned: 0,
    moved: 0,
    skipped: 0,
    conflicts: 0,
    errors: 0,
  };

  const rows = await db
    .select({
      slug: spaces.slug,
      ownerUserId: spaces.ownerUserId,
      handle: users.handle,
      tokenName: users.tokenName,
      email: users.email,
    })
    .from(spaces)
    .innerJoin(users, eq(users.id, spaces.ownerUserId));

  for (const row of rows) {
    result.scanned++;
    try {
      // The NEW (target) owner segment: the stable handle (assign-on-read if the
      // backfill somehow hasn't filled it).
      const handle = row.handle ?? (await assignUserHandle(db, row.ownerUserId));
      if (!handle) {
        console.log(
          `[migrate-repo-path] skip ${row.slug}: owner ${row.ownerUserId} has no handle`,
        );
        result.skipped++;
        continue;
      }
      // The LEGACY (source) owner segment: the email-derived slug this migration
      // exists to move AWAY from. `ownerSlugForUser` is used ONLY here.
      const legacyOwner = ownerSlugForUser(
        { tokenName: row.tokenName, email: row.email },
        row.ownerUserId,
      );

      const legacyPath = bareRepoPath(legacyOwner, row.slug);
      const newPath = bareRepoPath(handle, row.slug);

      if (legacyPath === newPath) {
        console.log(
          `[migrate-repo-path] skip ${row.slug}: already handle-derived (${handle})`,
        );
        result.skipped++;
        continue;
      }

      const legacyThere = await repoExists(legacyPath);
      const newThere = await repoExists(newPath);

      if (!legacyThere) {
        console.log(
          `[migrate-repo-path] skip ${row.slug}: no repo at legacy path ${legacyPath}` +
            (newThere ? ` (already at ${newPath})` : ""),
        );
        result.skipped++;
        continue;
      }

      if (newThere) {
        // Both exist — a human must reconcile. NEVER clobber the target.
        console.warn(
          `[migrate-repo-path] conflict ${row.slug}: BOTH ${legacyPath} and ${newPath} exist — leaving legacy in place (never clobber)`,
        );
        result.conflicts++;
        continue;
      }

      // Move the whole bare-repo dir (rename preserves hooks + config + objects).
      console.log(`[migrate-repo-path] would move ${legacyPath} -> ${newPath}`);
      await mkdir(path.dirname(newPath), { recursive: true });
      await rename(legacyPath, newPath);
      console.log(`[migrate-repo-path] moved ${legacyPath} -> ${newPath}`);
      result.moved++;
    } catch (e) {
      // Best-effort: one bad space must not crash boot.
      result.errors++;
      console.error(
        `[migrate-repo-path] space ${row.slug} failed:`,
        (e as Error)?.message,
      );
    }
  }

  return result;
}
