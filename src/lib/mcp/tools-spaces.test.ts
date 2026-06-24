import { describe, it, expect, beforeEach } from "vitest";
import { resetDb } from "@/test/db";
import { db, schema } from "@/db";
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

describe("MCP space tools (parity with /api/spaces)", () => {
  let adminId: number;
  let admin: Principal;
  const member: Principal = { kind: "member", name: "M" };
  const anon: Principal = { kind: "anonymous" };

  beforeEach(async () => {
    await resetDb();
    adminId = await seedUser("admin", "admin");
    admin = { kind: "admin", name: "Admin", tokenName: "admin", userId: adminId };
  });

  it("create_space is admin-only; member + anon are rejected", async () => {
    expect((await run("create_space", anon, { slug: "x" })).isError).toBe(true);
    expect((await run("create_space", member, { slug: "x" })).isError).toBe(true);
  });

  it("admin creates a space, list_spaces returns it", async () => {
    const created = await run("create_space", admin, { slug: "proj", visibility: "unlisted" });
    expect(created.isError).toBeFalsy();
    expect(created.structuredContent?.space).toMatchObject({ slug: "proj", visibility: "unlisted" });

    const listed = await run("list_spaces", admin);
    expect(listed.isError).toBeFalsy();
    const spaces = listed.structuredContent?.spaces as Array<{ slug: string }>;
    expect(spaces.map((s) => s.slug)).toContain("proj");
  });

  it("set_space_member upserts then removes a role; owner is guarded", async () => {
    await run("create_space", admin, { slug: "g" });
    const u = await seedUser("u");
    const add = await run("set_space_member", admin, { slug: "g", user_id: u, role: "writer" });
    expect(add.structuredContent?.role).toBe("writer");
    const rm = await run("set_space_member", admin, { slug: "g", user_id: u, role: null });
    expect(rm.structuredContent?.role).toBe(null);
    // Owner cannot be demoted.
    const ownerDemote = await run("set_space_member", admin, { slug: "g", user_id: adminId, role: "reader" });
    expect(ownerDemote.isError).toBe(true);
  });

  it("list_spaces is staff-scoped: a member sees only spaces they belong to", async () => {
    await run("create_space", admin, { slug: "private-space" });
    // member with no membership → empty
    const listed = await run("list_spaces", member);
    expect((listed.structuredContent?.spaces as unknown[]).length).toBe(0);
  });

  describe("create_invite (External Collaboration E1)", () => {
    it("admin mints an invite → one-time inviteUrl", async () => {
      await run("create_space", admin, { slug: "proj" });
      const r = await run("create_invite", admin, { slug: "proj", role: "writer" });
      expect(r.isError).toBeFalsy();
      const sc = r.structuredContent as { inviteUrl: string; role: string };
      expect(sc.inviteUrl).toContain("/invite/");
      expect(sc.role).toBe("writer");
    });

    it("a non-owner member is rejected (admin/owner only)", async () => {
      await run("create_space", admin, { slug: "proj" });
      const r = await run("create_invite", member, { slug: "proj", role: "reader" });
      expect(r.isError).toBe(true);
    });

    it("anonymous is rejected", async () => {
      await run("create_space", admin, { slug: "proj" });
      const r = await run("create_invite", anon, { slug: "proj", role: "reader" });
      expect(r.isError).toBe(true);
    });

    it("unknown space → error", async () => {
      const r = await run("create_invite", admin, { slug: "nope", role: "writer" });
      expect(r.isError).toBe(true);
    });
  });
});
