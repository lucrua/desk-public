import { describe, it, expect, beforeEach } from "vitest";
import { resetDb } from "@/test/db";
import { GET as kindsGET, POST as kindsPOST } from "./route";
import { GET as kindGET, PATCH as kindPATCH, DELETE as kindDELETE } from "./[kind]/route";
import { GET as itemsGET, POST as itemsPOST } from "./[kind]/items/route";
import {
  GET as itemGET,
  PATCH as itemPATCH,
  DELETE as itemDELETE,
} from "./[kind]/items/[itemId]/route";

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
const kctx = (kind: string) => ({ params: Promise.resolve({ kind }) });
const ictx = (kind: string, itemId: string) => ({ params: Promise.resolve({ kind, itemId }) });

const findingBody = {
  kind: "finding",
  label: "Findings",
  idPattern: "F-\\d+",
  schema: { type: "object", required: ["severity"], properties: { severity: { enum: ["low", "high"] } }, additionalProperties: false },
};

describe("catalogs REST routes", () => {
  beforeEach(async () => {
    await resetDb();
  });

  describe("auth gates", () => {
    it("anonymous rejected on reads + writes", async () => {
      expect((await kindsGET(req("/api/catalogs", "GET", "anonymous"))).status).toBe(403);
      expect((await kindsPOST(req("/api/catalogs", "POST", "anonymous", findingBody))).status).toBe(403);
    });
    it("members read but cannot write (admin-only mutations)", async () => {
      expect((await kindsPOST(req("/api/catalogs", "POST", "member", findingBody))).status).toBe(403);
      // seed a kind as admin so member reads have something
      await kindsPOST(req("/api/catalogs", "POST", "admin", findingBody));
      expect((await kindsGET(req("/api/catalogs", "GET", "member"))).status).toBe(200);
      expect((await itemsPOST(req("/api/catalogs/finding/items", "POST", "member", { itemId: "F-1", title: "x", data: { severity: "low" } }), kctx("finding"))).status).toBe(403);
      expect((await kindPATCH(req("/api/catalogs/finding", "PATCH", "member", { label: "X" }), kctx("finding"))).status).toBe(403);
      expect((await kindDELETE(req("/api/catalogs/finding", "DELETE", "member"), kctx("finding"))).status).toBe(403);
    });
  });

  describe("schema CRUD", () => {
    it("admin creates, gets, patches, and deletes a kind", async () => {
      expect((await kindsPOST(req("/api/catalogs", "POST", "admin", findingBody))).status).toBe(200);
      const got = await (await kindGET(req("/api/catalogs/finding", "GET", "admin"), kctx("finding"))).json();
      expect(got.kind.kind).toBe("finding");

      const patched = await kindPATCH(req("/api/catalogs/finding", "PATCH", "admin", { label: "Findings v2" }), kctx("finding"));
      expect(patched.status).toBe(200);
      expect((await patched.json()).kind.label).toBe("Findings v2");

      const del = await kindDELETE(req("/api/catalogs/finding", "DELETE", "admin"), kctx("finding"));
      expect(del.status).toBe(200);
      expect((await kindGET(req("/api/catalogs/finding", "GET", "admin"), kctx("finding"))).status).toBe(404);
    });

    it("rejects an invalid idPattern with 400", async () => {
      const r = await kindsPOST(req("/api/catalogs", "POST", "admin", { ...findingBody, idPattern: "F-(\\d+" }));
      expect(r.status).toBe(400);
    });

    it("delete of a non-empty kind returns 409", async () => {
      await kindsPOST(req("/api/catalogs", "POST", "admin", findingBody));
      await itemsPOST(req("/api/catalogs/finding/items", "POST", "admin", { itemId: "F-1", title: "x", data: { severity: "low" } }), kctx("finding"));
      const del = await kindDELETE(req("/api/catalogs/finding", "DELETE", "admin"), kctx("finding"));
      expect(del.status).toBe(409);
    });
  });

  describe("item CRUD", () => {
    beforeEach(async () => {
      await kindsPOST(req("/api/catalogs", "POST", "admin", findingBody));
    });

    it("creates with a client-proposed id, validates id + data", async () => {
      // bad id
      expect((await itemsPOST(req("/api/catalogs/finding/items", "POST", "admin", { itemId: "X-1", title: "t", data: { severity: "low" } }), kctx("finding"))).status).toBe(400);
      // bad data
      expect((await itemsPOST(req("/api/catalogs/finding/items", "POST", "admin", { itemId: "F-1", title: "t", data: { severity: "nope" } }), kctx("finding"))).status).toBe(400);
      // ok
      const ok = await itemsPOST(req("/api/catalogs/finding/items", "POST", "admin", { itemId: "F-1", title: "t", status: "open", data: { severity: "high" } }), kctx("finding"));
      expect(ok.status).toBe(200);
    });

    it("lists with status + q filters", async () => {
      await itemsPOST(req("/api/catalogs/finding/items", "POST", "admin", { itemId: "F-1", title: "checkout", status: "open", data: { severity: "high" } }), kctx("finding"));
      await itemsPOST(req("/api/catalogs/finding/items", "POST", "admin", { itemId: "F-2", title: "session", status: "resolved", data: { severity: "low" } }), kctx("finding"));
      const open = await (await itemsGET(req("/api/catalogs/finding/items?status=open", "GET", "member"), kctx("finding"))).json();
      expect(open.items.map((i: { itemId: string }) => i.itemId)).toEqual(["F-1"]);
      const q = await (await itemsGET(req("/api/catalogs/finding/items?q=session", "GET", "member"), kctx("finding"))).json();
      expect(q.items.map((i: { itemId: string }) => i.itemId)).toEqual(["F-2"]);
    });

    it("gets one item with links, patches, deletes", async () => {
      await itemsPOST(req("/api/catalogs/finding/items", "POST", "admin", { itemId: "F-1", title: "a", data: { severity: "low" } }), kctx("finding"));
      await itemsPOST(req("/api/catalogs/finding/items", "POST", "admin", { itemId: "F-2", title: "b", body: "see F-1", data: { severity: "high" } }), kctx("finding"));
      const f2 = await (await itemGET(req("/api/catalogs/finding/items/F-2", "GET", "member"), ictx("finding", "F-2"))).json();
      expect(f2.outbound.map((e: { toItemId: string }) => e.toItemId)).toContain("F-1");

      const patched = await itemPATCH(req("/api/catalogs/finding/items/F-1", "PATCH", "admin", { status: "resolved" }), ictx("finding", "F-1"));
      expect(patched.status).toBe(200);
      expect((await patched.json()).item.status).toBe("resolved");

      const del = await itemDELETE(req("/api/catalogs/finding/items/F-2", "DELETE", "admin"), ictx("finding", "F-2"));
      expect(del.status).toBe(200);
      expect((await itemGET(req("/api/catalogs/finding/items/F-2", "GET", "admin"), ictx("finding", "F-2"))).status).toBe(404);
    });
  });
});
