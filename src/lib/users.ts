import { eq, desc, asc, and, count, sql } from "drizzle-orm";
import { db } from "@/db";
import { users, userEmails } from "@/db/schema";
import { emitEvent } from "@/lib/events";
import { assignUserHandle, HANDLE_RE, MAX_HANDLE_LEN } from "@/lib/user-handle";

export type Role = "admin" | "member";

export type UserListItem = {
  id: number;
  email: string | null;
  tokenName: string | null;
  displayName: string;
  role: Role;
  active: number; // 1 | 0
  /** The stable, unique, URL-safe owner identity (Owner-namespace S1, D1). Null
   *  only transiently for a row created before the boot backfill assigned one. */
  handle: string | null;
  createdAt: Date;
};

export type CreateUserInput = {
  email?: string;
  tokenName?: string;
  displayName: string;
  /**
   * Role for the new user. Defaults to "member". Under the multi-admin model
   * (v2) the stored role column IS the source of truth — passing "admin" here
   * mints an admin directly. createUser is still member-only from the public
   * API surface (POST /api/users and create_user MCP always store "member");
   * this field exists for the bootstrap path and test helpers.
   */
  role?: Role;
};

// Postgres unique-violation SQLSTATE — surfaced by postgres-js as `.code`.
const PG_UNIQUE_VIOLATION = "23505";

/** Normalize an email: trim + lowercase. Empty/whitespace → undefined. */
function normalizeEmail(raw: string | undefined): string | undefined {
  if (raw == null) return undefined;
  const v = raw.trim().toLowerCase();
  return v.length > 0 ? v : undefined;
}

/** Trim a tokenName. Empty/whitespace → undefined. */
function normalizeTokenName(raw: string | undefined): string | undefined {
  if (raw == null) return undefined;
  const v = raw.trim();
  return v.length > 0 ? v : undefined;
}

// ── listUsers ──────────────────────────────────────────────────────────────

/** All users, newest-first (highest id, monotonic with createdAt). */
export async function listUsers(): Promise<UserListItem[]> {
  const rows = await db.select().from(users).orderBy(desc(users.id));
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    tokenName: r.tokenName,
    displayName: r.displayName,
    role: r.role,
    active: r.active,
    handle: r.handle,
    createdAt: r.createdAt,
  }));
}

// ── getUserById ──────────────────────────────────────────────────────────────

/**
 * Load one user by id, or null when the id is unknown. Used by callers that
 * need the target row before mutating (e.g. the PATCH self-deactivation guard,
 * which matches the acting principal against the target's email / tokenName).
 */
export async function getUserById(id: number): Promise<UserListItem | null> {
  const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: r.id,
    email: r.email,
    tokenName: r.tokenName,
    displayName: r.displayName,
    role: r.role,
    active: r.active,
    handle: r.handle,
    createdAt: r.createdAt,
  };
}

// ── createUser ───────────────────────────────────────────────────────────────

/**
 * Create a user. Requires at least one identifier (email OR tokenName) — returns
 * null otherwise. Email is normalized (trim + lowercase). A duplicate email or
 * tokenName returns null with uniform "already exists" semantics (we catch the
 * unique-constraint violation rather than pre-checking, so concurrent inserts
 * can't slip through a TOCTOU gap).
 */
