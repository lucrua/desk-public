import { jwtVerify, createRemoteJWKSet } from "jose";
import type { JWTVerifyGetKey } from "jose";
import { db, schema } from "@/db";
import { eq, count, and, sql } from "drizzle-orm";
import type { Principal } from "./principal";
import { assignUserHandle } from "@/lib/user-handle";

/**
 * The full set of key types jose's jwtVerify accepts — either a raw key
 * (CryptoKey / JWK / Uint8Array) or a dynamic key-resolver function (JWKS).
 */
type VerifyKey = CryptoKey | JWTVerifyGetKey;

export type CfJwtOpts = {
  /** Injected public key for tests; omit in production to use the remote JWKS. */
  key?: VerifyKey;
  audience: string;
  issuer: string;
};

/**
 * Load every email of a user (the user_emails set), normalized (trim +
 * lowercase). The set already includes the primary (users.email is mirrored as a
 * user_emails row), so callers don't union it in separately.
 */
async function emailsForUser(userId: number): Promise<string[]> {
  const rows = await db
    .select({ email: schema.userEmails.email })
    .from(schema.userEmails)
    .where(eq(schema.userEmails.userId, userId));
  return rows.map((r) => r.email.trim().toLowerCase());
}

/**
 * Resolve a principal from a Cloudflare Access JWT.
 *
 * - Human sessions carry `email` in the payload.
 * - Service-token sessions carry `common_name` (no email).
 * - Any verification failure (bad sig, wrong aud, expired, unknown user,
 *   inactive user) → anonymous. This function NEVER throws to the caller.
 */
export async function principalFromCfJwt(
  jwt: string,
  opts: CfJwtOpts,
): Promise<Principal> {
  try {
    const key: VerifyKey = opts.key
      ?? createRemoteJWKSet(new URL(`${opts.issuer}/cdn-cgi/access/certs`));

    // jwtVerify has two overloads: one for raw keys, one for key-resolver functions.
    // Our VerifyKey union covers both; the cast routes the call through the correct overload.
    const { payload } = await jwtVerify(jwt, key as JWTVerifyGetKey, {
      audience: opts.audience,
      issuer: opts.issuer,
    });

    const emailRaw = payload.email as string | undefined;
    const email = emailRaw ? emailRaw.trim().toLowerCase() : undefined;
    const tokenName = payload.common_name as string | undefined;

    let row: typeof schema.users.$inferSelect | undefined;

    if (email) {
      // Resolve the email claim through user_emails (any of a user's addresses
      // resolves the same row), then load the users row by the matched userId.
      // Single source of truth for the email→user edge; users.email is just the
      // primary/display mirror.
      const match = await db.query.userEmails.findFirst({
        where: eq(schema.userEmails.email, email),
      });
      if (match) {
        row = await db.query.users.findFirst({
          where: eq(schema.users.id, match.userId),
        });
      }
    } else if (tokenName) {
      row = await db.query.users.findFirst({
        where: eq(schema.users.tokenName, tokenName),
      });
    }

    // Bootstrap: when the users table is EMPTY and we have a verified email claim,
    // seed that user as admin (first-login-is-admin). Service tokens never bootstrap
    // (no email → can't be first admin). Later first-time visitors become pending
    // access requests. Race-safe: the transaction checks emptiness + inserts in one
    // atomic step — exactly one concurrent winner becomes admin.
    if (!row && email) {
      const isEmpty = await isUsersTableEmpty();
      if (isEmpty) {
        const seeded = await bootstrapAdmin(email);
        if (seeded) return seeded;
      }
      // A verified visitor who passed the CF wall but has no row (and isn't the
      // bootstrap first-login) becomes a pending access request. Email claims only —
      // never log a service token. Fire-and-forget: a failure here must not
      // break auth, so we swallow it and still fall through to anonymous.
      await recordAccessRequest(email);
    }

    if (!row || !row.active) return { kind: "anonymous" };

    // Load the user's full email set (user_emails, incl. the primary mirror).
    // Used to carry every address on the principal so the self-guard / ownership
    // match resolves a login via a secondary address as "me".
    const emails = await emailsForUser(row.id);

    // Multi-admin model: the kind is READ from the stored `role` column (the
    // source of truth after the v2 admin model). A service-token row with
    // role='admin' IS admin (this is how an agent gets publish rights: promote
    // its user to admin via the Users page). ADMIN_EMAIL is no longer consulted
    // for live derivation — it only survives as a one-time transitional backfill
    // aid (see ensureBootstrapAdmin).
    //
    // `userId` carries the resolved users.id row so ownership checks
    // (canPublishVersion, canDecideRevision) can compare without a second DB
    // lookup. Every active staff principal gets their row id here.
    return {
      kind: row.role === "admin" ? "admin" : "member",
      name: row.displayName,
      email: row.email ?? undefined,
      emails: emails.length > 0 ? emails : undefined,
      tokenName: row.tokenName ?? undefined,
      userId: row.id,
    };
  } catch (e) {
    console.warn("[auth] CF JWT verification failed:", (e as Error)?.message);
    return { kind: "anonymous" };
  }
}

