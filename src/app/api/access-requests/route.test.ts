import { describe, it, expect, beforeEach } from "vitest";
import { db, schema } from "@/db";
import { resetDb } from "@/test/db";
import { GET } from "./route";

function makeHeaders(role: string | null): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (role !== null) h["x-dev-role"] = role;
  return h;
}

function getReq(role: "admin" | "member" | "anonymous" = "admin") {
  return new Request("http://test/api/access-requests", {
    method: "GET",
    headers: makeHeaders(role === "anonymous" ? null : role),
  });
}

describe("GET /api/access-requests", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("admin → 200 with the access requests", async () => {
    await db.insert(schema.accessRequests).values({ email: "v@example.com", hits: 2 });
    const res = await GET(getReq("admin"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.accessRequests).toHaveLength(1);
    expect(json.accessRequests[0]).toMatchObject({ email: "v@example.com", hits: 2 });
  });

  it("admin with none → 200 empty list", async () => {
    const res = await GET(getReq("admin"));
    expect(res.status).toBe(200);
    expect((await res.json()).accessRequests).toEqual([]);
  });

  it("member → 403", async () => {
    const res = await GET(getReq("member"));
    expect(res.status).toBe(403);
  });

  it("anonymous → 403", async () => {
    const res = await GET(getReq("anonymous"));
    expect(res.status).toBe(403);
  });
});
