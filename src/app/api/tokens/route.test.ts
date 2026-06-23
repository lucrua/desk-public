/**
 * Token REST + auth-boundary tests (document-host Phase 2, Slice 1).
 *
 * The critical security properties (a minted git credential):
 *   - mint returns the RAW token exactly once and persists ONLY the sha256 hash;
 *   - list/revoke are scoped to the owner — a member cannot see or revoke
 *     another user's token (admin can);
 *   - anonymous is rejected;
 *   - a minted token actually authorizes a git op for its user's space role
 *     (integration with resolveSpaceRole — the git transport's authz primitive).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { resetDb } from "@/test/db";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
import { hashToken } from "@/lib/tokens";
import { GET as listGET, POST as mintPOST } from "./route";
import { DELETE as revokeDELETE } from "./[id]/route";
import { createSpace, setSpaceMemberRole, resolveSpaceRole } from "@/lib/spaces";
import { DEV_MEMBER_TOKEN_NAME } from "@/lib/principal-user";

type Role = "admin" | "member" | "anonymous";
function headers(role: Role): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (role !== "anonymous") h["x-dev-role"] = role;
  return h;
}
function req(url: string, method: string, role: Role, body?: unknown) {
  return new Request(`http://test${url}`, {
    method,
    headers: headers(role),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
const idCtx = (id: string | number) => ({ params: Promise.resolve({ id: String(id) }) });

async function seedAdmin(): Promise<number> {
  const [u] = await db
    .insert(schema.users)
    .values({ tokenName: "owner", displayName: "Owner", role: "admin", active: 1 })
    .returning({ id: schema.users.id });
  return u.id;
}

describe("token REST routes", () => {
  beforeEach(async () => {
    await resetDb();
    // Seed the dev-admin's backing row so the dev `admin` role resolves to it.
    await seedAdmin();
  });

  describe("auth gates", () => {
    it("anonymous → 403 on mint + list + revoke", async () => {
      expect((await mintPOST(req("/api/tokens", "POST", "anonymous", { label: "x" }))).status).toBe(403);
      expect((await listGET(req("/api/tokens", "GET", "anonymous"))).status).toBe(403);
      expect((await revokeDELETE(req("/api/tokens/1", "DELETE", "anonymous"), idCtx(1))).status).toBe(403);
    });

    it("mint rejects a missing/blank label (400)", async () => {
      expect((await mintPOST(req("/api/tokens", "POST", "admin", {}))).status).toBe(400);
      expect((await mintPOST(req("/api/tokens", "POST", "admin", { label: "  " }))).status).toBe(400);
    });
  });

  describe("mint — raw once, only hash stored", () => {
    it("returns the raw token once and persists only its hash", async () => {
      const res = await mintPOST(req("/api/tokens", "POST", "admin", { label: "laptop" }));
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.label).toBe("laptop");
      expect(typeof body.token).toBe("string");
      expect(body.token.length).toBeGreaterThan(20);

      // The DB row stores the HASH, never the raw token.
      const row = await db.query.principalTokens.findFirst({
        where: eq(schema.principalTokens.id, body.id),
      });
      expect(row).toBeTruthy();
      expect(row!.tokenHash).toBe(hashToken(body.token));
      expect(row!.tokenHash).not.toBe(body.token);
      // No column carries the raw token.
      expect(JSON.stringify(row)).not.toContain(body.token);
    });

    it("list never exposes the raw token or hash", async () => {
      const mint = await mintPOST(req("/api/tokens", "POST", "admin", { label: "a" }));
      const { token } = await mint.json();
      const list = await listGET(req("/api/tokens", "GET", "admin"));
      expect(list.status).toBe(200);
      const text = JSON.stringify(await list.json());
      expect(text).not.toContain(token);
      expect(text).not.toContain(hashToken(token));
    });

    // Fix #4: the safe projection is { id, label, lastUsedAt, createdAt,
    // revokedAt } — ownerUserId must NOT leak (scoped OR admin ?all=1).
    it("list projection drops ownerUserId (scoped + ?all=1)", async () => {
      await mintPOST(req("/api/tokens", "POST", "admin", { label: "a" }));
      await mintPOST(req("/api/tokens", "POST", "member", { label: "b" }));

      const scoped = await listGET(req("/api/tokens", "GET", "admin"));
      const scopedTokens = (await scoped.json()).tokens as Record<string, unknown>[];
      expect(scopedTokens.length).toBeGreaterThan(0);
      for (const t of scopedTokens) {
        expect(t).not.toHaveProperty("ownerUserId");
        expect(Object.keys(t).sort()).toEqual(
          ["createdAt", "id", "label", "lastUsedAt", "revokedAt"],
        );
      }

      const all = await listGET(req("/api/tokens?all=1", "GET", "admin"));
      const allTokens = (await all.json()).tokens as Record<string, unknown>[];
      expect(allTokens.length).toBeGreaterThan(0);
      for (const t of allTokens) {
        expect(t).not.toHaveProperty("ownerUserId");
      }
    });
  });

  describe("scoping — owner vs admin", () => {
    it("a member sees only their OWN tokens; admin ?all=1 sees every token", async () => {
      // Admin mints one; member mints one (dev member resolves to its own row).
      await mintPOST(req("/api/tokens", "POST", "admin", { label: "admin-tok" }));
      await mintPOST(req("/api/tokens", "POST", "member", { label: "member-tok" }));

      const memberList = await listGET(req("/api/tokens", "GET", "member"));
      const ml = (await memberList.json()).tokens as { label: string }[];
      expect(ml.map((t) => t.label)).toEqual(["member-tok"]);

      const adminAll = await listGET(req("/api/tokens?all=1", "GET", "admin"));
      const al = (await adminAll.json()).tokens as { label: string }[];
      expect(al.map((t) => t.label).sort()).toEqual(["admin-tok", "member-tok"]);
    });

    it("?all=1 is admin-only (member → 403)", async () => {
      const res = await listGET(req("/api/tokens?all=1", "GET", "member"));
      expect(res.status).toBe(403);
    });

    it("a member CANNOT revoke another user's token (404, no leak)", async () => {
      const adminMint = await mintPOST(req("/api/tokens", "POST", "admin", { label: "admins" }));
      const adminTokId = (await adminMint.json()).id as number;

      const res = await revokeDELETE(req(`/api/tokens/${adminTokId}`, "DELETE", "member"), idCtx(adminTokId));
      expect(res.status).toBe(404);
      // Still live.
      const row = await db.query.principalTokens.findFirst({
        where: eq(schema.principalTokens.id, adminTokId),
      });
      expect(row!.revokedAt).toBeNull();
    });

    it("a member CAN revoke their own token; admin CAN revoke anyone's", async () => {
      const memberMint = await mintPOST(req("/api/tokens", "POST", "member", { label: "mine" }));
      const memberTokId = (await memberMint.json()).id as number;
      const own = await revokeDELETE(req(`/api/tokens/${memberTokId}`, "DELETE", "member"), idCtx(memberTokId));
      expect(own.status).toBe(200);
      let row = await db.query.principalTokens.findFirst({
        where: eq(schema.principalTokens.id, memberTokId),
      });
      expect(row!.revokedAt).not.toBeNull();

      // Admin revoking a member's (fresh) token.
      const memberMint2 = await mintPOST(req("/api/tokens", "POST", "member", { label: "mine2" }));
      const memberTokId2 = (await memberMint2.json()).id as number;
      const byAdmin = await revokeDELETE(req(`/api/tokens/${memberTokId2}`, "DELETE", "admin"), idCtx(memberTokId2));
      expect(byAdmin.status).toBe(200);
      row = await db.query.principalTokens.findFirst({
        where: eq(schema.principalTokens.id, memberTokId2),
      });
      expect(row!.revokedAt).not.toBeNull();
    });

    it("revoking an unknown token → 404", async () => {
      const res = await revokeDELETE(req("/api/tokens/99999", "DELETE", "admin"), idCtx(99999));
      expect(res.status).toBe(404);
    });
  });

  describe("integration — a minted token authorizes a git op for its space role", () => {
    it("a member's minted token resolves to its space role over the git authz primitive", async () => {
      // The dev member needs a backing row + a reader membership on a space the
      // admin owns. Mint the member's token via the endpoint, then check that
      // resolveSpaceRole (the git transport's authz) accepts it as that role.
      const adminId = (await db.query.users.findFirst({ where: eq(schema.users.tokenName, "owner") }))!.id;
      const created = await createSpace("proj", adminId, "private", "test");
      expect(created.ok).toBe(true);

      // Mint a token for the dev member (creates the dev-member user row).
      const mint = await mintPOST(req("/api/tokens", "POST", "member", { label: "git" }));
      const { token } = await mint.json();
      const memberRow = await db.query.users.findFirst({
        where: eq(schema.users.tokenName, DEV_MEMBER_TOKEN_NAME),
      });
      expect(memberRow).toBeTruthy();

      // Add the member as a reader on the space.
      await setSpaceMemberRole("proj", memberRow!.id, "reader", "test");

      // The git transport authz primitive: owner segment = the admin owner's slug.
      const ownerSlug = "owner"; // tokenName-derived owner segment for the admin
      const resolved = await resolveSpaceRole(token, ownerSlug, "proj");
      expect(resolved).not.toBeNull();
      expect(resolved!.role).toBe("reader");
      expect(resolved!.userId).toBe(memberRow!.id);

      // After revoking the token, the same git op is denied (null).
      const tokRow = await db.query.principalTokens.findFirst({
        where: eq(schema.principalTokens.tokenHash, hashToken(token)),
      });
      await revokeDELETE(req(`/api/tokens/${tokRow!.id}`, "DELETE", "member"), idCtx(tokRow!.id));
      const after = await resolveSpaceRole(token, ownerSlug, "proj");
      expect(after).toBeNull();
    });
  });
});