export async function createUser(input: CreateUserInput): Promise<UserListItem | null> {
  const email = normalizeEmail(input.email);
  const tokenName = normalizeTokenName(input.tokenName);

  // Require at least one identifier.
  if (!email && !tokenName) return null;

  try {
    const row = await db.transaction(async (tx) => {
      const [u] = await tx
        .insert(users)
        .values({
          ...(email ? { email } : {}),
          ...(tokenName ? { tokenName } : {}),
          displayName: input.displayName,
          // Stored role is the source of truth (multi-admin model v2). Defaults
          // to "member"; the bootstrap path may pass "admin" explicitly.
          role: input.role ?? "member",
        })
        .returning();
      // Mirror the primary email into user_emails so the auth-resolution lookup
      // (a single user_emails join) finds this row. A token-only user has no
      // email row. A duplicate email here trips the user_emails unique(email)
      // constraint and rolls the whole insert back → the catch returns null.
      if (email) {
        await tx.insert(userEmails).values({ userId: u.id, email });
      }
      // Assign the stable owner handle atomically with the insert (Owner-namespace
      // S1) — derived from tokenName/email/`u<id>`, de-duped with a `-N` suffix.
      const handle = await assignUserHandle(tx, u.id);
      return { ...u, handle };
    });

    return {
      id: row.id,
      email: row.email,
      tokenName: row.tokenName,
      displayName: row.displayName,
      role: row.role,
      active: row.active,
      handle: row.handle,
      createdAt: row.createdAt,
    };
  } catch (e) {
    // Duplicate email or tokenName → uniform "already exists" (null).
    // Drizzle wraps the driver error, so the SQLSTATE code can sit on the error
    // itself or on its `.cause` (the underlying postgres-js error).
    if (isUniqueViolation(e)) return null;
    throw e;
  }
}

