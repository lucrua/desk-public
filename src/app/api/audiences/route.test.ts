import { describe, it, expect, beforeEach } from "vitest";
import { resetDb, seedAudiences } from "@/test/db";
import { publishDoc } from "@/lib/docs";
import { listAudiences } from "@/lib/audiences";
import { GET, POST } from "./route";
import { PATCH, DELETE } from "./[id]/route";

type Role = "admin" | "member" | "anonymous";

function makeHeaders(role: string | null): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (role !== null) h["x-dev-role"] = role;
  return h;
}

function getReq(role: Role = "admin") {
  return new Request("http://test/api/audiences", { method: "GET", headers: makeHeaders(role === "anonymous" ? null : role) });
}
function postReq(body: unknown, role: Role = "admin") {
  return new Request("http://test/api/audiences", {
    method: "POST",
    headers: makeHeaders(role === "anonymous" ? null : role),
    body: JSON.stringify(body),
  });
}
function patchReq(id: number | string, body: unknown, role: Role = "admin") {
  return new Request(`http://test/api/audiences/${id}`, {
    method: "PATCH",
    headers: makeHeaders(role === "anonymous" ? null : role),
    body: JSON.stringify(body),
  });
}
function deleteReq(id: number | string, role: Role = "admin") {
  return new Request(`http://test/api/audiences/${id}`, {
    method: "DELETE",
    headers: makeHeaders(role === "anonymous" ? null : role),
  });
}
function ctx(id: number | string) {
  return { params: Promise.resolve({ id: String(id) }) };
}

describe("GET /api/audiences", () => {
  beforeEach(async () => {
    await resetDb();
    await seedAudiences();
  });

  it("admin → 200 with the seeded list", async () => {
    const res = await GET(getReq("admin"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.audiences.map((a: { key: string }) => a.key)).toEqual(["private", "team", "alice", "bob"]);
  });

  it("member → 200 (staff may read for the upload picker)", async () => {
    const res = await GET(getReq("member"));
    expect(res.status).toBe(200);
  });

  it("anonymous → 403", async () => {
    const res = await GET(getReq("anonymous"));
    expect(res.status).toBe(403);
  });
});

describe("POST /api/audiences", () => {
  beforeEach(async () => {
    await resetDb();
    await seedAudiences();
  });

  it("admin creates an audience → 200 {audience}", async () => {
    const res = await POST(postReq({ key: "acme", label: "Acme", memberVisible: false }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.audience.key).toBe("acme");
    expect(json.audience.label).toBe("Acme");
    expect(json.audience.memberVisible).toBe(false);
  });

  it("member → 403", async () => {
    const res = await POST(postReq({ key: "x", label: "X" }, "member"));
    expect(res.status).toBe(403);
  });

  it("anonymous → 403", async () => {
    const res = await POST(postReq({ key: "x", label: "X" }, "anonymous"));
    expect(res.status).toBe(403);
  });

  it("invalid key → 400", async () => {
    const res = await POST(postReq({ key: "Bad Key", label: "X" }));
    expect(res.status).toBe(400);
  });

  it("missing label → 400", async () => {
    const res = await POST(postReq({ key: "good-key" }));
    expect(res.status).toBe(400);
  });

  it("non-boolean memberVisible → 400", async () => {
    const res = await POST(postReq({ key: "good-key", label: "Good", memberVisible: "yes" }));
    expect(res.status).toBe(400);
  });

  it("duplicate key → 409", async () => {
    const res = await POST(postReq({ key: "team", label: "Dup" }));
    expect(res.status).toBe(409);
  });
});

describe("PATCH /api/audiences/[id]", () => {
  beforeEach(async () => {
    await resetDb();
    await seedAudiences();
  });

  it("admin flips memberVisible → 200 + persisted", async () => {
    const alice = (await listAudiences()).find((a) => a.key === "alice")!;
    const res = await PATCH(patchReq(alice.id, { memberVisible: true }), ctx(alice.id));
    expect(res.status).toBe(200);
    expect((await listAudiences()).find((a) => a.key === "alice")!.memberVisible).toBe(true);
  });

  it("member → 403", async () => {
    const alice = (await listAudiences()).find((a) => a.key === "alice")!;
    const res = await PATCH(patchReq(alice.id, { memberVisible: true }, "member"), ctx(alice.id));
    expect(res.status).toBe(403);
  });

  it("unknown id → 404", async () => {
    const res = await PATCH(patchReq(99999, { memberVisible: true }), ctx(99999));
    expect(res.status).toBe(404);
  });

  it("missing memberVisible → 400", async () => {
    const alice = (await listAudiences()).find((a) => a.key === "alice")!;
    const res = await PATCH(patchReq(alice.id, {}), ctx(alice.id));
    expect(res.status).toBe(400);
  });

  it("non-boolean memberVisible → 400", async () => {
    const alice = (await listAudiences()).find((a) => a.key === "alice")!;
    const res = await PATCH(patchReq(alice.id, { memberVisible: 1 }), ctx(alice.id));
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/audiences/[id]", () => {
  beforeEach(async () => {
    await resetDb();
    await seedAudiences();
  });

  it("admin deletes an unused audience → 200", async () => {
    const created = await POST(postReq({ key: "spare", label: "Spare" }));
    const { audience } = await created.json();
    const res = await DELETE(deleteReq(audience.id), ctx(audience.id));
    expect(res.status).toBe(200);
  });

  it("in-use audience → 409", async () => {
    await publishDoc({ slug: "d", title: "D", sourcePath: "d.md", audience: "team", format: "md", content: "x", by: "admin" });
    const team = (await listAudiences()).find((a) => a.key === "team")!;
    const res = await DELETE(deleteReq(team.id), ctx(team.id));
    expect(res.status).toBe(409);
  });

  it("unknown id → 404", async () => {
    const res = await DELETE(deleteReq(99999), ctx(99999));
    expect(res.status).toBe(404);
  });

  it("member → 403", async () => {
    const team = (await listAudiences()).find((a) => a.key === "team")!;
    const res = await DELETE(deleteReq(team.id, "member"), ctx(team.id));
    expect(res.status).toBe(403);
  });

  it("anonymous → 403", async () => {
    const res = await DELETE(deleteReq(1, "anonymous"), ctx(1));
    expect(res.status).toBe(403);
  });
});