/**
 * Returns true when the users table contains no rows. Used by the first-login
 * bootstrap guard — only fires on a genuinely empty table.
 */
async function isUsersTableEmpty(): Promise<boolean> {
  const [result] = await db
    .select({ cnt: count() })
    .from(schema.users);
  return (result?.cnt ?? 1) === 0;
}

/**
 * Upsert an access request for a verified-but-unknown email. New email → insert
 * (hits=1). Seen-before email → bump lastSeenAt=now and hits+1. The email is
 * already normalized (trim + lowercase) by the caller.
 *
 * Fire-and-forget-safe: ANY failure (DB down, missing table) is swallowed and
 * logged — recording an access request must never break authentication. The
 * caller falls through to anonymous regardless.
 */
async function recordAccessRequest(email: string): Promise<void> {
  try {
    await db
      .insert(schema.accessRequests)
      .values({ email })
      .onConflictDoUpdate({
        target: schema.accessRequests.email,
        set: {
          lastSeenAt: new Date(),
          hits: sql`${schema.accessRequests.hits} + 1`,
        },
      });
  } catch (e) {
    console.warn("[auth] recording access request failed (non-fatal):", (e as Error)?.message);
  }
}

/**
 * Derive a display name from an email local-part: "lucas.smith@x.com" → "Lucas.smith".
 * Capitalizes the first character only — a sane default the admin can edit later.
 */
function displayNameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? email;
  if (local.length === 0) return email;
  return local.charAt(0).toUpperCase() + local.slice(1);
}

/**
 * Transaction-scoped advisory-lock key for the first-login bootstrap. A fixed
 * 64-bit constant: every bootstrap transaction takes pg_advisory_xact_lock on
 * THIS key, so the empty-table check + admin INSERT serialize across connections.
 * Distinct from BOOTSTRAP_ADVISORY_LOCK_KEY's sibling in users.ts
 * (ADMIN_SET_ADVISORY_LOCK_KEY) — the two locks must not collide.
 */
const BOOTSTRAP_ADVISORY_LOCK_KEY = 911_478_001;

/**
 * Seed the bootstrap admin row for `email` (the first sign-in on an empty table)
 * and return its principal.
 *
 * Race-safe via a transaction-scoped Postgres advisory lock on a fixed key
 * (pg_advisory_xact_lock). Two concurrent first-logins with DIFFERENT emails
 * (alice@, bob@) would BOTH pass an unguarded count==0 re-check under READ
 * COMMITTED and both INSERT (different emails → no unique-constraint collision),
 * minting two admins. The advisory lock forces them to serialize: the first
 * winner takes the lock, sees the empty table, inserts the sole admin, and
 * commits (releasing the lock); the second waiter THEN acquires the lock, re-runs
 * the emptiness check, sees the table is now non-empty, and bails out
 * (→ recordAccessRequest / anonymous). Exactly one admin, always.
 *
 * Service tokens never reach this path (callers guard with `email` present).
 */