/** True iff the error (or its cause chain) is a Postgres unique-constraint violation. */
function isUniqueViolation(e: unknown): boolean {
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur != null; i++) {
    if ((cur as { code?: string }).code === PG_UNIQUE_VIOLATION) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

// ── setUserDisplayName ───────────────────────────────────────────────────────

export type SetDisplayNameResult = "ok" | "not-found";

/**
 * Rename a user's display name. The value is trimmed before writing; an
 * empty/whitespace-only name is rejected by the caller (the API returns 400) —
 * this fn assumes a non-empty input but trims defensively. Returns "not-found"
 * when the id doesn't exist. Email stays immutable (never touched here).
 */
export async function setUserDisplayName(
  id: number,
  name: string,
): Promise<SetDisplayNameResult> {
  const trimmed = name.trim();
  if (trimmed.length === 0) return "not-found"; // defensive; caller should 400 first
  const updated = await db
    .update(users)
    .set({ displayName: trimmed })
    .where(eq(users.id, id))
    .returning({ id: users.id });
  return updated.length > 0 ? "ok" : "not-found";
}

// ── setUserActive ────────────────────────────────────────────────────────────

/** Flip a user's active flag. Returns false if the id is unknown. */
export async function setUserActive(id: number, active: boolean): Promise<boolean> {
  const updated = await db
    .update(users)
    .set({ active: active ? 1 : 0 })
    .where(eq(users.id, id))
    .returning({ id: users.id });
  return updated.length > 0;
}

// ── setUserRole ────────────────────────────────────────────────────────────────

/** Set a user's role. Returns false if the id is unknown. */
export async function setUserRole(id: number, role: Role): Promise<boolean> {
  const updated = await db
    .update(users)
    .set({ role })
    .where(eq(users.id, id))
    .returning({ id: users.id });
  return updated.length > 0;
}

// ── last-admin guard ──────────────────────────────────────────────────────────

/** Count active (active=1) rows with role='admin'. */
export async function countActiveAdmins(): Promise<number> {
  const [result] = await db
    .select({ cnt: count() })
    .from(users)
    .where(and(eq(users.role, "admin"), eq(users.active, 1)));
  return result?.cnt ?? 0;
}

/**
 * Returns true when applying `newRole` (or the deactivation flag) to `targetId`
 * would remove the only remaining active admin — an operation that would lock
 * out the workspace.
 *
 * Covers three paths:
 *   1. Demote:     targetId is the only active admin, newRole === 'member'
 *   2. Deactivate: targetId is the only active admin, active === false
 *   3. Self-demote when last admin (same as #1 but called from the self path)
 *
 * `activeChange` is undefined when the caller is only changing role, false when
 * deactivating, true when reactivating (not a lockout risk).
 */
export async function isLastAdminOperation(
  targetId: number,
  opts: { newRole?: Role; activeChange?: boolean },
): Promise<boolean> {
  const target = await getUserById(targetId);
  if (!target || target.role !== "admin" || target.active !== 1) {
    // Target isn't an active admin — guard never fires.
    return false;
  }

  const { newRole, activeChange } = opts;
  const wouldLoseAdmin =
    (newRole !== undefined && newRole !== "admin") ||
    activeChange === false;

  if (!wouldLoseAdmin) return false;

  const adminCount = await countActiveAdmins();
  return adminCount <= 1;
}

// ── atomic admin-removing mutation (last-admin TOCTOU guard) ─────────────────────

/**
 * Transaction-scoped advisory-lock key for admin-set mutations (role demote /
 * deactivate). A fixed 64-bit constant distinct from the bootstrap lock key in
 * cloudflare.ts (BOOTSTRAP_ADVISORY_LOCK_KEY = 911_478_001) — the two locks
 * guard different invariants and must NOT collide. Every mutation that could
 * remove an active admin takes pg_advisory_xact_lock on THIS key, so the
 * last-admin re-check + the mutation run atomically across connections.
 */
const ADMIN_SET_ADVISORY_LOCK_KEY = 911_478_002;

/**
 * Outcome of applyAdminMutation:
 *  - "ok"           — the mutation was applied.
 *  - "last-admin"   — applying it would remove the last active admin; rejected,
 *                     nothing was written. The caller maps this to its own
 *                     user-facing 403 message (route vs MCP wording differ).
 */
export type AdminMutationResult = "ok" | "last-admin";

/**
 * Atomically apply a role and/or active change to `targetId`, guarding the
 * last-admin invariant under a Postgres advisory lock so it cannot be raced.
 *
 * The original code checked `isLastAdminOperation` (a SELECT count) and THEN
 * applied the mutation in a separate statement — a check-then-act TOCTOU. Two
 * concurrent admin-removing PATCHes (A demotes B while B deactivates A) both
 * read count=2 and both proceed → zero admins. Here, all admin-removing
 * mutations serialize on ADMIN_SET_ADVISORY_LOCK_KEY: inside the lock we re-read
 * countActiveAdmins() and re-load the target, and only apply the change if it
 * would NOT drop the active-admin count below one. The second mutation, once it
 * acquires the lock, sees count=1 and is rejected ("last-admin").
 *
 * Non-removing changes (promote to admin, reactivate, or a no-op role/active
 * that keeps the target an active admin) are always applied.
 */
export async function applyAdminMutation(
  targetId: number,
  opts: { newRole?: Role; active?: boolean },
): Promise<AdminMutationResult> {
  const { newRole, active } = opts;
  return db.transaction(async (tx): Promise<AdminMutationResult> => {
    // Serialize all admin-removing mutations on a fixed advisory-lock key, held
    // until this transaction commits. The last-admin re-check below therefore
    // runs under mutual exclusion across connections.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${ADMIN_SET_ADVISORY_LOCK_KEY})`);

    // Re-load the target INSIDE the lock — its role/active may have changed since
    // the route's pre-flight read.
    const [target] = await tx
      .select({ role: users.role, active: users.active })
      .from(users)
      .where(eq(users.id, targetId))
      .limit(1);

    const removesAdmin =
      target != null &&
      target.role === "admin" &&
      target.active === 1 &&
      ((newRole !== undefined && newRole !== "admin") || active === false);

    if (removesAdmin) {
      // Re-count active admins INSIDE the lock — the authoritative invariant
      // check. A concurrent admin-removing mutation has already committed by the
      // time we hold the lock, so this count reflects it.
      const [{ cnt }] = await tx
        .select({ cnt: count() })
        .from(users)
        .where(and(eq(users.role, "admin"), eq(users.active, 1)));
      if (cnt <= 1) return "last-admin";
    }

    if (newRole !== undefined) {
      await tx.update(users).set({ role: newRole }).where(eq(users.id, targetId));
    }
    if (active !== undefined) {
      await tx
        .update(users)
        .set({ active: active ? 1 : 0 })
        .where(eq(users.id, targetId));
    }
    return "ok";
  });
}

// ── setUserTokenName ──────────────────────────────────────────────────────────

export type SetTokenNameResult = "ok" | "not-found" | "duplicate";

/**
 * Update (or clear) a user's service-token Client ID.
 *
 * - `null` or empty/whitespace string → clears the tokenName to null.
 * - Non-empty string is trimmed before writing.
 * - Returns "duplicate" when the value collides with another row's tokenName.
 * - Returns "not-found" when the id doesn't exist.
 */
export async function setUserTokenName(
  id: number,
  tokenName: string | null,
): Promise<SetTokenNameResult> {
  const normalized = normalizeTokenName(tokenName ?? undefined) ?? null;

  try {
    const updated = await db
      .update(users)
      .set({ tokenName: normalized })
      .where(eq(users.id, id))
      .returning({ id: users.id });
    return updated.length > 0 ? "ok" : "not-found";
  } catch (e) {
    if (isUniqueViolation(e)) return "duplicate";
    throw e;
  }
}

// ── setUserHandle (admin rename of the owner identity) ───────────────────────

export type SetHandleResult = "ok" | "not-found" | "duplicate" | "invalid";

/**
 * Set (rename) a user's owner handle (Owner-namespace S1, admin-editable per D1).
 * The value is trimmed and must match ^[a-z0-9][a-z0-9-]*$ with length ≤ 39;
 * anything else → "invalid" (the caller returns 400). A collision with another
 * user's handle → "duplicate" (409). Unknown id → "not-found" (404).
 *
 * A rename does NOT touch on-disk repos yet — that atomic move is S2/S3. S1 only
 * stores the new handle.
 */
export async function setUserHandle(
  id: number,
  handle: string,
): Promise<SetHandleResult> {
  const value = handle.trim();
  if (!HANDLE_RE.test(value) || value.length > MAX_HANDLE_LEN) return "invalid";
  try {
    const updated = await db
      .update(users)
      .set({ handle: value })
      .where(eq(users.id, id))
      .returning({ id: users.id });
    return updated.length > 0 ? "ok" : "not-found";
  } catch (e) {
    if (isUniqueViolation(e)) return "duplicate";
    throw e;
  }
}

// ── Email management (multiple emails per user) ──────────────────────────────

export type UserEmailItem = {
  id: number;
  email: string;
  /** True for the user's PRIMARY/display email (users.email). */
  primary: boolean;
  createdAt: Date;
};

/**
 * List a user's emails (the user_emails set, incl. the primary mirror), oldest
 * first. Flags the row that matches users.email as the primary. Returns null
 * when the user id is unknown.
 */
export async function listUserEmails(id: number): Promise<UserEmailItem[] | null> {
  const user = await db.query.users.findFirst({ where: eq(users.id, id) });
  if (!user) return null;
  const rows = await db
    .select()
    .from(userEmails)
    .where(eq(userEmails.userId, id))
    .orderBy(asc(userEmails.id));
  const primary = user.email?.toLowerCase() ?? null;
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    primary: primary != null && r.email.toLowerCase() === primary,
    createdAt: r.createdAt,
  }));
}

