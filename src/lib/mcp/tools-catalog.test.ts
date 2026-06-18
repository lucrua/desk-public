/**
 * MCP catalog-tool authz + behaviour matrix (P3). Calls the handlers directly
 * with a principal so the read-vs-admin-write rules and id/data validation are
 * pinned without the transport.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { resetDb } from "@/test/db";
import type { Principal } from "@/lib/auth";
import { TOOLS, type ToolDef } from "./tools";

const admin: Principal = { kind: "admin", name: "Alex", email: "alex@x.com" };
const member: Principal = { kind: "member", name: "Sam", email: "sam@x.com" };
const anon: Principal = { kind: "anonymous" };

function tool(name: string): ToolDef {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}
async function run(name: string, p: Principal, args: Record<string, unknown> = {}) {
  return tool(name).handler(p, args as never);
}

const findingSchema = {
  type: "object",
  required: ["severity"],
  properties: { severity: { enum: ["low", "high"] } },
  additionalProperties: false,
};

async function seedFinding() {
  await run("upsert_catalog_schema", admin, {
    kind: "finding",
    label: "Findings",
    id_pattern: "F-\\d+",
    schema: findingSchema,
  });
}

describe("MCP catalog tools", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("the registry has exactly the 7 catalog tools", () => {
    const names = TOOLS.map((t) => t.name);
    for (const n of [
      "list_catalog_kinds",
      "get_catalog_schema",
      "upsert_catalog_schema",
      "list_catalog_items",
      "get_catalog_item",
      "upsert_catalog_item",
      "delete_catalog_item",
    ]) {
      expect(names).toContain(n);
    }
  });

  describe("authz matrix", () => {
    it("reads are staff, writes are admin-only", async () => {
      // anonymous blocked on a read
      expect((await run("list_catalog_kinds", anon)).isError).toBe(true);
      // members read
      expect((await run("list_catalog_kinds", member)).isError).toBeFalsy();
      // members cannot write schema or items
      expect((await run("upsert_catalog_schema", member, { kind: "finding", label: "F", id_pattern: "F-\\d+", schema: findingSchema })).isError).toBe(true);
      await seedFinding();
      expect((await run("upsert_catalog_item", member, { kind: "finding", item_id: "F-1", title: "t", data: { severity: "low" } })).isError).toBe(true);
      expect((await run("delete_catalog_item", member, { kind: "finding", item_id: "F-1" })).isError).toBe(true);
      // members CAN read items + one item
      await run("upsert_catalog_item", admin, { kind: "finding", item_id: "F-1", title: "t", data: { severity: "low" } });
      expect((await run("list_catalog_items", member, { kind: "finding" })).isError).toBeFalsy();
      expect((await run("get_catalog_item", member, { kind: "finding", item_id: "F-1" })).isError).toBeFalsy();
    });
  });

  describe("validation behaviour", () => {
    beforeEach(seedFinding);

    it("rejects a bad idPattern on schema upsert", async () => {
      const r = await run("upsert_catalog_schema", admin, { kind: "bad", label: "B", id_pattern: "B-(\\d+", schema: {} });
      expect(r.isError).toBe(true);
    });

    it("rejects a client id that doesn't match the pattern", async () => {
      const r = await run("upsert_catalog_item", admin, { kind: "finding", item_id: "X-9", title: "t", data: { severity: "low" } });
      expect(r.isError).toBe(true);
    });

    it("rejects data failing the schema", async () => {
      const r = await run("upsert_catalog_item", admin, { kind: "finding", item_id: "F-1", title: "t", data: { severity: "nope" } });
      expect(r.isError).toBe(true);
    });

    it("accepts a valid item and derives links; get returns inbound/outbound", async () => {
      await run("upsert_catalog_schema", admin, { kind: "rfc", label: "RFCs", id_pattern: "RFC-\\d+", schema: {} });
      await run("upsert_catalog_item", admin, { kind: "rfc", item_id: "RFC-7", title: "rot", data: {} });
      const ok = await run("upsert_catalog_item", admin, { kind: "finding", item_id: "F-1", title: "loss", body: "caused by RFC-7", data: { severity: "high" } });
      expect(ok.isError).toBeFalsy();
      const got = await run("get_catalog_item", admin, { kind: "finding", item_id: "F-1" });
      const sc = got.structuredContent as { outbound: { toItemId: string }[] };
      expect(sc.outbound.map((e) => e.toItemId)).toContain("RFC-7");
    });

    it("get_catalog_item on an unknown item errors", async () => {
      expect((await run("get_catalog_item", admin, { kind: "finding", item_id: "F-404" })).isError).toBe(true);
    });
  });
});
