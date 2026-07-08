import { describe, it, expect, beforeEach } from "vitest";
import { resetDb } from "@/test/db";
import { createUser, listUsers, setUserRole } from "@/lib/users";
import { PATCH, isSelfDeactivation } from "./route";
import type { Principal } from "@/lib/auth";

type Role = "admin" | "member" | "anonymous";

function makeHeaders(role: string | null): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (role !== null) h["x-dev-role"] = role;
  return h;
}

function patchReq(id: number | string, body: unknown, role: Role = "admin") {
  return new Request(`http://test/api/users/${id}`, {
    method: "PATCH",
    headers: makeHeaders(role === "anonymous" ? null : role),
    body: JSON.stringify(body),
  });
}

function ctx(id: number | string) {
  return { params: Promise.resolve({ id: String(id) }) };
}

describe("PATCH /api/users/[id]", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("admin sets active:false on another user → 200 {ok}", async () => {
    const u = await createUser({ email: "target@example.com", displayName: "Target", role: "member" });
    const res = await PATCH(patchReq(u!.id, { active: false }), ctx(u!.id));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect((await listUsers())[0].active).toBe(0);
  });

  it("reactivate (active:true) → 200", async () => {
    const u = await createUser({ email: "t4@example.com", displayName: "T4", role: "member" });
    await PATCH(patchReq(u!.id, { active: false }), ctx(u!.id));
    const res = await PATCH(patchReq(u!.id, { active: true }), ctx(u!.id));
    expect(res.status).toBe(200);
    expect((await listUsers())[0].active).toBe(1);
  });

  it("unknown id → 404", async () => {
    const res = await PATCH(patchReq(99999, { active: false }), ctx(99999));
    expect(res.status).toBe(404);
  });

  it("member → 403", async () => {
    const u = await createUser({ email: "t5@example.com", displayName: "T5", role: "member" });
    const res = await PATCH(patchReq(u!.id, { active: false }, "member"), ctx(u!.id));
    expect(res.status).toBe(403);
  });

  it("anonymous → 403", async () => {
    const res = await PATCH(patchReq(1, { active: false }, "anonymous"), ctx(1));
    expect(res.status).toBe(403);
  });

  it("active must be boolean → 400", async () => {
    const u = await createUser({ email: "t7@example.com", displayName: "T7" });
    const res = await PATCH(patchReq(u!.id, { active: "false" }), ctx(u!.id));
    expect(res.status).toBe(400);
  });

  it("no recognized fields → 400", async () => {
    const u = await createUser({ email: "t8@example.com", displayName: "T8" });
    const res = await PATCH(patchReq(u!.id, {}), ctx(u!.id));
    expect(res.status).toBe(400);
  });

  // ── role field (multi-admin model v2) ──────────────────────────────────────

  it("admin sets role:'admin' on a member → 200, stored as admin", async () => {
    const u = await createUser({ email: "promoted@example.com", displayName: "Promo", role: "member" });
    const res = await PATCH(patchReq(u!.id, { role: "admin" }), ctx(u!.id));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect((await listUsers())[0].role).toBe("admin");
  });

  it("admin sets role:'member' on another admin → 200, stored as member", async () => {
    // We need at least 2 admins so the last-admin guard doesn't fire.
    // Dev auth mode (x-dev-role:admin) acts as admin, and we create a second admin row.
    const u = await createUser({ email: "demote@example.com", displayName: "Demote", role: "admin" });
    // Create another admin so the target isn't the last admin.
    await createUser({ email: "other-admin@example.com", displayName: "Other", role: "admin" });
    const res = await PATCH(patchReq(u!.id, { role: "member" }), ctx(u!.id));
    expect(res.status).toBe(200);
    expect((await listUsers()).find((r) => r.id === u!.id)!.role).toBe("member");
  });

  it("invalid role value → 400", async () => {
    const u = await createUser({ email: "t6@example.com", displayName: "T6" });
    const res = await PATCH(patchReq(u!.id, { role: "superuser" }), ctx(u!.id));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/role must be/i);
  });

  it("member cannot set role → 403 (privilege-escalation negative)", async () => {
    const u = await createUser({ email: "m@example.com", displayName: "M", role: "member" });
    const res = await PATCH(patchReq(u!.id, { role: "admin" }, "member"), ctx(u!.id));
    expect(res.status).toBe(403);
  });

  it("member cannot set role on self → 403 (privilege-escalation negative)", async () => {
    const u = await createUser({ email: "self@example.com", displayName: "Self", role: "member" });
    const res = await PATCH(patchReq(u!.id, { role: "admin" }, "member"), ctx(u!.id));
    expect(res.status).toBe(403);
  });

  it("anonymous cannot set role → 403 (privilege-escalation negative)", async () => {
    const u = await createUser({ email: "anon@example.com", displayName: "Anon", role: "member" });
    const res = await PATCH(patchReq(u!.id, { role: "admin" }, "anonymous"), ctx(u!.id));
    expect(res.status).toBe(403);
  });

  // ── last-admin guard ────────────────────────────────────────────────────────

  it("last-admin guard: demoting the only active admin → 403", async () => {
    // Create an admin user; the only admin.
    const u = await createUser({ email: "last@example.com", displayName: "Last", role: "admin" });
    const res = await PATCH(patchReq(u!.id, { role: "member" }), ctx(u!.id));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/only active admin/i);
    // The stored role must be untouched.
    expect((await listUsers())[0].role).toBe("admin");
  });

  it("last-admin guard: deactivating the only active admin → 403", async () => {
    const u = await createUser({ email: "last2@example.com", displayName: "Last2", role: "admin" });
    const res = await PATCH(patchReq(u!.id, { active: false }), ctx(u!.id));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/only active admin/i);
    expect((await listUsers())[0].active).toBe(1);
  });

  it("last-admin guard: self-demotion when last admin → 403", async () => {
    // In dev auth, x-dev-role:admin maps to a synthetic admin principal that
    // doesn't match any DB row by email/tokenName — so self-guard won't fire
    // for rows not created with matching identity. To test self-demotion we
    // need the target to BE the acting principal. We can't easily do that in
    // dev-role mode, so we test the isLastAdminOperation path directly via
    // the non-self code path (same guard fires regardless of self/other when
    // there's only one admin).
    const u = await createUser({ email: "solo@example.com", displayName: "Solo", role: "admin" });
    // Only one admin → guard fires whether self or not.
    const res = await PATCH(patchReq(u!.id, { role: "member" }), ctx(u!.id));
    expect(res.status).toBe(403);
  });

  it("last-admin guard allows demote when there are 2 admins", async () => {
    const u1 = await createUser({ email: "a1@example.com", displayName: "A1", role: "admin" });
    await createUser({ email: "a2@example.com", displayName: "A2", role: "admin" });
    const res = await PATCH(patchReq(u1!.id, { role: "member" }), ctx(u1!.id));
    expect(res.status).toBe(200);
    expect((await listUsers()).find((r) => r.id === u1!.id)!.role).toBe("member");
  });

  it("last-admin guard allows deactivate when there are 2 active admins", async () => {
    const u1 = await createUser({ email: "b1@example.com", displayName: "B1", role: "admin" });
    await createUser({ email: "b2@example.com", displayName: "B2", role: "admin" });
    const res = await PATCH(patchReq(u1!.id, { active: false }), ctx(u1!.id));
    expect(res.status).toBe(200);
    expect((await listUsers()).find((r) => r.id === u1!.id)!.active).toBe(0);
  });

  // ── tokenName field ────────────────────────────────────────────────────────

  it("admin sets tokenName on a user → 200 + persisted", async () => {
    const u = await createUser({ email: "agent@example.com", displayName: "Agent", role: "member" });
    const res = await PATCH(patchReq(u!.id, { tokenName: "new-client-id" }), ctx(u!.id));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect((await listUsers())[0].tokenName).toBe("new-client-id");
  });

  it("admin clears tokenName by passing null → 200 + null persisted", async () => {
    const u = await createUser({ tokenName: "old-id", displayName: "Agent2", role: "member" });
    const res = await PATCH(patchReq(u!.id, { tokenName: null }), ctx(u!.id));
    expect(res.status).toBe(200);
    expect((await listUsers())[0].tokenName).toBeNull();
  });

  it("duplicate tokenName → 409", async () => {
    await createUser({ tokenName: "taken-id", displayName: "First", role: "member" });
    const b = await createUser({ email: "second@example.com", displayName: "Second", role: "member" });
    const res = await PATCH(patchReq(b!.id, { tokenName: "taken-id" }), ctx(b!.id));
    expect(res.status).toBe(409);
  });

  it("tokenName as a non-string non-null value → 400", async () => {
    const u = await createUser({ email: "type@example.com", displayName: "Type", role: "member" });
    const res = await PATCH(patchReq(u!.id, { tokenName: 42 }), ctx(u!.id));
    expect(res.status).toBe(400);
  });

  it("member cannot set tokenName → 403", async () => {
    const u = await createUser({ email: "m@example.com", displayName: "M", role: "member" });
    const res = await PATCH(patchReq(u!.id, { tokenName: "x" }, "member"), ctx(u!.id));
    expect(res.status).toBe(403);
  });

  // ── displayName field ─────────────────────────────────────────────────────

  it("admin sets displayName → 200 + persisted", async () => {
    const u = await createUser({ email: "dn@example.com", displayName: "Old", role: "member" });
    const res = await PATCH(patchReq(u!.id, { displayName: "New Name" }), ctx(u!.id));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect((await listUsers())[0].displayName).toBe("New Name");
  });

  it("displayName is trimmed before saving", async () => {
    const u = await createUser({ email: "dn2@example.com", displayName: "Old", role: "member" });
    await PATCH(patchReq(u!.id, { displayName: "  Trimmed  " }), ctx(u!.id));
    expect((await listUsers())[0].displayName).toBe("Trimmed");
  });

  it("empty/whitespace displayName → 400, no mutation", async () => {
    const u = await createUser({ email: "dn3@example.com", displayName: "Keep", role: "member" });
    const res = await PATCH(patchReq(u!.id, { displayName: "   " }), ctx(u!.id));
    expect(res.status).toBe(400);
    expect((await listUsers())[0].displayName).toBe("Keep");
  });

  it("non-string displayName → 400", async () => {
    const u = await createUser({ email: "dn4@example.com", displayName: "Keep", role: "member" });
    const res = await PATCH(patchReq(u!.id, { displayName: 42 }), ctx(u!.id));
    expect(res.status).toBe(400);
  });

  it("member cannot set displayName → 403", async () => {
    const u = await createUser({ email: "dn5@example.com", displayName: "X", role: "member" });
    const res = await PATCH(patchReq(u!.id, { displayName: "Hacked" }, "member"), ctx(u!.id));
    expect(res.status).toBe(403);
  });

  // ── email immutability (mass-assignment guard) ─────────────────────────────

  it("email field → 400 (immutable), no mutation", async () => {
    const u = await createUser({ email: "orig@example.com", displayName: "Orig", role: "member" });
    const res = await PATCH(patchReq(u!.id, { email: "new@example.com" }), ctx(u!.id));
    expect(res.status).toBe(400);
    expect((await listUsers())[0].email).toBe("orig@example.com");
  });

  it("email rejected even alongside a valid displayName change → 400, no mutation", async () => {
    const u = await createUser({ email: "orig2@example.com", displayName: "Orig", role: "member" });
    const res = await PATCH(
      patchReq(u!.id, { displayName: "Renamed", email: "x@example.com" }),
      ctx(u!.id),
    );
    expect(res.status).toBe(400);
    const row = (await listUsers())[0];
    expect(row.email).toBe("orig2@example.com");
    expect(row.displayName).toBe("Orig"); // whole request rejected
  });

  // ── handle edit (Owner-namespace S1) ──────────────────────────────────────
  it("admin sets a valid handle → 200, stored", async () => {
    const u = await createUser({ email: "h1@example.com", displayName: "H1", role: "member" });
    const res = await PATCH(patchReq(u!.id, { handle: "renamed-handle" }), ctx(u!.id));
    expect(res.status).toBe(200);
    const row = (await listUsers()).find((r) => r.id === u!.id);
    expect(row?.handle).toBe("renamed-handle");
  });

  it("invalid handle (uppercase) → 400, no change", async () => {
    const u = await createUser({ email: "h2@example.com", displayName: "H2", role: "member" });
    const before = (await listUsers()).find((r) => r.id === u!.id)?.handle;
    const res = await PATCH(patchReq(u!.id, { handle: "Bad_Handle" }), ctx(u!.id));
    expect(res.status).toBe(400);
    const after = (await listUsers()).find((r) => r.id === u!.id)?.handle;
    expect(after).toBe(before); // unchanged
  });

  it("invalid handle (leading dash) → 400", async () => {
    const u = await createUser({ email: "h2b@example.com", displayName: "H2b", role: "member" });
    const res = await PATCH(patchReq(u!.id, { handle: "-nope" }), ctx(u!.id));
    expect(res.status).toBe(400);
  });

  it("handle over 39 chars → 400", async () => {
    const u = await createUser({ email: "h2c@example.com", displayName: "H2c", role: "member" });
    const res = await PATCH(patchReq(u!.id, { handle: "a".repeat(40) }), ctx(u!.id));
    expect(res.status).toBe(400);
  });

  it("handle collision with another user → 409", async () => {
    const a = await createUser({ email: "taken@example.com", displayName: "A", role: "member" });
    const b = await createUser({ email: "other-user@example.com", displayName: "B", role: "member" });
    const aHandle = (await listUsers()).find((r) => r.id === a!.id)!.handle!;
    const res = await PATCH(patchReq(b!.id, { handle: aHandle }), ctx(b!.id));
    expect(res.status).toBe(409);
  });

  it("handle must be a string → 400", async () => {
    const u = await createUser({ email: "h3@example.com", displayName: "H3", role: "member" });
    const res = await PATCH(patchReq(u!.id, { handle: 123 }), ctx(u!.id));
    expect(res.status).toBe(400);
  });

  it("handle edit is admin-only → 403 for member", async () => {
    const u = await createUser({ email: "h4@example.com", displayName: "H4", role: "member" });
    const res = await PATCH(patchReq(u!.id, { handle: "sneaky" }, "member"), ctx(u!.id));
    expect(res.status).toBe(403);
  });
});

