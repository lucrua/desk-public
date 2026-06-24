import { describe, it, expect, beforeEach } from "vitest";
import { resetDb } from "@/test/db";
import { db, schema } from "@/db";
import { POST as createInvitePOST } from "./route";
import { POST as createSpacePOST } from "../../route";
import { PATCH as spacePATCH } from "../route";
import { getPrincipal } from "@/lib/auth";
import { resolvePrincipalUserId } from "@/lib/principal-user";

type Role = "admin" | "member" | "anonymous";
function headers(role: Role): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (role !== "anonymous") h["x-dev-role"] = role;
  return h;
}
function req(url: string, method: string, role: Role, body?: unknown) {
  return new Request(`http://test${url}`, {
    method,
    headers: headers(role),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
const ctx = (slug: string) => ({ params: Promise.resolve({ slug }) });

async function devMemberUserId(): Promise<number> {
  const principal = await getPrincipal(new Headers({ "x-dev-role": "member" }));
  const id = await resolvePrincipalUserId(principal);
  if (id == null) throw new Error("dev member did not resolve");
  return id;
}

async function seedUser(tokenName: string, role: "admin" | "member" = "member"): Promise<number> {
  const [u] = await db
    .insert(schema.users)
    .values({ tokenName, displayName: tokenName, role, active: 1 })
    .returning({ id: schema.users.id });
  return u.id;
}

describe("POST /api/spaces/[slug]/invites", () => {
  let adminOwnerId: number;
  beforeEach(async () => {
    await resetDb();
    adminOwnerId = await seedUser("owner", "admin");
  });

  describe("auth — owner-or-admin only", () => {
    it("anonymous → 403", async () => {
      await createSpacePOST(req("/api/spaces", "POST", "admin", { slug: "p", ownerUserId: adminOwnerId }));
      const res = await createInvitePOST(req("/api/spaces/p/invites", "POST", "anonymous", { role: "writer" }), ctx("p"));
      expect(res.status).toBe(403);
    });

    it("a member who is NOT the owner → 403", async () => {
      // Space owned by the admin; a plain member can't invite.
      await createSpacePOST(req("/api/spaces", "POST", "admin", { slug: "p", ownerUserId: adminOwnerId }));
      const res = await createInvitePOST(req("/api/spaces/p/invites", "POST", "member", { role: "writer" }), ctx("p"));
      expect(res.status).toBe(403);
    });

    it("admin → 201 with a one-time invite URL", async () => {
      await createSpacePOST(req("/api/spaces", "POST", "admin", { slug: "p", ownerUserId: adminOwnerId }));
      const res = await createInvitePOST(req("/api/spaces/p/invites", "POST", "admin", { role: "writer" }), ctx("p"));
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.inviteUrl).toContain("/invite/");
      expect(body.role).toBe("writer");
    });

    it("the space OWNER (non-admin) can invite → 201", async () => {
      // A space owned by the dev MEMBER — they manage their own space.
      const memberId = await devMemberUserId();
      await createSpacePOST(req("/api/spaces", "POST", "admin", { slug: "owned", ownerUserId: memberId }));
      const res = await createInvitePOST(req("/api/spaces/owned/invites", "POST", "member", { role: "reader" }), ctx("owned"));
      expect(res.status).toBe(201);
    });
  });

  describe("validation", () => {
    beforeEach(async () => {
      await createSpacePOST(req("/api/spaces", "POST", "admin", { slug: "p", ownerUserId: adminOwnerId }));
    });
    it("unknown space → 404", async () => {
      const res = await createInvitePOST(req("/api/spaces/nope/invites", "POST", "admin", { role: "writer" }), ctx("nope"));
      expect(res.status).toBe(404);
    });
    it("invalid role → 400", async () => {
      const res = await createInvitePOST(req("/api/spaces/p/invites", "POST", "admin", { role: "owner" }), ctx("p"));
      expect(res.status).toBe(400);
    });
    it("invalid maxUses → 400", async () => {
      const res = await createInvitePOST(req("/api/spaces/p/invites", "POST", "admin", { role: "writer", maxUses: 0 }), ctx("p"));
      expect(res.status).toBe(400);
    });
  });
});

describe("PATCH /api/spaces/[slug] — push_policy", () => {
  let adminOwnerId: number;
  beforeEach(async () => {
    await resetDb();
    adminOwnerId = await seedUser("owner", "admin");
    await createSpacePOST(req("/api/spaces", "POST", "admin", { slug: "p", ownerUserId: adminOwnerId }));
  });

  it("defaults to direct; admin sets it to proposal (200)", async () => {
    const res = await spacePATCH(req("/api/spaces/p", "PATCH", "admin", { push_policy: "proposal" }), ctx("p"));
    expect(res.status).toBe(200);
    const space = await db.query.spaces.findFirst({ where: (s, { eq }) => eq(s.slug, "p") });
    expect(space?.pushPolicy).toBe("proposal");
  });

  it("a non-owner member → 403", async () => {
    const res = await spacePATCH(req("/api/spaces/p", "PATCH", "member", { push_policy: "proposal" }), ctx("p"));
    expect(res.status).toBe(403);
  });

  it("the owner (non-admin) can set push_policy", async () => {
    const memberId = await devMemberUserId();
    await createSpacePOST(req("/api/spaces", "POST", "admin", { slug: "owned", ownerUserId: memberId }));
    const res = await spacePATCH(req("/api/spaces/owned", "PATCH", "member", { push_policy: "proposal" }), ctx("owned"));
    expect(res.status).toBe(200);
  });

  it("invalid push_policy → 400", async () => {
    const res = await spacePATCH(req("/api/spaces/p", "PATCH", "admin", { push_policy: "banana" }), ctx("p"));
    expect(res.status).toBe(400);
  });

  it("rejects supplying BOTH visibility and push_policy (400)", async () => {
    const res = await spacePATCH(req("/api/spaces/p", "PATCH", "admin", { push_policy: "direct", visibility: "public" }), ctx("p"));
    expect(res.status).toBe(400);
  });

  it("visibility-only PATCH still works (regression)", async () => {
    const res = await spacePATCH(req("/api/spaces/p", "PATCH", "admin", { visibility: "unlisted" }), ctx("p"));
    expect(res.status).toBe(200);
  });
});