/**
 * All emails across all users, grouped by userId (for the admin page's per-row
 * chips — one query instead of N). Each entry flags the user's primary email.
 */
export async function listAllUserEmails(): Promise<
  Map<number, UserEmailItem[]>
> {
  const [allUsers, allEmails] = await Promise.all([
    db.select({ id: users.id, email: users.email }).from(users),
    db.select().from(userEmails).orderBy(asc(userEmails.id)),
  ]);
  const primaryByUser = new Map<number, string | null>();
  for (const u of allUsers) primaryByUser.set(u.id, u.email?.toLowerCase() ?? null);

  const out = new Map<number, UserEmailItem[]>();
  for (const r of allEmails) {
    const list = out.get(r.userId) ?? [];
    const primary = primaryByUser.get(r.userId) ?? null;
    list.push({
      id: r.id,
      email: r.email,
      primary: primary != null && r.email.toLowerCase() === primary,
      createdAt: r.createdAt,
    });
    out.set(r.userId, list);
  }
  return out;
}

export type AddUserEmailResult = "ok" | "duplicate" | "not-found" | "invalid";

/**
 * Add an email to a user. The address is normalized (trim + lowercase). Returns:
 *  - "invalid"   — empty/whitespace email.
 *  - "not-found" — unknown user id.
 *  - "duplicate" — the email already belongs to ANY user (the global
 *    user_emails unique(email) — no silent steal).
 *  - "ok"        — added. Emits user.email_added (admin-only feed) in-tx.
 *
 * The user's PRIMARY email (users.email) is unchanged — adding an alias never
 * promotes it. tokenName stays orthogonal.
 */