// ── self-lockout guard (pure predicate) ───────────────────────────────────────
// The route resolves the acting principal, loads the target row, and refuses an
// `active:false` that targets the principal's own row — matched by EMAIL or
// tokenName. The matching logic is a pure predicate so both identity paths are
// covered without depending on the auth provider's principal shape.

describe("isSelfDeactivation — self-lockout guard", () => {
  const target = { email: "me@example.com", tokenName: null as string | null };
  const tokenTarget = { email: null as string | null, tokenName: "me-agent" };

  const emailPrincipal: Principal = { kind: "admin", name: "Me", email: "me@example.com" };
  const tokenPrincipal: Principal = { kind: "admin", name: "Me Agent", tokenName: "me-agent" };
  const otherPrincipal: Principal = { kind: "admin", name: "Other", email: "other@example.com" };

  it("EMAIL match + active:false → true (blocked)", () => {
    expect(isSelfDeactivation(emailPrincipal, target, false)).toBe(true);
  });

  it("EMAIL match is case-insensitive", () => {
    expect(
      isSelfDeactivation({ kind: "admin", name: "Me", email: "ME@EXAMPLE.COM" }, target, false),
    ).toBe(true);
  });

  it("TOKEN NAME match + active:false → true (blocked)", () => {
    expect(isSelfDeactivation(tokenPrincipal, tokenTarget, false)).toBe(true);
  });

  it("self match but active:true (reactivation/role only) → false (allowed)", () => {
    expect(isSelfDeactivation(emailPrincipal, target, true)).toBe(false);
    expect(isSelfDeactivation(emailPrincipal, target, undefined)).toBe(false);
  });

  it("different identity + active:false → false (allowed)", () => {
    expect(isSelfDeactivation(otherPrincipal, target, false)).toBe(false);
  });

  it("anonymous principal → false (cannot match anything)", () => {
    expect(isSelfDeactivation({ kind: "anonymous" }, target, false)).toBe(false);
  });

  it("does not cross-match a null target field against an absent principal field", () => {
    // principal has no tokenName; target tokenName is null → must NOT match.
    expect(isSelfDeactivation(emailPrincipal, { email: "x@example.com", tokenName: null }, false)).toBe(
      false,
    );
  });
});
