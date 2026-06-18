import { describe, it, expect, beforeEach } from "vitest";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
import { resetDb, seedAudiences, seedUser, publishDocOk } from "@/test/db";
import type { Principal } from "@/lib/auth";
import { TOOLS, type ToolDef } from "./tools";

/**
 * MCP membership tools (Audiences v2): list_audience_members / add_audience_member
 * / remove_audience_member — authz matrix + the end-to-end visibility effect
 * (adding a member makes a hidden audience's docs show up in their list_docs).
 */

const admin: Principal = { kind: "admin", name: "Admin", email: "admin@desk.test" };
// A member principal carrying an email so resolveMemberUserId can match a row.
const bobPrincipal: Principal = { kind: "member", name: "Bob", email: "bob@x.com" };

function tool(name: string): ToolDef {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}
async function run(name: string, p: Principal, args: Record<string, unknown> = {}) {
  return tool(name).handler(p, args as never);
}
async function audienceId(key: string): Promise<number> {
  const a = await db.query.audiences.findFirst({ where: eq(schema.audiences.key, key) });
  if (!a) throw new Error(`no audience ${key}`);
  return a.id;
}

describe("MCP audience-member tools", () => {
  beforeEach(async () => {
    await resetDb();
    await seedAudiences(); // team(visible) / alice / bob
    await publishDocOk({
      slug: "bob-doc",
      title: "Bob Doc",
      sourcePath: "os/d.md",
      audience: "bob",
      format: "md",
      content: "# Bob",
      by: "admin",
    });
  });

  it("the three tools exist in the registry", () => {
    for (const n of ["list_audience_members", "add_audience_member", "remove_audience_member"]) {
      expect(TOOLS.find((t) => t.name === n)).toBeTruthy();
    }
  });

  it("writes are admin-only; reads are staff", async () => {
    const bobAud = await audienceId("bob");
    expect((await run("add_audience_member", bobPrincipal, { id: bobAud, user_id: 1 })).isError).toBe(true);
    expect((await run("remove_audience_member", bobPrincipal, { id: bobAud, user_id: 1 })).isError).toBe(true);
    // member CAN read the roster.
    const list = await run("list_audience_members", bobPrincipal, { id: bobAud });
    expect(list.isError).toBeUndefined();
  });

  it("add → the member now sees the hidden audience's doc via list_docs; remove → it disappears", async () => {
    const bobAud = await audienceId("bob");
    const bobId = await seedUser({ email: "bob@x.com", displayName: "Bob" });

    // Before: not a member → can't see bob-doc.
    const before = await run("list_docs", bobPrincipal, {});
    expect((before.structuredContent as { docs: { slug: string }[] }).docs.map((d) => d.slug)).not.toContain("bob-doc");

    // Admin adds them.
    const add = await run("add_audience_member", admin, { id: bobAud, user_id: bobId });
    expect(add.isError).toBeUndefined();
    expect((add.structuredContent as { added: boolean }).added).toBe(true);

    // After: visible.
    const after = await run("list_docs", bobPrincipal, {});
    expect((after.structuredContent as { docs: { slug: string }[] }).docs.map((d) => d.slug)).toContain("bob-doc");

    // list shows them.
    const roster = await run("list_audience_members", admin, { id: bobAud });
    expect((roster.structuredContent as { members: unknown[] }).members).toHaveLength(1);

    // Remove → gone again.
    const rm = await run("remove_audience_member", admin, { id: bobAud, user_id: bobId });
    expect(rm.isError).toBeUndefined();
    const post = await run("list_docs", bobPrincipal, {});
    expect((post.structuredContent as { docs: { slug: string }[] }).docs.map((d) => d.slug)).not.toContain("bob-doc");
  });

  it("typed errors: unknown audience / unknown user / not-a-member", async () => {
    const bobAud = await audienceId("bob");
    const u = await seedUser({ email: "bob@x.com", displayName: "Bob" });
    expect((await run("add_audience_member", admin, { id: 999999, user_id: u })).isError).toBe(true);
    expect((await run("add_audience_member", admin, { id: bobAud, user_id: 999999 })).isError).toBe(true);
    expect((await run("remove_audience_member", admin, { id: bobAud, user_id: u })).isError).toBe(true);
    expect((await run("list_audience_members", admin, { id: 999999 })).isError).toBe(true);
  });
});