export async function addUserEmail(
  id: number,
  rawEmail: string,
  by?: string,
): Promise<AddUserEmailResult> {
  const email = normalizeEmail(rawEmail);
  if (!email) return "invalid";
  const user = await db.query.users.findFirst({ where: eq(users.id, id) });
  if (!user) return "not-found";
  try {
    return await db.transaction(async (tx): Promise<AddUserEmailResult> => {
      await tx.insert(userEmails).values({ userId: id, email });
      await emitEvent(tx, {
        kind: "user.email_added",
        docId: null,
        payload: { userId: id, email, displayName: user.displayName },
        actorName: by ?? "system",
      });
      return "ok";
    });
  } catch (e) {
    if (isUniqueViolation(e)) return "duplicate";
    throw e;
  }
}

export type RemoveUserEmailResult = "ok" | "not-found" | "last-email";

/**
 * Remove an email from a user. The address is matched normalized (trim +
 * lowercase). Returns:
 *  - "not-found"  — unknown user id, or the email isn't on this user.
 *  - "last-email" — removing this would leave a TOKEN-LESS (human) user with
 *    zero emails. A user WITH a tokenName (an agent identity) may drop to zero
 *    emails; a human must keep ≥1 so the account isn't orphaned (unreachable via
 *    any login). The guard counts the user's emails, not global rows.
 *  - "ok"         — removed. If the removed address was the PRIMARY (users.email),
 *    users.email is repointed to a remaining email (or null when none remain and
 *    a tokenName exists). Emits user.email_removed (admin-only feed) in-tx.
 */
export async function removeUserEmail(
  id: number,
  rawEmail: string,
  by?: string,
): Promise<RemoveUserEmailResult> {
  const email = normalizeEmail(rawEmail);
  if (!email) return "not-found";
  const user = await db.query.users.findFirst({ where: eq(users.id, id) });
  if (!user) return "not-found";

  const existing = await db
    .select()
    .from(userEmails)
    .where(and(eq(userEmails.userId, id), eq(userEmails.email, email)))
    .limit(1);
  if (existing.length === 0) return "not-found";

  const all = await db
    .select({ email: userEmails.email })
    .from(userEmails)
    .where(eq(userEmails.userId, id))
    .orderBy(asc(userEmails.id));
  const tokenless = normalizeTokenName(user.tokenName ?? undefined) == null;
  if (tokenless && all.length <= 1) return "last-email";

  return await db.transaction(async (tx): Promise<RemoveUserEmailResult> => {
    await tx
      .delete(userEmails)
      .where(and(eq(userEmails.userId, id), eq(userEmails.email, email)));

    // If we just removed the primary/display email, repoint users.email to a
    // remaining address (deterministic: the oldest remaining), or null when the
    // user is now an email-less agent.
    if (user.email?.toLowerCase() === email) {
      const remaining = all
        .map((r) => r.email)
        .filter((e) => e.toLowerCase() !== email);
      const nextPrimary = remaining.length > 0 ? remaining[0] : null;
      await tx.update(users).set({ email: nextPrimary }).where(eq(users.id, id));
    }

    await emitEvent(tx, {
      kind: "user.email_removed",
      docId: null,
      payload: { userId: id, email, displayName: user.displayName },
      actorName: by ?? "system",
    });
    return "ok";
  });
}
