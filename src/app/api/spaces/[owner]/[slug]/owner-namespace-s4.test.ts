/**
 * Owner-namespace S4 — the CANONICAL owner-qualified API route resolves for the
 * RIGHT owner, and a wrong/unknown owner handle is a uniform 404 (no existence
 * leak). Exercised through the space-root PATCH and the members GET; the shared
 * resolver is `getSpace(owner, slug)`.
 *
 * Two axes:
 *   1. SAME slug, two owners (`reports`): each `/api/spaces/<owner>/reports`
 *      RESOLVES (200); an unknown owner handle → 404. (The route's owner-qualified
 *      resolution + boundary; the exhaustive same-slug isolation is proven at the
 *      `getSpace`/`resolveSpaceRole` level in S3.)
 *   2. UNIQUE per-owner slugs — full end-to-end data + a mutation: the right owner
 *      gets the right members and a visibility change lands; a cross-owner or
 *      unknown handle → 404.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { resetDb } from "@/test/db";
import { db, schema } from "@/db";
import { GET as membersGET } from "./members/route";
import { PATCH as visibilityPATCH } from "./route";
import { createSpace } from "@/lib/spaces";

async function seedAdmin(tokenName: string): Promise<number> {
  const [u] = await db
    .insert(schema.users)
    .values({ tokenName, displayName: tokenName, role: "admin", active: 1 })
    .returning({ id: schema.users.id });
  return u.id;
}

function adminReq(url: string, method = "GET", body?: unknown): Request {
  return new Request(`http://test${url}`, {
    method,
    headers: { "content-type": "application/json", "x-dev-role": "admin" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const ctx = (owner: string, slug: string) => ({ params: Promise.resolve({ owner, slug }) });

describe("owner-namespaced space routes (S4) — canonical resolution + wrong-owner 404", () => {
  let alice: number;
  let bob: number;

  beforeEach(async () => {
    await resetDb();
    alice = await seedAdmin("alice");
    bob = await seedAdmin("bob");
    // Same slug, two owners.
    const ar = await createSpace("reports", alice, "private", "t");
    const br = await createSpace("reports", bob, "private", "t");
    // Unique per-owner slugs (end-to-end data lane).
    const aa = await createSpace("alpha", alice, "private", "t");
    if (!ar.ok || !br.ok || !aa.ok) throw new Error("setup failed");
  });

  it("same slug: each /api/spaces/<owner>/reports RESOLVES (200); unknown owner → 404", async () => {
    const ra = await membersGET(adminReq("/api/spaces/alice/reports/members"), ctx("alice", "reports"));
    const rb = await membersGET(adminReq("/api/spaces/bob/reports/members"), ctx("bob", "reports"));
    expect(ra.status).toBe(200);
    expect(rb.status).toBe(200);
    // Unknown handle → uniform 404 (no existence leak).
    const unknown = await membersGET(adminReq("/api/spaces/carol/reports/members"), ctx("carol", "reports"));
    expect(unknown.status).toBe(404);
  });

  it("unique slug: the right owner gets the right members; cross-owner / unknown → 404", async () => {
    const ok = await membersGET(adminReq("/api/spaces/alice/alpha/members"), ctx("alice", "alpha"));
    expect(ok.status).toBe(200);
    const j = (await ok.json()) as { members: { userId: number; isOwner: boolean }[] };
    expect(j.members.find((m) => m.isOwner)?.userId).toBe(alice);

    // bob does NOT own `alpha` → 404 (cross-owner isolation at the route).
    const cross = await membersGET(adminReq("/api/spaces/bob/alpha/members"), ctx("bob", "alpha"));
    expect(cross.status).toBe(404);
    // alice does not own `budget` → 404.
    const wrongSlug = await membersGET(adminReq("/api/spaces/alice/budget/members"), ctx("alice", "budget"));
    expect(wrongSlug.status).toBe(404);
  });

  it("PATCH /api/spaces/<owner>/alpha mutates that space; a wrong owner → 404", async () => {
    const okRes = await visibilityPATCH(
      adminReq("/api/spaces/alice/alpha", "PATCH", { visibility: "public" }),
      ctx("alice", "alpha"),
    );
    expect(okRes.status).toBe(200);
    const row = await db.query.spaces.findFirst({
      where: (s, { and, eq }) => and(eq(s.slug, "alpha"), eq(s.ownerUserId, alice)),
    });
    expect(row?.visibility).toBe("public");

    const wrong = await visibilityPATCH(
      adminReq("/api/spaces/carol/alpha", "PATCH", { visibility: "public" }),
      ctx("carol", "alpha"),
    );
    expect(wrong.status).toBe(404);
  });
});
