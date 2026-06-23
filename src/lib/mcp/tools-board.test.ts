/**
 * MCP board-tool authz + behaviour matrix (P2). Calls the handlers directly
 * with a principal so the bucket (admin-only) / card (staff create, owner-or-
 * admin mutate, admin-only assign) rules are pinned without the transport.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { resetDb, seedBuckets } from "@/test/db";
import { db, schema } from "@/db";
import type { Principal } from "@/lib/auth";
import { TOOLS, type ToolDef } from "./tools";

const admin: Principal = { kind: "admin", name: "Alex", email: "alex@x.com" };
const memberNoRow: Principal = { kind: "member", name: "Dev Member" }; // owns nothing
const memberSam: Principal = { kind: "member", name: "Sam", email: "sam@x.com" };
const anon: Principal = { kind: "anonymous" };

function tool(name: string): ToolDef {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}
async function run(name: string, p: Principal, args: Record<string, unknown> = {}) {
  return tool(name).handler(p, args as never);
}
async function seedUser(name: string, email: string): Promise<number> {
  const [u] = await db.insert(schema.users).values({ email, displayName: name, role: "member" }).returning({ id: schema.users.id });
  return u.id;
}

describe("MCP board tools", () => {
  let buckets: Awaited<ReturnType<typeof seedBuckets>>;
  beforeEach(async () => {
    await resetDb();
    buckets = await seedBuckets();
  });
  const bId = (k: string) => buckets.find((b) => b.key === k)!.id;

  describe("buckets", () => {
    // Bucket LIFECYCLE (create/rename/delete) was dropped from MCP in the
    // Slice-1.5 (D8) audit — it's web-UI-only now (REST /api/buckets). The agent
    // still reads buckets (it needs their ids to create/move cards).
    it("list_buckets is staff-readable; the mutation tools are not on the MCP surface", () => {
      expect(TOOLS.find((t) => t.name === "list_buckets")).toBeDefined();
      expect(TOOLS.find((t) => t.name === "create_bucket")).toBeUndefined();
      expect(TOOLS.find((t) => t.name === "update_bucket")).toBeUndefined();
      expect(TOOLS.find((t) => t.name === "delete_bucket")).toBeUndefined();
    });

    it("list_buckets: staff yes, anonymous no", async () => {
      expect((await run("list_buckets", memberNoRow)).isError).toBeFalsy();
      expect((await run("list_buckets", anon)).isError).toBe(true);
    });
  });

  describe("cards", () => {
    it("create_card: any staff (member owns nothing in dev → unowned)", async () => {
      const a = await run("create_card", admin, { title: "AdminCard", bucket_key: "backlog" });
      expect(a.isError).toBeFalsy();
      const m = await run("create_card", memberNoRow, { title: "MemberCard", bucket_id: bId("backlog") });
      expect(m.isError).toBeFalsy();
      expect((await run("create_card", anon, { title: "z", bucket_id: bId("backlog") })).isError).toBe(true);
      // requires a bucket
      expect((await run("create_card", admin, { title: "z" })).isError).toBe(true);
    });

    it("member who OWNS a card may update/move/archive it; a non-owner may not", async () => {
      const samId = await seedUser("Sam", "sam@x.com");
      const jId = await seedUser("Jordan", "jordan@x.com");
      const owned = await run("create_card", admin, { title: "Owned", bucket_id: bId("backlog"), owner_user_id: samId });
      const ownedId = (owned.structuredContent as { card: { id: number } }).card.id;
      const others = await run("create_card", admin, { title: "Others", bucket_id: bId("backlog"), owner_user_id: jId });
      const othersId = (others.structuredContent as { card: { id: number } }).card.id;

      expect((await run("update_card", memberSam, { id: ownedId, title: "Edited" })).isError).toBeFalsy();
      expect((await run("move_card", memberSam, { id: ownedId, bucket_id: bId("done") })).isError).toBeFalsy();
      expect((await run("archive_card", memberSam, { id: ownedId })).isError).toBeFalsy();

      expect((await run("update_card", memberSam, { id: othersId, title: "hax" })).isError).toBe(true);
      expect((await run("move_card", memberSam, { id: othersId, bucket_id: bId("done") })).isError).toBe(true);
      expect((await run("archive_card", memberSam, { id: othersId })).isError).toBe(true);
    });

    it("assign_card is admin-only", async () => {
      const samId = await seedUser("Sam", "sam@x.com");
      const c = await run("create_card", admin, { title: "C", bucket_id: bId("backlog"), owner_user_id: samId });
      const id = (c.structuredContent as { card: { id: number } }).card.id;
      expect((await run("assign_card", memberSam, { id, owner_user_id: null })).isError).toBe(true);
      expect((await run("assign_card", admin, { id, owner_user_id: null })).isError).toBeFalsy();
    });

    it("get_card bundles the activity trail; list_cards filters; owner=me sugar", async () => {
      const samId = await seedUser("Sam", "sam@x.com");
      const c = await run("create_card", admin, { title: "C", bucket_id: bId("backlog"), owner_user_id: samId });
      const id = (c.structuredContent as { card: { id: number } }).card.id;
      await run("move_card", admin, { id, bucket_id: bId("review") });

      const got = await run("get_card", admin, { id });
      const sc = got.structuredContent as { activity: { kind: string }[] };
      expect(sc.activity.map((e) => e.kind)).toEqual(["card.created", "card.moved"]);

      const mine = await run("list_cards", memberSam, { owner: "me" });
      expect((mine.structuredContent as { cards: unknown[] }).cards).toHaveLength(1);

      // dev member (no row) → owner=me yields []
      const none = await run("list_cards", memberNoRow, { owner: "me" });
      expect((none.structuredContent as { cards: unknown[] }).cards).toHaveLength(0);
    });
  });
});
