import { eq, desc } from "drizzle-orm";
import { db } from "@/db";
import { accessRequests, users, userEmails } from "@/db/schema";
import { emitEvent } from "@/lib/events";

export type AccessRequestListItem = {
  id: number;
  email: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  hits: number;
};

export type ApproveResult =
  | { status: "ok"; userId: number }
  | { status: "not-found" }
  | { status: "duplicate" }
  // The aliasOfUserId target doesn't exist.
  | { status: "alias-not-found" };

export type DismissResult = "ok" | "not-found";

// Postgres unique-violation SQLSTATE — surfaced by postgres-js as `.code`.
const PG_UNIQUE_VIOLATION = "23505";

/** True iff the error (or its cause chain) is a Postgres unique-constraint violation. */
function isUniqueViolation(e: unknown): boolean {
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur != null; i++) {
    if ((cur as { code?: string }).code === PG_UNIQUE_VIOLATION) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Default display name from an email local-part: "dani.silva@x.com" → "Dani.silva".
 * Capitalizes the first character only — the admin can edit it after approval.
 */
function defaultDisplayName(email: string): string {
  const local = email.split("@")[0] ?? email;
  if (local.length === 0) return email;
  return local.charAt(0).toUpperCase() + local.slice(1);
}

// ── listAccessRequests ────────────────────────────────────────────────────────

/** Pending access requests, most-recently-seen first. */
export async function listAccessRequests(): Promise<AccessRequestListItem[]> {
  const rows = await db
    .select()
    .from(accessRequests)
    .orderBy(desc(accessRequests.lastSeenAt), desc(accessRequests.id));
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    firstSeenAt: r.firstSeenAt,
    lastSeenAt: r.lastSeenAt,
    hits: r.hits,
  }));
}

// ── approveAccessRequest ──────────────────────────────────────────────────────

/**
 * Approve a pending request. Two modes:
 *
 * 1. DEFAULT (no aliasOfUserId): create a NEW member user from the request's
 *    email (displayName defaults to the capitalized local-part unless supplied),
 *    mirror the email into user_emails, and delete the request.
 *
 * 2. ALIAS (aliasOfUserId set): add the request's email to that EXISTING user
 *    instead of creating an account — for when the requester is the same person
 *    as an existing account (e.g. a second address). No new users row; the email
 *    becomes a secondary on the target. The request is deleted either way.
 *
 * Returns:
 *  - "ok" with the resolved user id on success (new user, or the alias target).
 *  - "not-found" when the request id doesn't exist.
 *  - "alias-not-found" when aliasOfUserId is given but no such user exists.
 *  - "duplicate" when a users row / user_emails row with that email already
 *    appeared meanwhile — we STILL delete the request (it's satisfied) so the
 *    queue clears.
 *
 * Roles are derived from ADMIN_EMAIL at auth — a new row is always a member;
 * aliasing onto an admin's account makes that email an admin login (any-email-
 * is-admin), which is the intended merge path.
 */
export async function approveAccessRequest(
  id: number,
  opts: { displayName?: string; by?: string; aliasOfUserId?: number } = {},
): Promise<ApproveResult> {
  const reqRow = await db.query.accessRequests.findFirst({
    where: eq(accessRequests.id, id),
  });
  if (!reqRow) return { status: "not-found" };

  const email = reqRow.email; // already normalized at insert time

  // ── Alias mode: attach the email to an existing user ───────────────────────
  if (opts.aliasOfUserId != null) {
    const target = await db.query.users.findFirst({
      where: eq(users.id, opts.aliasOfUserId),
    });
    if (!target) return { status: "alias-not-found" };
    try {
      return await db.transaction(async (tx): Promise<ApproveResult> => {
        await tx.insert(userEmails).values({ userId: target.id, email });
        await tx.delete(accessRequests).where(eq(accessRequests.id, id));
        // Consistent with addUserEmail: an admin-only audit event.
        await emitEvent(tx, {
          kind: "user.email_added",
          docId: null,
          payload: { userId: target.id, email, displayName: target.displayName },
          actorName: opts.by ?? "system",
        });
        return { status: "ok", userId: target.id };
      });
    } catch (e) {
      if (isUniqueViolation(e)) {
        // The email already belongs to a user — request satisfied, clear it.
        await db.delete(accessRequests).where(eq(accessRequests.id, id));
        return { status: "duplicate" };
      }
      throw e;
    }
  }

  // ── Default mode: create a new member user ─────────────────────────────────
  const displayName =
    opts.displayName != null && opts.displayName.trim().length > 0
      ? opts.displayName.trim()
      : defaultDisplayName(email);

  try {
    return await db.transaction(async (tx): Promise<ApproveResult> => {
      const [user] = await tx
        .insert(users)
        .values({ email, displayName, role: "member" })
        .returning({ id: users.id });
      // Mirror the primary email into user_emails so the auth-resolution lookup
      // finds the new row.
      await tx.insert(userEmails).values({ userId: user.id, email });
      await tx.delete(accessRequests).where(eq(accessRequests.id, id));
      // user.approved is admin-only-visible in the events feed. Payload carries
      // the new user id + email only (no doc). This is the one S1 kind with no
      // docId.
      await emitEvent(tx, {
        kind: "user.approved",
        docId: null,
        payload: { userId: user.id, email },
        actorName: opts.by ?? "system",
      });
      return { status: "ok", userId: user.id };
    });
  } catch (e) {
    if (isUniqueViolation(e)) {
      // A users row / user_emails row with this email appeared meanwhile — the
      // request is satisfied. Delete it so the queue clears, and report
      // duplicate. No user was created → no user.approved event.
      await db.delete(accessRequests).where(eq(accessRequests.id, id));
      return { status: "duplicate" };
    }
    throw e;
  }
}

// ── dismissAccessRequest ──────────────────────────────────────────────────────

/** Delete a pending request without creating a user. */
export async function dismissAccessRequest(id: number): Promise<DismissResult> {
  const deleted = await db
    .delete(accessRequests)
    .where(eq(accessRequests.id, id))
    .returning({ id: accessRequests.id });
  return deleted.length > 0 ? "ok" : "not-found";
}
