import { describe, it, expect, beforeEach } from "vitest";
import { resetDb, seedAudiences, seedUser } from "@/test/db";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
import { GET, POST } from "./route";
import { DELETE } from "./[userId]/route";

type Role = "admin" | "member" | "anonymous";

function headers(role: Role): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (role !== "anonymous") h["x-dev-role"] = role;
  return h;
}
function getReq(id: number | string, role: Role = "admin") {
  return new Request(`http://test/api/audiences/${id}/members`, { method: "GET", headers: headers(role) });
}
function postReq(id: number | string, body: unknown, role: Role = "admin") {
  return new Request(`http://test/api/audiences/${id}/members`, {
    method: "POST",
    headers: headers(role),
    body: JSON.stringify(body),
  });
}
function delReq(id: number | string, userId: number | string, role: Role = "admin") {
  return new Request(`http://test/api/audiences/${id}/members/${userId}`, { method: "DELETE", headers: headers(role) });
}
function ctx(id: number | string) {
  return { params: Promise.resolve({ id: String(id) }) };
}
function delCtx(id: number | string, userId: number | string) {
  return { params: Promise.resolve({ id: String(id), userId: String(userId) }) };
}
async function audienceId(key: string): Promise<number> {
  const a = await db.query.audiences.findFirst({ where: eq(schema.audiences.key, key) });
  return a!.id;
}

describe("/api/audiences/[id]/members", () => {
  beforeEach(async () => {
    await resetDb();
    await seedAudiences();
  });

  it("POST add (admin) → 201, GET lists, DELETE removes", async () => {
    const bobAud = await audienceId("bob");
    const u = await seedUser({ email: "d@x.com", displayName: "Bob" });

    const add = await POST(postReq(bobAud, { userId: u }), ctx(bobAud));
    expect(add.status).toBe(201);

    const list = await GET(getReq(bobAud, "member"), ctx(bobAud));
    expect(list.status).toBe(200);
    const lj = await list.json();
    expect(lj.members).toHaveLength(1);
    expect(lj.members[0].userId).toBe(u);

    const rm = await DELETE(delReq(bobAud, u), delCtx(bobAud, u));
    expect(rm.status).toBe(200);
    const after = await (await GET(getReq(bobAud), ctx(bobAud))).json();
    expect(after.members).toHaveLength(0);
  });

  it("POST re-add is idempotent → 200 added:false", async () => {
    const bobAud = await audienceId("bob");
    const u = await seedUser({ email: "d@x.com", displayName: "Bob" });
    await POST(postReq(bobAud, { userId: u }), ctx(bobAud));
    const again = await POST(postReq(bobAud, { userId: u }), ctx(bobAud));
    expect(again.status).toBe(200);
    expect((await again.json()).added).toBe(false);
  });

  it("authz: member/anon can't add or remove; member can read", async () => {
    const bobAud = await audienceId("bob");
    const u = await seedUser({ email: "d@x.com", displayName: "Bob" });
    expect((await POST(postReq(bobAud, { userId: u }, "member"), ctx(bobAud))).status).toBe(403);
    expect((await POST(postReq(bobAud, { userId: u }, "anonymous"), ctx(bobAud))).status).toBe(403);
    expect((await DELETE(delReq(bobAud, u, "member"), delCtx(bobAud, u))).status).toBe(403);
    expect((await GET(getReq(bobAud, "member"), ctx(bobAud))).status).toBe(200);
    expect((await GET(getReq(bobAud, "anonymous"), ctx(bobAud))).status).toBe(403);
  });

  it("404s: unknown audience, unknown user, not-a-member", async () => {
    const bobAud = await audienceId("bob");
    const u = await seedUser({ email: "d@x.com", displayName: "Bob" });
    expect((await GET(getReq(999999), ctx(999999))).status).toBe(404);
    expect((await POST(postReq(999999, { userId: u }), ctx(999999))).status).toBe(404);
    expect((await POST(postReq(bobAud, { userId: 999999 }), ctx(bobAud))).status).toBe(404);
    expect((await DELETE(delReq(bobAud, u), delCtx(bobAud, u))).status).toBe(404);
  });

  it("400s: non-numeric id, bad userId body", async () => {
    const bobAud = await audienceId("bob");
    expect((await GET(getReq("abc"), ctx("abc"))).status).toBe(400);
    expect((await POST(postReq(bobAud, { userId: "x" }), ctx(bobAud))).status).toBe(400);
    expect((await POST(postReq(bobAud, {}), ctx(bobAud))).status).toBe(400);
  });
});
