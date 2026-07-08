/**
 * Resolve a staff principal to a backing `users.id` — the identity a token is
 * minted *for* and scoped *to*. AUTH-SENSITIVE: this is what binds a minted git
 * credential to a real user row, so its determinism matters.
 *
 * Resolution order (first hit wins):
 *   1. `principal.userId` — populated by the Cloudflare auth path + the
 *      bootstrap admin. The authoritative source in production.
 *   2. email / tokenName match against the users table (`resolveMemberUserId`)
 *      — covers principals carrying identity but not a pre-resolved id.
 *   3. DEV-MODE stub fallback (the role-switcher principals carry neither email
 *      nor tokenName, so 1 + 2 both miss). To keep dev a faithful auth rehearsal
 *      we map each dev role to a STABLE, DISTINCT user row:
 *        - dev `admin`  → the lowest-id active admin (the same owner
 *          `ensureDefaultSpace` picks), creating a bootstrap admin if the table
 *          is empty.
 *        - dev `member` → a dedicated, reserved `dev-member` user row (created
 *          on first need). Distinct from the admin so "a member cannot touch
 *          another's token" is a REAL boundary in dev, not a coincidence.
 *
 * The dev fallback runs ONLY in dev auth (never `AUTH_MODE=cloudflare`): in
 * production a principal that reaches step 3 has no row and resolves to null
 * (fail-closed — no silent stub user in prod).
 */
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import type { Principal } from "@/lib/auth";
import { resolveMemberUserId } from "@/lib/cards";
import { assignUserHandle } from "@/lib/user-handle";

/** Reserved tokenName for the dev-mode "member" role-switcher stub user. */
export const DEV_MEMBER_TOKEN_NAME = "dev-member";

/** Reserved display + email-less identity for the dev-mode admin stub, used only
 * when the users table is genuinely empty (fresh dev DB, no bootstrap login). */
const DEV_ADMIN_DISPLAY = "Dev Admin";
const DEV_MEMBER_DISPLAY = "Dev Member";

function devAuthActive(): boolean {
  // Mirror getPrincipal's routing: anything that isn't explicit cloudflare mode
  // is dev auth. The dev stub fallback is gated to this.
  return (process.env.AUTH_MODE ?? "dev") !== "cloudflare";
}

/** Lowest-id active admin, or null. */
async function lowestActiveAdmin(): Promise<number | null> {
  const row = await db.query.users.findFirst({
    where: and(eq(users.role, "admin"), eq(users.active, 1)),
    orderBy: [asc(users.id)],
  });
  return row?.id ?? null;
}

/** Get-or-create the reserved dev-admin stub user (empty-table dev DB only). */
async function ensureDevAdmin(): Promise<number> {
  const existing = await lowestActiveAdmin();
  if (existing != null) return existing;
  const [u] = await db
    .insert(users)
    .values({ tokenName: "dev-admin", displayName: DEV_ADMIN_DISPLAY, role: "admin", active: 1 })
    .onConflictDoNothing()
    .returning({ id: users.id });
  if (u) {
    // Assign the stable owner handle (S1); idempotent on re-entry.
    await assignUserHandle(db, u.id);
    return u.id;
  }
  // Lost the race — re-read.
  const again = await db.query.users.findFirst({
    where: eq(users.tokenName, "dev-admin"),
  });
  await assignUserHandle(db, again!.id);
  return again!.id;
}

/** Get-or-create the reserved dev-member stub user. */
async function ensureDevMember(): Promise<number> {
  const existing = await db.query.users.findFirst({
    where: eq(users.tokenName, DEV_MEMBER_TOKEN_NAME),
  });
  if (existing) return existing.id;
  const [u] = await db
    .insert(users)
    .values({
      tokenName: DEV_MEMBER_TOKEN_NAME,
      displayName: DEV_MEMBER_DISPLAY,
      role: "member",
      active: 1,
    })
    .onConflictDoNothing()
    .returning({ id: users.id });
  if (u) {
    // Assign the stable owner handle (S1); idempotent on re-entry.
    await assignUserHandle(db, u.id);
    return u.id;
  }
  const again = await db.query.users.findFirst({
    where: eq(users.tokenName, DEV_MEMBER_TOKEN_NAME),
  });
  await assignUserHandle(db, again!.id);
  return again!.id;
}

/**
 * Resolve the current principal to a backing users.id, applying the dev-mode
 * stub fallback. Returns null for anonymous principals and for any principal
 * with no resolvable row in production (fail-closed).
 */
export async function resolvePrincipalUserId(
  principal: Principal,
): Promise<number | null> {
  if (principal.kind === "anonymous") return null;
  if (principal.userId != null) return principal.userId;

  const byIdentity = await resolveMemberUserId(principal);
  if (byIdentity != null) return byIdentity;

  if (!devAuthActive()) return null; // no stubs in production

  return principal.kind === "admin" ? ensureDevAdmin() : ensureDevMember();
}
