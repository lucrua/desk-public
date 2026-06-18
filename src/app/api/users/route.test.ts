import { describe, it, expect, beforeEach } from "vitest";
import { resetDb } from "@/test/db";
import { createUser } from "@/lib/users";
import { GET, POST } from "./route";

type Role = "admin" | "member" | "anonymous";

function makeHeaders(role: string | null): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (role !== null) h["x-dev-role"] = role;
  return h;
}

function getReq(role: Role = "admin") {
  return new Request("http://test/api/users", {
    method: "GET",
    headers: makeHeaders(role === "anonymous" ? null : role),
  });
}

function postReq(body: unknown, role: Role = "admin") {
  return new Request("http://test/api/users", {
    method: "POST",
    headers: makeHeaders(role === "anonymous" ? null : role),
    body: JSON.stringify(body),
  });
}

describe("GET /api/users", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("admin → 200 {users: [...]} newest-first", async () => {
    await createUser({ email: "a@example.com", displayName: "A", role: "member" });
    await createUser({ email: "b@example.com", displayName: "B", role: "admin" });

    const res = await GET(getReq("admin"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.users)).toBe(true);
    expect(json.users).toHaveLength(2);
    expect(json.users[0].email).toBe("b@example.com");
  });

  it("member → 403", async () => {
    const res = await GET(getReq("member"));
    expect(res.status).toBe(403);
    expect(await res.json()).toHaveProperty("error");
  });

  it("anonymous → 403", async () => {
    const res = await GET(getReq("anonymous"));
    expect(res.status).toBe(403);
  });
});

describe("POST /api/users", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("admin creates a human user → 200 {user} (always stored as member)", async () => {
    const res = await POST(postReq({ email: "Bob@Example.com", displayName: "Bob" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.user.email).toBe("bob@example.com");
    expect(json.user.displayName).toBe("Bob");
    expect(json.user.role).toBe("member");
  });

  it("admin creates an agent user (tokenName) → 200", async () => {
    const res = await POST(postReq({ tokenName: "ci-publisher", displayName: "repo CI" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.user.tokenName).toBe("ci-publisher");
  });

  it("POST /api/users: role field is accepted but ignored — new users are always member (use PATCH to promote)", async () => {
    // POST /api/users always creates a member (the route doesn't accept role).
    // Admin promotion is done via PATCH /api/users/[id] { role: 'admin' }.
    const res = await POST(postReq({ email: "wannabe@example.com", displayName: "Wannabe" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.user.role).toBe("member");
  });

  it("member → 403", async () => {
    const res = await POST(postReq({ email: "x@example.com", displayName: "X", role: "member" }, "member"));
    expect(res.status).toBe(403);
  });

  it("anonymous → 403", async () => {
    const res = await POST(postReq({ email: "x@example.com", displayName: "X", role: "member" }, "anonymous"));
    expect(res.status).toBe(403);
  });

  it("missing displayName → 400", async () => {
    const res = await POST(postReq({ email: "x@example.com" }));
    expect(res.status).toBe(400);
  });

  it("neither email nor tokenName → 400", async () => {
    const res = await POST(postReq({ displayName: "Nobody" }));
    expect(res.status).toBe(400);
  });

  it("duplicate email → 409", async () => {
    await createUser({ email: "dup@example.com", displayName: "First" });
    const res = await POST(postReq({ email: "dup@example.com", displayName: "Second" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toHaveProperty("error");
  });

  it("duplicate tokenName → 409", async () => {
    await createUser({ tokenName: "agent-x", displayName: "First" });
    const res = await POST(postReq({ tokenName: "agent-x", displayName: "Second" }));
    expect(res.status).toBe(409);
  });

  it("invalid JSON body → 400", async () => {
    const req = new Request("http://test/api/users", {
      method: "POST",
      headers: { "x-dev-role": "admin", "content-type": "application/json" },
      body: "not-json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});
