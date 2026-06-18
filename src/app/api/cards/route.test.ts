import { describe, it, expect, beforeEach } from "vitest";
import { resetDb, seedBuckets } from "@/test/db";
import { GET as listCardsGET, POST as createCardPOST } from "./route";
import { GET as getCardGET, PATCH as cardPATCH, DELETE as cardDELETE } from "./[id]/route";
import { POST as movePOST } from "./[id]/move/route";
import { GET as cardEventsGET } from "./[id]/events/route";
import { GET as listBucketsGET, POST as createBucketPOST, PATCH as reorderPATCH } from "../buckets/route";
import { PATCH as bucketPATCH, DELETE as bucketDELETE } from "../buckets/[id]/route";

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
const ctx = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) });

describe("cards + buckets REST routes", () => {
  let buckets: Awaited<ReturnType<typeof seedBuckets>>;
  beforeEach(async () => {
    await resetDb();
    buckets = await seedBuckets();
  });
  const bId = (k: string) => buckets.find((b) => b.key === k)!.id;

  describe("auth gates", () => {
    it("anonymous is rejected everywhere", async () => {
      expect((await listCardsGET(req("/api/cards", "GET", "anonymous"))).status).toBe(403);
      expect((await listBucketsGET(req("/api/buckets", "GET", "anonymous"))).status).toBe(403);
      expect((await createBucketPOST(req("/api/buckets", "POST", "anonymous", { label: "X" }))).status).toBe(403);
    });

    it("bucket create/rename/delete/reorder are admin-only", async () => {
      expect((await createBucketPOST(req("/api/buckets", "POST", "member", { label: "X" }))).status).toBe(403);
      expect((await bucketPATCH(req(`/api/buckets/${bId("backlog")}`, "PATCH", "member", { label: "X" }), ctx(bId("backlog")))).status).toBe(403);
      expect((await bucketDELETE(req(`/api/buckets/${bId("backlog")}`, "DELETE", "member"), ctx(bId("backlog")))).status).toBe(403);
      expect((await reorderPATCH(req("/api/buckets", "PATCH", "member", { orderedIds: [1] }))).status).toBe(403);
    });
  });

  describe("buckets CRUD", () => {
    it("admin lists / creates / renames / reorders / deletes", async () => {
      const list = await (await listBucketsGET(req("/api/buckets", "GET", "admin"))).json();
      expect(list.buckets.map((b: { key: string }) => b.key)).toEqual(["backlog", "in-progress", "review", "done"]);

      const created = await createBucketPOST(req("/api/buckets", "POST", "admin", { label: "Blocked" }));
      expect(created.status).toBe(200);
      const newId = (await created.json()).bucket.id;

      const renamed = await bucketPATCH(req(`/api/buckets/${newId}`, "PATCH", "admin", { label: "Stuck" }), ctx(newId));
      expect(renamed.status).toBe(200);

      const ids = (await (await listBucketsGET(req("/api/buckets", "GET", "admin"))).json()).buckets.map((b: { id: number }) => b.id);
      const reorder = await reorderPATCH(req("/api/buckets", "PATCH", "admin", { orderedIds: [...ids].reverse() }));
      expect(reorder.status).toBe(200);

      const del = await bucketDELETE(req(`/api/buckets/${newId}`, "DELETE", "admin"), ctx(newId));
      expect(del.status).toBe(200);
    });

    it("delete refuses a non-empty bucket (409)", async () => {
      await createCardPOST(req("/api/cards", "POST", "admin", { title: "x", bucketId: bId("backlog") }));
      const del = await bucketDELETE(req(`/api/buckets/${bId("backlog")}`, "DELETE", "admin"), ctx(bId("backlog")));
      expect(del.status).toBe(409);
    });

    it("duplicate bucket key → 409", async () => {
      const dup = await createBucketPOST(req("/api/buckets", "POST", "admin", { label: "Backlog" }));
      expect(dup.status).toBe(409);
    });

    it("reorder with a partial order → 400", async () => {
      const bad = await reorderPATCH(req("/api/buckets", "PATCH", "admin", { orderedIds: [bId("backlog")] }));
      expect(bad.status).toBe(400);
    });
  });

  describe("cards CRUD", () => {
    it("admin creates, reads with activity, moves, archives", async () => {
      const created = await createCardPOST(req("/api/cards", "POST", "admin", { title: "Task", bucketId: bId("backlog") }));
      expect(created.status).toBe(200);
      const id = (await created.json()).card.id;

      const got = await (await getCardGET(req(`/api/cards/${id}`, "GET", "admin"), ctx(id))).json();
      expect(got.card.title).toBe("Task");
      expect(got.activity.map((e: { kind: string }) => e.kind)).toEqual(["card.created"]);

      const moved = await movePOST(req(`/api/cards/${id}/move`, "POST", "admin", { bucketId: bId("review") }), ctx(id));
      expect(moved.status).toBe(200);
      expect((await moved.json()).card.bucketKey).toBe("review");

      const events = await (await cardEventsGET(req(`/api/cards/${id}/events`, "GET", "admin"), ctx(id))).json();
      expect(events.events.map((e: { kind: string }) => e.kind)).toEqual(["card.created", "card.moved"]);

      const archived = await cardDELETE(req(`/api/cards/${id}`, "DELETE", "admin"), ctx(id));
      expect(archived.status).toBe(200);
      expect((await archived.json()).card.archivedAt).not.toBeNull();
    });

    it("member may CREATE a card (the composer)", async () => {
      const created = await createCardPOST(req("/api/cards", "POST", "member", { title: "MemberCard", bucketId: bId("backlog") }));
      expect(created.status).toBe(200);
    });

    it("member who owns nothing (dev mode) is denied move/archive/edit of any card", async () => {
      const created = await createCardPOST(req("/api/cards", "POST", "admin", { title: "AdminCard", bucketId: bId("backlog") }));
      const id = (await created.json()).card.id;
      // dev member has no users row → owns nothing
      expect((await cardPATCH(req(`/api/cards/${id}`, "PATCH", "member", { title: "hax" }), ctx(id))).status).toBe(403);
      expect((await movePOST(req(`/api/cards/${id}/move`, "POST", "member", { bucketId: bId("done") }), ctx(id))).status).toBe(403);
      expect((await cardDELETE(req(`/api/cards/${id}`, "DELETE", "member"), ctx(id))).status).toBe(403);
    });

    it("owner reassignment is admin-only (member 403 even though they could create)", async () => {
      const created = await createCardPOST(req("/api/cards", "POST", "admin", { title: "C", bucketId: bId("backlog") }));
      const id = (await created.json()).card.id;
      const res = await cardPATCH(req(`/api/cards/${id}`, "PATCH", "member", { ownerUserId: 1 }), ctx(id));
      expect(res.status).toBe(403);
    });

    it("validation: empty title 400, unknown bucket 404, unknown card 404", async () => {
      expect((await createCardPOST(req("/api/cards", "POST", "admin", { title: "  ", bucketId: bId("backlog") }))).status).toBe(400);
      expect((await createCardPOST(req("/api/cards", "POST", "admin", { title: "x", bucketId: 99999 }))).status).toBe(404);
      expect((await getCardGET(req("/api/cards/99999", "GET", "admin"), ctx(99999))).status).toBe(404);
    });

    it("owner=me sugar returns [] for a dev member with no users row", async () => {
      await createCardPOST(req("/api/cards", "POST", "admin", { title: "x", bucketId: bId("backlog") }));
      const res = await listCardsGET(req("/api/cards?owner=me", "GET", "member"));
      expect((await res.json()).cards).toEqual([]);
    });
  });
});
