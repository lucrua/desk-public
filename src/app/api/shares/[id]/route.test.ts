import { describe, it, expect, beforeEach } from "vitest";
import { resetDb, createShareOk, publishDocOk } from "@/test/db";
import { listShares } from "@/lib/shares";
import { PATCH } from "./route";

const DOC = {
  slug: "patch-doc",
  title: "Patch Doc",
  sourcePath: "os/p.md",
  audience: "external:alice",
  format: "md" as const,
  content: "# Hi",
  by: "admin",
};

type Role = "admin" | "member" | "anonymous";
function headers(role: Role): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (role !== "anonymous") h["x-dev-role"] = role;
  return h;
}
function patchReq(id: string | number, body: unknown, role: Role = "admin") {
  return new Request(`http://test/api/shares/${id}`, {
    method: "PATCH",
    headers: headers(role),
    body: JSON.stringify(body),
  });
}
const ctx = (id: string | number) => ({ params: Promise.resolve({ id: String(id) }) });

describe("PATCH /api/shares/[id]", () => {
  beforeEach(async () => {
    await resetDb();
    await publishDocOk(DOC);
  });

  async function shareId() {
    return (await createShareOk("patch-doc", "Alice", "admin")).id;
  }

  it("admin toggles allowComments off → 200 and persists", async () => {
    const id = await shareId();
    const res = await PATCH(patchReq(id, { allowComments: false }), ctx(id));
    expect(res.status).toBe(200);
    expect((await res.json()).allowComments).toBe(false);
    const row = (await listShares()).find((s) => s.id === id)!;
    expect(row.allowComments).toBe(false);
  });

  it("admin toggles back on → 200", async () => {
    const id = await shareId();
    await PATCH(patchReq(id, { allowComments: false }), ctx(id));
    await PATCH(patchReq(id, { allowComments: true }), ctx(id));
    const row = (await listShares()).find((s) => s.id === id)!;
    expect(row.allowComments).toBe(true);
  });

  it("member → 403; anonymous → 403", async () => {
    const id = await shareId();
    expect((await PATCH(patchReq(id, { allowComments: false }, "member"), ctx(id))).status).toBe(403);
    expect((await PATCH(patchReq(id, { allowComments: false }, "anonymous"), ctx(id))).status).toBe(403);
  });

  it("non-boolean allowComments → 400", async () => {
    const id = await shareId();
    expect((await PATCH(patchReq(id, { allowComments: "yes" }), ctx(id))).status).toBe(400);
    expect((await PATCH(patchReq(id, {}), ctx(id))).status).toBe(400);
  });

  it("unknown id → 404", async () => {
    expect((await PATCH(patchReq(99999, { allowComments: true }), ctx(99999))).status).toBe(404);
  });

  it("invalid JSON → 400", async () => {
    const id = await shareId();
    const req = new Request(`http://test/api/shares/${id}`, {
      method: "PATCH",
      headers: headers("admin"),
      body: "not-json",
    });
    expect((await PATCH(req, ctx(id))).status).toBe(400);
  });
});
