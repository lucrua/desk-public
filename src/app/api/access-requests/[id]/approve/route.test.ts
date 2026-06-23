import { describe, it, expect, beforeEach } from "vitest";
import { db, schema } from "@/db";
import { resetDb } from "@/test/db";
import { createUser, listUsers } from "@/lib/users";
import { listAccessRequests } from "@/lib/access-requests";
import { POST } from "./route";

function makeHeaders(role: string | null): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (role !== null) h["x-dev-role"] = role;
  return h;
}

function approveReq(
  id: number | string,
  body: unknown | undefined,
  role: "admin" | "member" | "anonymous" = "admin",
) {
  return new Request(`http://test/api/access-requests/${id}/approve`, {
    method: "POST",
    headers: makeHeaders(role === "anonymous" ? null : role),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function ctx(id: number | string) {
  return { params: Promise.resolve({ id: String(id) }) };
}

async function seed(email: string) {
  const [row] = await db.insert(schema.accessRequests).values({ email }).returning();
  return row;
}

describe("POST /api/access-requests/[id]/approve", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("admin approves → 200 + member created + request gone", async () => {
    const r = await seed("dani@example.com");
    const res = await POST(approveReq(r.id, {}), ctx(r.id));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(typeof json.userId).toBe("number");

    const users = await listUsers();
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ email: "dani@example.com", role: "member" });
    expect(await listAccessRequests()).toHaveLength(0);
  });

  it("approve with no body at all → 200 (defaults apply)", async () => {
    const r = await seed("nobody-body@example.com");
    const res = await POST(approveReq(r.id, undefined), ctx(r.id));
    expect(res.status).toBe(200);
    expect((await listUsers())[0].displayName).toBe("Nobody-body");
  });

  it("approve with displayName → that name is used", async () => {
    const r = await seed("x@example.com");
    const res = await POST(approveReq(r.id, { displayName: "Custom" }), ctx(r.id));
    expect(res.status).toBe(200);
    expect((await listUsers())[0].displayName).toBe("Custom");
  });

  it("non-string displayName → 400", async () => {
    const r = await seed("y@example.com");
    const res = await POST(approveReq(r.id, { displayName: 42 }), ctx(r.id));
    expect(res.status).toBe(400);
  });

  it("unknown id → 404", async () => {
    const res = await POST(approveReq(99999, {}), ctx(99999));
    expect(res.status).toBe(404);
  });

  it("non-numeric id → 400", async () => {
    const res = await POST(approveReq("abc", {}), ctx("abc"));
    expect(res.status).toBe(400);
  });

  it("duplicate (users row with that email already exists) → 409 + request cleared", async () => {
    const r = await seed("dup@example.com");
    await createUser({ email: "dup@example.com", displayName: "Already" });
    const res = await POST(approveReq(r.id, {}), ctx(r.id));
    expect(res.status).toBe(409);
    // request cleared (satisfied)
    expect(await listAccessRequests()).toHaveLength(0);
    // no duplicate user
    expect(await listUsers()).toHaveLength(1);
  });

  it("member → 403, no user created", async () => {
    const r = await seed("m@example.com");
    const res = await POST(approveReq(r.id, {}, "member"), ctx(r.id));
    expect(res.status).toBe(403);
    expect(await listUsers()).toHaveLength(0);
    expect(await listAccessRequests()).toHaveLength(1);
  });

  it("anonymous → 403", async () => {
    const r = await seed("a@example.com");
    const res = await POST(approveReq(r.id, {}, "anonymous"), ctx(r.id));
    expect(res.status).toBe(403);
  });

  it("aliasOfUserId → 200, email added to existing user, no new user", async () => {
    const target = await createUser({ email: "lucas@example.org", displayName: "Lucas" });
    const r = await seed("lucas@example.net");
    const res = await POST(approveReq(r.id, { aliasOfUserId: target!.id }), ctx(r.id));
    expect(res.status).toBe(200);
    expect((await res.json()).userId).toBe(target!.id);
    expect(await listUsers()).toHaveLength(1);
    expect(await listAccessRequests()).toHaveLength(0);
  });

  it("aliasOfUserId for an unknown user → 404 (request preserved)", async () => {
    const r = await seed("orphan@example.com");
    const res = await POST(approveReq(r.id, { aliasOfUserId: 99999 }), ctx(r.id));
    expect(res.status).toBe(404);
    expect(await listAccessRequests()).toHaveLength(1);
  });

  it("non-integer aliasOfUserId → 400", async () => {
    const r = await seed("bad@example.com");
    const res = await POST(approveReq(r.id, { aliasOfUserId: "x" }), ctx(r.id));
    expect(res.status).toBe(400);
  });
});
