import { describe, it, expect, beforeEach } from "vitest";
import { resetDb, createShareOk, publishDocOk } from "@/test/db";
import { listShares, resolveShare } from "@/lib/shares";
import { PATCH } from "./route";

const DOC = {
  slug: "patch-doc",
  title: "Patch Doc",
  sourcePath: "os/p.md",
  format: "md" as const,
  content: "# Hi",
  by: "lucas",
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
    return (await createShareOk("patch-doc", "Pedro", "lucas")).id;
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

  // ── allowEdits toggle (Slice 3) — independent of allowComments ──────────────
  async function freshShare() {
    const share = await createShareOk("patch-doc", "Pedro", "lucas");
    return { id: share.id, token: share.shareUrl.split("/").pop()! };
  }

  it("admin toggles allowEdits on → 200 and persists (default was OFF)", async () => {
    const { id, token } = await freshShare();
    // Fail-closed default: a new share starts with edits OFF.
    expect((await resolveShare(token))!.allowEdits).toBe(false);
    const res = await PATCH(patchReq(id, { allowEdits: true }), ctx(id));
    expect(res.status).toBe(200);
    expect((await res.json()).allowEdits).toBe(true);
    expect((await resolveShare(token))!.allowEdits).toBe(true);
  });

  it("allowEdits and allowComments are INDEPENDENT (edits on, comments off in one PATCH)", async () => {
    const { id, token } = await freshShare();
    const res = await PATCH(patchReq(id, { allowEdits: true, allowComments: false }), ctx(id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.allowEdits).toBe(true);
    expect(body.allowComments).toBe(false);
    const resolved = (await resolveShare(token))!;
    expect(resolved.allowEdits).toBe(true);
    expect(resolved.allowComments).toBe(false);
  });

  it("non-boolean allowEdits → 400", async () => {
    const { id } = await freshShare();
    expect((await PATCH(patchReq(id, { allowEdits: "yes" }), ctx(id))).status).toBe(400);
  });

  it("member / anonymous cannot toggle allowEdits → 403", async () => {
    const { id } = await freshShare();
    expect((await PATCH(patchReq(id, { allowEdits: true }, "member"), ctx(id))).status).toBe(403);
    expect((await PATCH(patchReq(id, { allowEdits: true }, "anonymous"), ctx(id))).status).toBe(403);
  });

  it("unknown id with allowEdits → 404", async () => {
    expect((await PATCH(patchReq(99999, { allowEdits: true }), ctx(99999))).status).toBe(404);
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
