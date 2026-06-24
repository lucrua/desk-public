import { describe, it, expect, beforeEach } from "vitest";
import { resetDb } from "@/test/db";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
import { POST as acceptPOST } from "./route";
import { createInvite } from "@/lib/invites/invites";
import { createSpace, setSpacePushPolicy } from "@/lib/spaces";

async function seedAdmin(): Promise<number> {
  const [u] = await db
    .insert(schema.users)
    .values({ tokenName: "owner", displayName: "Owner", role: "admin", active: 1 })
    .returning({ id: schema.users.id });
  return u.id;
}

function req(token: string, body?: unknown) {
  return new Request(`http://test/api/invite/${token}/accept`, {
    method: "POST",
    headers: { "content-type": "application/json", host: "share.example.com" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
const ctx = (token: string) => ({ params: Promise.resolve({ token }) });

describe("POST /api/invite/[token]/accept", () => {
  let ownerId: number;
  beforeEach(async () => {
    await resetDb();
    ownerId = await seedAdmin();
    const out = await createSpace("proj", ownerId, "private", "test");
    if (!out.ok) throw new Error("space create failed");
  });

  it("accepts a live invite → 200 with token + cloneUrl + setupPrompt", async () => {
    const inv = await createInvite({ spaceSlug: "proj", role: "writer", createdByUserId: ownerId, actorName: "x" });
    if (!inv.ok) throw new Error("mint failed");

    const res = await acceptPOST(req(inv.token, { email: "new@partner.test" }), ctx(inv.token));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token.length).toBeGreaterThan(20);
    expect(body.cloneUrl).toContain("/api/git/");
    expect(body.cloneUrl).toContain(`${body.token}@`); // token-bearing
    expect(body.setupPrompt).toContain("git push origin HEAD:main"); // direct policy
    expect(body.setupPrompt).toContain("INSTRUCTIONS.md");
    expect(body.role).toBe("writer");
  });

  it("setup prompt push line follows push_policy=proposal", async () => {
    await setSpacePushPolicy("proj", "proposal", "test");
    const inv = await createInvite({ spaceSlug: "proj", role: "writer", createdByUserId: ownerId, actorName: "x" });
    if (!inv.ok) throw new Error("mint failed");

    const res = await acceptPOST(req(inv.token, { email: "p@partner.test" }), ctx(inv.token));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.setupPrompt).toContain("HEAD:proposals/");
    expect(body.setupPrompt).not.toContain("HEAD:main");
  });

  it("missing email → 400", async () => {
    const inv = await createInvite({ spaceSlug: "proj", role: "writer", createdByUserId: ownerId, actorName: "x" });
    if (!inv.ok) throw new Error("mint failed");
    const res = await acceptPOST(req(inv.token, {}), ctx(inv.token));
    expect(res.status).toBe(400);
  });

  it("unknown / expired / over-cap / revoked → uniform 404", async () => {
    // unknown
    expect((await acceptPOST(req("garbage", { email: "a@b.test" }), ctx("garbage"))).status).toBe(404);

    // expired
    const exp = await createInvite({ spaceSlug: "proj", role: "writer", createdByUserId: ownerId, actorName: "x" });
    if (!exp.ok) throw new Error();
    await db.update(schema.spaceInvites).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.spaceInvites.id, exp.id));
    expect((await acceptPOST(req(exp.token, { email: "a@b.test" }), ctx(exp.token))).status).toBe(404);

    // over-cap (maxUses 1, accept twice)
    const cap = await createInvite({ spaceSlug: "proj", role: "reader", createdByUserId: ownerId, maxUses: 1, actorName: "x" });
    if (!cap.ok) throw new Error();
    expect((await acceptPOST(req(cap.token, { email: "first@b.test" }), ctx(cap.token))).status).toBe(200);
    expect((await acceptPOST(req(cap.token, { email: "second@b.test" }), ctx(cap.token))).status).toBe(404);

    // revoked
    const rev = await createInvite({ spaceSlug: "proj", role: "writer", createdByUserId: ownerId, actorName: "x" });
    if (!rev.ok) throw new Error();
    await db.update(schema.spaceInvites).set({ revokedAt: new Date() }).where(eq(schema.spaceInvites.id, rev.id));
    expect((await acceptPOST(req(rev.token, { email: "a@b.test" }), ctx(rev.token))).status).toBe(404);
  });

  it("no email-existence leak: same 200 shape for an existing vs new email", async () => {
    // Seed an existing user with a verified email.
    const [existing] = await db
      .insert(schema.users)
      .values({ email: "known@partner.test", displayName: "Known", role: "member", active: 1 })
      .returning({ id: schema.users.id });
    await db.insert(schema.userEmails).values({ userId: existing.id, email: "known@partner.test" });

    const i1 = await createInvite({ spaceSlug: "proj", role: "writer", createdByUserId: ownerId, actorName: "x" });
    const i2 = await createInvite({ spaceSlug: "proj", role: "writer", createdByUserId: ownerId, actorName: "x" });
    if (!i1.ok || !i2.ok) throw new Error();

    const rExisting = await acceptPOST(req(i1.token, { email: "known@partner.test" }), ctx(i1.token));
    const rNew = await acceptPOST(req(i2.token, { email: "fresh@partner.test" }), ctx(i2.token));
    expect(rExisting.status).toBe(rNew.status); // both 200
    const bExisting = await rExisting.json();
    const bNew = await rNew.json();
    expect(Object.keys(bExisting).sort()).toEqual(Object.keys(bNew).sort());
  });
});
