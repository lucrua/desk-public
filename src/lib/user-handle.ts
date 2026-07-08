/**
 * User handles — the stable, unique, URL-safe owner identity (Owner-namespace
 * Slice S1, decision D1).
 *
 * `users.handle` is the REAL owner identity that later slices (S2+) use for the
 * on-disk repo path and owner-namespaced URLs, REPLACING the broken
 * `ownerSlugForUser` (which is recomputed live from the mutable `users.email` —
 * not unique across two `lucas@…` accounts, not stable when the primary email is
 * repointed). A handle is:
 *
 *   - STORED (a real column), not derived on read;
 *   - UNIQUE (a Postgres unique index — multiple NULLs are allowed, which is what
 *     lets existing rows sit at NULL until the boot backfill assigns them);
 *   - URL-SAFE — matches ^[a-z0-9][a-z0-9-]*$, length ≤ 39 (same alphabet as
 *     space/doc slugs, GitHub-username length cap).
 *
 * This module is the SINGLE source of the derive+dedup algorithm shared by the
 * one-shot boot backfill (`backfillUserHandles`) and every user-creation path
 * (`assignUserHandle`). It imports only the DB + schema (no events/auth) so it
 * can be pulled into the auth layer and instrumentation without an import cycle.
 */
import { and, asc, eq, isNull, like } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";

/** The handle alphabet — same as space/doc slugs. */
export const HANDLE_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Max handle length (GitHub-username cap). */
export const MAX_HANDLE_LEN = 39;

/** A db transaction handle OR the top-level db — so creation paths can assign a
 *  handle inside the SAME transaction as the user insert (atomic). */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type DbHandle = Tx | typeof db;

/**
 * Slugify an arbitrary string into the handle alphabet: lowercase, non-alphanum
 * runs → `-`, collapse repeats, trim leading/trailing `-`, cap at
 * MAX_HANDLE_LEN (re-trimming a trailing `-` the truncation may expose). Returns
 * "" when nothing survives (an all-symbol input) — callers apply the `u<id>`
 * fallback.
 */
export function slugifyHandle(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_HANDLE_LEN)
    .replace(/-+$/g, "");
}

/**
 * The BASE handle for a user (pre-dedup): `tokenName ?? email-local-part ?? u<id>`,
 * slugified. The `u<id>` fallback is used when a row has neither identifier OR
 * when the identifier slugifies to nothing (e.g. an all-symbol tokenName).
 */
export function deriveHandleBase(
  user: { tokenName?: string | null; email?: string | null },
  userId: number,
): string {
  const raw =
    user.tokenName ??
    (user.email ? user.email.split("@")[0] : null) ??
    `u${userId}`;
  const seg = slugifyHandle(raw);
  return seg.length > 0 ? seg : `u${userId}`;
}

/**
 * De-duplicate a base handle against a set of already-taken handles by appending
 * a numeric suffix: `base`, then `base-2`, `base-3`, … The base itself is used
 * when free. The result is kept ≤ MAX_HANDLE_LEN by truncating the base to make
 * room for the suffix (and re-trimming any trailing `-` the truncation exposes).
 */
export function dedupeHandle(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const room = MAX_HANDLE_LEN - suffix.length;
    const stem = base.slice(0, room).replace(/-+$/g, "");
    const candidate = `${stem}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Load the set of already-assigned handles that could collide with `base` — the
 * exact base plus any `base-N` suffixes. Narrowed by a `LIKE base-%` so we don't
 * scan every handle; `base` only contains [a-z0-9-] so it needs no LIKE escaping.
 */
async function takenHandlesFor(dbh: DbHandle, base: string): Promise<Set<string>> {
  const rows = await dbh
    .select({ handle: users.handle })
    .from(users)
    .where(like(users.handle, `${base}%`));
  const taken = new Set<string>();
  for (const r of rows) if (r.handle) taken.add(r.handle);
  return taken;
}

/**
 * Assign a unique handle to a just-created user (the shared creation-path helper).
 * IDEMPOTENT: a user that already has a handle keeps it (returns the existing
 * value). Otherwise derives the base from the row (tokenName/email/`u<id>`),
 * de-duplicates against currently-committed handles, and writes it.
 *
 * Pass the caller's transaction as `dbh` so the handle lands atomically with the
 * user insert. The unique index is the ultimate guard under true concurrency (a
 * rare simultaneous same-base insert loses the race and the caller's own
 * unique-violation handling fires); the in-transaction dedup covers the ordinary
 * serial case. Returns null only when the user id doesn't exist.
 */
export async function assignUserHandle(
  dbh: DbHandle,
  userId: number,
): Promise<string | null> {
  const [row] = await dbh
    .select({ id: users.id, tokenName: users.tokenName, email: users.email, handle: users.handle })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) return null;
  if (row.handle) return row.handle; // already assigned — idempotent

  const base = deriveHandleBase(row, row.id);
  const taken = await takenHandlesFor(dbh, base);
  const handle = dedupeHandle(base, taken);

  await dbh
    .update(users)
    .set({ handle })
    .where(and(eq(users.id, userId), isNull(users.handle)));
  return handle;
}

export type BackfillUserHandlesResult = {
  /** Rows examined (the whole users table). */
  scanned: number;
  /** Rows that had a NULL handle and were assigned one this run. */
  assigned: number;
};

/**
 * One-shot, idempotent boot backfill (wired into `instrumentation.register`,
 * following the `backfillShareSpaceIds` / `materializeDbOnlyDocs` precedent).
 *
 * Assigns a handle to every user whose handle is NULL, in a DETERMINISTIC order
 * (id ascending), de-duplicating against the running set of already-assigned
 * handles with a numeric suffix. Idempotent: a user that already has a handle is
 * skipped, and every UPDATE is guarded by `handle IS NULL`, so a re-run is a
 * no-op. Best-effort at the call site (a failure logs, never crashes boot).
 */
export async function backfillUserHandles(): Promise<BackfillUserHandlesResult> {
  const all = await db
    .select({ id: users.id, tokenName: users.tokenName, email: users.email, handle: users.handle })
    .from(users)
    .orderBy(asc(users.id));

  // Seed the taken-set from every handle already assigned (so a re-run — or a
  // mix of assigned + null rows — never collides with an existing handle).
  const taken = new Set<string>();
  for (const u of all) if (u.handle) taken.add(u.handle);

  let assigned = 0;
  for (const u of all) {
    if (u.handle) continue; // already has one — skip (idempotent)
    const base = deriveHandleBase(u, u.id);
    const handle = dedupeHandle(base, taken);
    await db
      .update(users)
      .set({ handle })
      .where(and(eq(users.id, u.id), isNull(users.handle)));
    taken.add(handle);
    assigned++;
  }

  if (assigned > 0) {
    console.log(`[startup] backfilled handle onto ${assigned} user(s)`);
  }
  return { scanned: all.length, assigned };
}
