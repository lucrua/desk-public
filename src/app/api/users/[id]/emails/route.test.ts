import { describe, it, expect, beforeEach } from "vitest";
import { resetDb } from "@/test/db";
import { createUser, listUserEmails } from "@/lib/users";
import { GET, POST } from "./route";
import { DELETE } from "./[email]/route";

type Role = "admin" | "member" | "anonymous";

function headers(role: Role): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (role !== "anonymous") h["x-dev-role"] = role;
  return h;
}

function ctx(id: number | string) {
  return { params: Promise.resolve({ id: String(id) }) };
}
function delCtx(id: number | string, email: string) {
  return { params: Promise.resolve({ id: String(id), email: encodeURIComponent(email) }) };
}

function getReq(id: number | string, role: Role = "admin") {
  return new Request(`http://test/api/users/${id}/emails`, { headers: headers(role) });
}
function postReq(id: number | string, body: unknown, role: Role = "admin") {
  return new Request(`http://test/api/users/${id}/emails`, {
    method: "POST",
    headers: headers(role),
    body: JSON.stringify(body),
  });
}
function delReq(id: number | string, email: string, role: Role = "admin") {
  return new Request(`http://test/api/users/${id}/emails/${encodeURIComponent(email)}`, {
    method: "DELETE",
    headers: headers(role),
  });
}

describe("/api/users/[id]/emails", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("GET lists a user's emails (admin)", async () => {
    const u = await createUser({ email: "p@example.com", displayName: "P" });
    const res = await GET(getReq(u!.id), ctx(u!.id));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.emails).toHaveLength(1);
    expect(json.emails[0].email).toBe("p@example.com");
    expect(json.emails[0].primary).toBe(true);
  });

  it("GET → 403 for a member, 404 for unknown id", async () => {
    const u = await createUser({ email: "p@example.com", displayName: "P" });
    expect((await GET(getReq(u!.id, "member"), ctx(u!.id))).status).toBe(403);
    expect((await GET(getReq(99999), ctx(99999))).status).toBe(404);
  });

  it("POST adds an email (admin) → 200 and the email is listed", async () => {
    const u = await createUser({ email: "p@example.com", displayName: "P" });
    const res = await POST(postReq(u!.id, { email: "Alias@Example.com" }), ctx(u!.id));
    expect(res.status).toBe(200);
    const list = await listUserEmails(u!.id);
    expect(list!.map((e) => e.email).sort()).toEqual(["alias@example.com", "p@example.com"]);
  });

  it("POST → 409 on a duplicate (email already on another user)", async () => {
    await createUser({ email: "taken@example.com", displayName: "T" });
    const u = await createUser({ email: "p@example.com", displayName: "P" });
    const res = await POST(postReq(u!.id, { email: "taken@example.com" }), ctx(u!.id));
    expect(res.status).toBe(409);
  });

  it("POST → 400 empty email, 404 unknown id, 403 member", async () => {
    const u = await createUser({ email: "p@example.com", displayName: "P" });
    expect((await POST(postReq(u!.id, { email: "  " }), ctx(u!.id))).status).toBe(400);
    expect((await POST(postReq(99999, { email: "x@example.com" }), ctx(99999))).status).toBe(404);
    expect((await POST(postReq(u!.id, { email: "x@example.com" }, "member"), ctx(u!.id))).status).toBe(403);
  });

  it("DELETE removes an email (admin) → 200", async () => {
    const u = await createUser({ email: "p@example.com", displayName: "P" });
    await POST(postReq(u!.id, { email: "alias@example.com" }), ctx(u!.id));
    const res = await DELETE(delReq(u!.id, "alias@example.com"), delCtx(u!.id, "alias@example.com"));
    expect(res.status).toBe(200);
    expect(await listUserEmails(u!.id)).toHaveLength(1);
  });

  it("DELETE → 409 last-email guard for a token-less user", async () => {
    const u = await createUser({ email: "only@example.com", displayName: "Only" });
    const res = await DELETE(delReq(u!.id, "only@example.com"), delCtx(u!.id, "only@example.com"));
    expect(res.status).toBe(409);
    expect(await listUserEmails(u!.id)).toHaveLength(1);
  });

  it("DELETE → 404 for an email not on the user; 403 for a member", async () => {
    const u = await createUser({ email: "p@example.com", displayName: "P" });
    expect((await DELETE(delReq(u!.id, "nope@example.com"), delCtx(u!.id, "nope@example.com"))).status).toBe(404);
    expect((await DELETE(delReq(u!.id, "p@example.com", "member"), delCtx(u!.id, "p@example.com"))).status).toBe(403);
  });
});
