import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getPrincipal } from "@/lib/auth";
import type { Principal } from "@/lib/auth";
import { db, schema } from "@/db";
import {
  setUserTokenName,
  setUserDisplayName,
  applyAdminMutation,
  isLastAdminOperation,
  type Role,
} from "@/lib/users";

function err(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Returns true when the acting principal's identity matches the target row
 * (by email OR tokenName). Used by both lockout guards.
 */
function isSelf(
  principal: Principal,
  target: { email: string | null; tokenName: string | null },
): boolean {
  if (principal.kind === "anonymous") return false;

  // Match against ALL of the principal's emails (multi-email): a login via a
  // secondary address is still "me", so the self-guard must hold for the target
  // row's primary email if it's ANY of the principal's emails. Fall back to the
  // single `email` field for principals that don't carry the full set.
  const pEmails = (
    principal.emails ?? (principal.email ? [principal.email] : [])
  ).map((e) => e.trim().toLowerCase());
  const pToken = principal.tokenName?.trim();

  const targetEmail = target.email?.toLowerCase();
  const emailMatch =
    targetEmail != null && pEmails.includes(targetEmail);
  const tokenMatch = pToken != null && target.tokenName != null && target.tokenName === pToken;

  return emailMatch || tokenMatch;
}

/**
 * Self-lockout guard. Returns true when the acting principal is trying to set
 * its OWN row inactive (active === false). Matched by email OR tokenName, so the
 * guard holds for both human and service-token admins. A null target field never
 * matches an absent principal field (no cross-matching).
 */
export function isSelfDeactivation(
  principal: Principal,
  target: { email: string | null; tokenName: string | null },
  active: boolean | undefined,
): boolean {
  if (active !== false) return false; // only deactivation can lock you out
  return isSelf(principal, target);
}

export async function PATCH(req: Request, { params }: RouteContext) {
  const principal = await getPrincipal(req.headers);
  if (principal.kind !== "admin") {
    return err(403, "Forbidden — admin only");
  }

  const { id: idStr } = await params;
  const id = parseInt(idStr, 10);
  if (Number.isNaN(id)) {
    return err(400, "Invalid id — must be a numeric user id");
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err(400, "Invalid JSON body");
  }

  const b = body as Record<string, unknown>;
  const hasActive = "active" in b;
  const hasRole = "role" in b;
  const hasTokenName = "tokenName" in b;
  const hasDisplayName = "displayName" in b;
  // email is intentionally NOT accepted — it's immutable (mass-assignment guard).
  const hasEmail = "email" in b;

  // Email is immutable — reject any attempt rather than silently ignoring it.
  if (hasEmail) {
    return err(400, "email is immutable");
  }
  if (!hasActive && !hasRole && !hasTokenName && !hasDisplayName) {
    return err(
      400,
      "Provide at least one of: active (boolean), role ('admin'|'member'), tokenName (string|null), displayName (string)",
    );
  }
  if (hasActive && typeof b.active !== "boolean") {
    return err(400, "active must be a boolean");
  }
  if (hasRole && b.role !== "admin" && b.role !== "member") {
    return err(400, "role must be 'admin' or 'member'");
  }
  if (hasTokenName && b.tokenName !== null && typeof b.tokenName !== "string") {
    return err(400, "tokenName must be a string or null");
  }
  if (
    hasDisplayName &&
    (typeof b.displayName !== "string" || b.displayName.trim().length === 0)
  ) {
    return err(400, "displayName must be a non-empty string");
  }

  const active = hasActive ? (b.active as boolean) : undefined;
  const role = hasRole ? (b.role as Role) : undefined;
  const tokenName = hasTokenName ? (b.tokenName as string | null) : undefined;
  const displayName = hasDisplayName ? (b.displayName as string) : undefined;

  // Load the target row so the self-lockout guard can match on identity, and so
  // we can return 404 for an unknown id before mutating anything.
  const targetRows = await db
    .select({
      id: schema.users.id,
      email: schema.users.email,
      tokenName: schema.users.tokenName,
      role: schema.users.role,
      active: schema.users.active,
    })
    .from(schema.users)
    .where(eq(schema.users.id, id))
    .limit(1);

  if (targetRows.length === 0) {
    return err(404, `User ${id} not found`);
  }
  const target = targetRows[0];

  if (isSelfDeactivation(principal, target, active)) {
    return err(403, "You can't deactivate yourself — ask another admin to do it.");
  }

  // Self-demotion guard (covers the "last admin demotes themselves" path).
  if (hasRole && role === "member" && isSelf(principal, target)) {
    const lastAdmin = await isLastAdminOperation(id, { newRole: role });
    if (lastAdmin) {
      return err(403, "You are the only active admin — promote another user to admin before changing your own role.");
    }
  }

  // Last-admin guard for demote (non-self) and deactivate paths.
  if (hasRole && role === "member" && !isSelf(principal, target)) {
    const lastAdmin = await isLastAdminOperation(id, { newRole: role });
    if (lastAdmin) {
      return err(403, "Cannot demote the only active admin — promote another user to admin first.");
    }
  }
  if (hasActive && active === false) {
    const lastAdmin = await isLastAdminOperation(id, { activeChange: false });
    if (lastAdmin) {
      return err(403, "Cannot deactivate the only active admin — promote another user to admin first.");
    }
  }

  if (displayName !== undefined) {
    await setUserDisplayName(id, displayName);
  }
  // Apply role and/or active atomically under the admin-set advisory lock so the
  // last-admin invariant can't be raced (TOCTOU). The pre-flight guards above
  // give specific messages on the common path; this re-checks INSIDE the lock and
  // catches a mutation that only loses the invariant under a concurrent race.
  if (role !== undefined || active !== undefined) {
    const result = await applyAdminMutation(id, { newRole: role, active });
    if (result === "last-admin") {
      // Pick the message matching the operation that would remove the admin.
      if (active === false) {
        return err(403, "Cannot deactivate the only active admin — promote another user to admin first.");
      }
      if (isSelf(principal, target)) {
        return err(403, "You are the only active admin — promote another user to admin before changing your own role.");
      }
      return err(403, "Cannot demote the only active admin — promote another user to admin first.");
    }
  }
  if (tokenName !== undefined) {
    const result = await setUserTokenName(id, tokenName);
    if (result === "duplicate") {
      return err(409, "tokenName already in use by another user");
    }
    // "not-found" is already handled above by the target-row load; this
    // branch means the row disappeared between the two DB calls — harmless.
  }

  return NextResponse.json({ ok: true });
}
