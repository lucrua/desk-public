/**
 * MCP principal-token tools (parity with /api/tokens) — auth-boundary tests.
 *
 * Mirrors the REST tests: raw-once, hash-only persistence, owner-scoped
 * list/revoke, admin all=true, and a not-found (no-leak) revoke of another's
 * token. A CF-style principal carries `userId` directly; we use those here so
 * the tools resolve a real backing user without the dev stub.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { resetDb } from "@/test/db";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
import { hashToken } from "@/lib/tokens";
import type { Principal } from "@/lib/auth";
import { TOOLS, type ToolDef } from "./tools";

function tool(name: string): ToolDef {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}
function run(name: string, principal: Principal, args: Record<string, unknown> = {}) {
  return tool(name).handler(principal, args as never);
}
async function seedUser(tokenName: string, role: "admin" | "member" = "member"): Promise<number> {
  const [u] = await db
    .insert(schema.users)
    .values({ tokenName, displayName: tokenName, role, active: 1 })
    .returning({ id: schema.users.id });
  return u.id;
}

describe("MCP token tools (parity with /api/tokens)", () => {
  let adminId: number;
  let memberId: number;
  let admin: Principal;
  let member: Principal;
  const anon: Principal = { kind: "anonymous" };

  beforeEach(async () => {
    await resetDb();
    adminId = await seedUser("admin", "admin");
    memberId = await seedUser("memberx", "member");
    admin = { kind: "admin", name: "Admin", tokenName: "admin", userId: adminId };
    member = { kind: "member", name: "Member", tokenName: "memberx", userId: memberId };
  });

  it("anonymous is rejected on all three tools", async () => {
    expect((await run("create_token", anon, { label: "x" })).isError).toBe(true);
    expect((await run("list_tokens", anon)).isError).toBe(true);
    expect((await run("revoke_token", anon, { id: 1 })).isError).toBe(true);
  });

  it("create_token returns the raw token once; only the hash is stored", async () => {
    const r = await run("create_token", admin, { label: "laptop" });
    expect(r.isError).toBeFalsy();
    const token = r.structuredContent?.token as string;
    const id = r.structuredContent?.id as number;
    expect(typeof token).toBe("string");
    const row = await db.query.principalTokens.findFirst({
      where: eq(schema.principalTokens.id, id),
    });
    expect(row!.tokenHash).toBe(hashToken(token));
    expect(row!.tokenHash).not.toBe(token);
  });

  it("list_tokens is owner-scoped; all=true is admin-only", async () => {
    await run("create_token", admin, { label: "admin-tok" });
    await run("create_token", member, { label: "member-tok" });

    const memberList = await run("list_tokens", member);
    const ml = memberList.structuredContent?.tokens as { label: string }[];
    expect(ml.map((t) => t.label)).toEqual(["member-tok"]);

    const adminAll = await run("list_tokens", admin, { all: true });
    const al = adminAll.structuredContent?.tokens as { label: string }[];
    expect(al.map((t) => t.label).sort()).toEqual(["admin-tok", "member-tok"]);

    // member all=true → error
    expect((await run("list_tokens", member, { all: true })).isError).toBe(true);
  });

  it("revoke_token: a member cannot revoke another's token (not-found); own + admin works", async () => {
    const adminTok = await run("create_token", admin, { label: "a" });
    const adminTokId = adminTok.structuredContent?.id as number;
    // member tries to revoke admin's token → not-found error, still live.
    const denied = await run("revoke_token", member, { id: adminTokId });
    expect(denied.isError).toBe(true);
    let row = await db.query.principalTokens.findFirst({
      where: eq(schema.principalTokens.id, adminTokId),
    });
    expect(row!.revokedAt).toBeNull();

    // member revokes own.
    const memberTok = await run("create_token", member, { label: "m" });
    const memberTokId = memberTok.structuredContent?.id as number;
    const own = await run("revoke_token", member, { id: memberTokId });
    expect(own.isError).toBeFalsy();
    row = await db.query.principalTokens.findFirst({
      where: eq(schema.principalTokens.id, memberTokId),
    });
    expect(row!.revokedAt).not.toBeNull();

    // admin revokes admin's.
    const byAdmin = await run("revoke_token", admin, { id: adminTokId });
    expect(byAdmin.isError).toBeFalsy();

    // unknown id → not-found.
    expect((await run("revoke_token", admin, { id: 99999 })).isError).toBe(true);
  });
});
