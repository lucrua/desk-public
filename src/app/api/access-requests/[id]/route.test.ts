import { describe, it, expect, beforeEach } from "vitest";
import { db, schema } from "@/db";
import { resetDb } from "@/test/db";
import { listAccessRequests } from "@/lib/access-requests";
import { DELETE } from "./route";

function makeHeaders(role: string | null): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (role !== null) h["x-dev-role"] = role;
  return h;
}

function delReq(id: number | string, role: "admin" | "member" | "anonymous" = "admin") {
  return new Request(`http://test/api/access-requests/${id}`, {
    method: "DELETE",
    headers: makeHeaders(role === "anonymous" ? null : role),
  });
}

function ctx(id: number | string) {
  return { params: Promise.resolve({ id: String(id) }) };
}

async function seed(email: string) {
  const [row] = await db.insert(schema.accessRequests).values({ email }).returning();
  return row;
}

describe("DELETE /api/access-requests/[id]", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("admin dismisses → 200 + request gone", async () => {
    const r = await seed("v@example.com");
    const res = await DELETE(delReq(r.id), ctx(r.id));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(await listAccessRequests()).toHaveLength(0);
  });

  it("unknown id → 404", async () => {
    const res = await DELETE(delReq(99999), ctx(99999));
    expect(res.status).toBe(404);
  });

  it("non-numeric id → 400", async () => {
    const res = await DELETE(delReq("abc"), ctx("abc"));
    expect(res.status).toBe(400);
  });

  it("member → 403", async () => {
    const r = await seed("v2@example.com");
    const res = await DELETE(delReq(r.id, "member"), ctx(r.id));
    expect(res.status).toBe(403);
    // not deleted
    expect(await listAccessRequests()).toHaveLength(1);
  });

  it("anonymous → 403", async () => {
    const r = await seed("v3@example.com");
    const res = await DELETE(delReq(r.id, "anonymous"), ctx(r.id));
    expect(res.status).toBe(403);
  });
});