async function bootstrapAdmin(email: string): Promise<Principal | null> {
  const normalized = email.trim().toLowerCase();
  try {
    const row = await db.transaction(async (tx) => {
      // Serialize all bootstrap attempts on a fixed advisory-lock key. The lock
      // is held until this transaction commits/rolls back, so the emptiness
      // check + INSERT below run under mutual exclusion across connections.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${BOOTSTRAP_ADVISORY_LOCK_KEY})`,
      );

      // Re-check emptiness INSIDE the lock to close the race window. The second
      // (blocked) waiter reaches here only after the winner committed, so it now
      // sees a non-empty table and falls through to the access-request path —
      // it never mints a second admin.
      const [result] = await tx.select({ cnt: count() }).from(schema.users);
      if ((result?.cnt ?? 1) !== 0) {
        // Another request beat us to it — fall through to access request.
        throw new Error("table_no_longer_empty");
      }
      const [u] = await tx
        .insert(schema.users)
        .values({
          email: normalized,
          displayName: displayNameFromEmail(normalized),
          role: "admin",
          active: 1,
        })
        .returning();
      // Mirror the primary email into user_emails so the resolution lookup (a
      // single user_emails join) finds this row on the NEXT login.
      await tx
        .insert(schema.userEmails)
        .values({ userId: u.id, email: normalized });
      // Assign the stable owner handle atomically with the bootstrap admin (S1).
      await assignUserHandle(tx, u.id);
      return u;
    });
    return {
      kind: "admin",
      name: row.displayName,
      email: row.email ?? undefined,
      emails: [normalized],
      tokenName: row.tokenName ?? undefined,
      userId: row.id,
    };
  } catch (e) {
    const msg = (e as Error)?.message ?? "";
    // "table_no_longer_empty" → another request won the race; fall through to
    // access-request/anonymous. Any other error (unique violation from concurrent
    // insert) also yields the same outcome.
    if (!msg.includes("table_no_longer_empty")) {
      console.warn("[auth] bootstrap race — another first-login won:", msg);
    }
    return null;
  }
}

/**
 * Transitional one-time backfill (admin model v2 upgrade aid).
 *
 * Called once at app boot (from src/instrumentation.ts or equivalent). If
 * ADMIN_EMAIL is set and a user row with that email exists at role='member',
 * promotes it to role='admin'. Idempotent: already-admin rows are untouched;
 * unknown emails are a no-op. After the first post-upgrade deploy confirms Lucas
 * is still admin, remove ADMIN_EMAIL from the environment.
 *
 * This is the ONLY surviving use of process.env.ADMIN_EMAIL. It does NOT affect
 * the live auth derivation path (principalFromCfJwt reads the stored role column).
 *
 * Why here and not a SQL migration: this needs to read process.env.ADMIN_EMAIL,
 * which raw SQL migrations cannot do (they run without access to app env).
 */
export async function ensureBootstrapAdmin(): Promise<void> {
  const adminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  if (!adminEmail) return; // unset or empty → no-op

  try {
    // Find the user whose email set includes this address.
    const match = await db.query.userEmails.findFirst({
      where: eq(schema.userEmails.email, adminEmail),
    });
    if (!match) return; // email not in any user's set → no-op (new deploy, first login handles it)

    const user = await db.query.users.findFirst({
      where: eq(schema.users.id, match.userId),
    });
    if (!user) return;
    if (user.role === "admin") return; // already promoted — idempotent

    await db
      .update(schema.users)
      .set({ role: "admin" })
      .where(eq(schema.users.id, user.id));

    console.log(
      `[boot] ensureBootstrapAdmin: promoted ${adminEmail} (id=${user.id}) to admin`,
    );
  } catch (e) {
    // Never let a boot-time backfill crash the app — log and continue.
    console.warn("[boot] ensureBootstrapAdmin failed (non-fatal):", (e as Error)?.message);
  }
}
