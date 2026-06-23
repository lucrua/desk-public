import { describe, it, expect, beforeEach } from "vitest";
import { resetDb } from "@/test/db";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
import { GET as listGET, POST as createPOST } from "./route";
import { POST as membersPOST, GET as membersGET } from "./[slug]/members/route";
import { PATCH as visibilityPATCH } from "./[slug]/route";
import { getPrincipal } from "@/lib/auth";
import { resolvePrincipalUserId, DEV_MEMBER_TOKEN_NAME } from "@/lib/principal-user";

/**
 * The users.id the dev `member` role-switcher resolves to (the reserved
 * `dev-member` stub row). Resolving a member principal creates it on first need;
 * we use it to seed a space OWNED BY the dev member so the owner-authz path can
 * be exercised (a non-admin owner managing their own space).
 */
async function devMemberUserId(): Promise<number> {
  const principal = await getPrincipal(
    new Headers({ "x-dev-role": "member" }),
  );
  const id = await resolvePrincipalUserId(principal);
  if (id == null) throw new Error("dev member did not resolve");
  return id;
}

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

async function seedUser(tokenName: string, role: "admin" | "member" = "member"): Promise<number> {
  const [u] = await db
    .insert(schema.users)
    .values({ tokenName, displayName: tokenName, role, active: 1 })
    .returning({ id: schema.users.id });
  return u.id;
}

describe("spaces REST routes", () => {
  let ownerId: number;
  beforeEach(async () => {
    await resetDb();
    ownerId = await seedUser("owner", "admin");
  });

  describe("auth gates", () => {
    it("anonymous → 403 on list + create", async () => {
      expect((await listGET(req("/api/spaces", "GET", "anonymous"))).status).toBe(403);
      expect(
        (await createPOST(req("/api/spaces", "POST", "anonymous", { slug: "x", ownerUserId: ownerId }))).status,
      ).toBe(403);
    });
    it("member cannot create a space (admin only)", async () => {
      const res = await createPOST(req("/api/spaces", "POST", "member", { slug: "x", ownerUserId: ownerId }));
      expect(res.status).toBe(403);
    });
    it("member cannot manage members on a space they don't own (403)", async () => {
      // Space owned by the admin; a non-admin non-owner member is forbidden.
      // (The space must EXIST — an unknown space is a uniform 404 before authz.)
      await createPOST(req("/api/spaces", "POST", "admin", { slug: "x", ownerUserId: ownerId }));
      const res = await membersPOST(
        req("/api/spaces/x/members", "POST", "member", { userId: ownerId, role: "reader" }),
        ctx("x"),
      );
      expect(res.status).toBe(403);
    });
  });

  describe("create + list", () => {
    it("admin creates a space (201) and it appears in list", async () => {
      const created = await createPOST(
        req("/api/spaces", "POST", "admin", { slug: "proj", ownerUserId: ownerId, visibility: "unlisted" }),
      );
      expect(created.status).toBe(201);
      const body = await created.json();
      expect(body.space.slug).toBe("proj");

      const list = await listGET(req("/api/spaces", "GET", "admin"));
      expect(list.status).toBe(200);
      const lb = await list.json();
      expect(lb.spaces.map((s: { slug: string }) => s.slug)).toContain("proj");
    });

    it("creates a space WITHOUT ownerUserId (dev-mode owner resolves via the principal)", async () => {
      // No ownerUserId in the body — the route must resolve the creator's user
      // via resolvePrincipalUserId (dev admin → an active admin), not rely on
      // principal.userId (undefined in dev). Regression guard for the dev gap.
      const created = await createPOST(req("/api/spaces", "POST", "admin", { slug: "no-owner" }));
      expect(created.status).toBe(201);
      const body = await created.json();
      expect(body.space.slug).toBe("no-owner");
      expect(typeof body.space.ownerUserId).toBe("number");
    });

    it("rejects an invalid slug (400)", async () => {
      const res = await createPOST(req("/api/spaces", "POST", "admin", { slug: "Bad Slug", ownerUserId: ownerId }));
      expect(res.status).toBe(400);
    });

    it("rejects a duplicate slug (400)", async () => {
      await createPOST(req("/api/spaces", "POST", "admin", { slug: "dup", ownerUserId: ownerId }));
      const res = await createPOST(req("/api/spaces", "POST", "admin", { slug: "dup", ownerUserId: ownerId }));
      expect(res.status).toBe(400);
    });
  });

  describe("member management", () => {
    it("admin sets, updates, removes a member role", async () => {
      const u = await seedUser("member-x");
      await createPOST(req("/api/spaces", "POST", "admin", { slug: "g", ownerUserId: ownerId }));

      const add = await membersPOST(req("/api/spaces/g/members", "POST", "admin", { userId: u, role: "reader" }), ctx("g"));
      expect(add.status).toBe(200);
      expect((await add.json()).role).toBe("reader");

      const rm = await membersPOST(req("/api/spaces/g/members", "POST", "admin", { userId: u, role: null }), ctx("g"));
      expect(rm.status).toBe(200);
      expect((await rm.json()).role).toBe(null);
    });

    it("cannot demote the owner (400)", async () => {
      await createPOST(req("/api/spaces", "POST", "admin", { slug: "g2", ownerUserId: ownerId }));
      const res = await membersPOST(
        req("/api/spaces/g2/members", "POST", "admin", { userId: ownerId, role: "reader" }),
        ctx("g2"),
      );
      expect(res.status).toBe(400);
    });

    it("rejects an invalid role (400)", async () => {
      const u = await seedUser("member-y");
      await createPOST(req("/api/spaces", "POST", "admin", { slug: "g3", ownerUserId: ownerId }));
      const res = await membersPOST(
        req("/api/spaces/g3/members", "POST", "admin", { userId: u, role: "owner" }),
        ctx("g3"),
      );
      expect(res.status).toBe(400);
    });
  });

  describe("member list (GET)", () => {
    it("admin lists members; owner is first and flagged", async () => {
      const u = await seedUser("reader-z");
      await createPOST(req("/api/spaces", "POST", "admin", { slug: "gl", ownerUserId: ownerId }));
      await membersPOST(req("/api/spaces/gl/members", "POST", "admin", { userId: u, role: "reader" }), ctx("gl"));

      const res = await membersGET(req("/api/spaces/gl/members", "GET", "admin"), ctx("gl"));
      expect(res.status).toBe(200);
      const members = (await res.json()).members as Array<{ userId: number; role: string; isOwner: boolean }>;
      expect(members[0].isOwner).toBe(true);
      expect(members[0].userId).toBe(ownerId);
      expect(members.some((m) => m.userId === u && m.role === "reader")).toBe(true);
    });

    it("unknown space → 404", async () => {
      const res = await membersGET(req("/api/spaces/nope/members", "GET", "admin"), ctx("nope"));
      expect(res.status).toBe(404);
    });

    it("a non-member (dev member, not on this space) → 404 (no leak)", async () => {
      await createPOST(req("/api/spaces", "POST", "admin", { slug: "gp", ownerUserId: ownerId }));
      const res = await membersGET(req("/api/spaces/gp/members", "GET", "member"), ctx("gp"));
      expect(res.status).toBe(404);
    });
  });

  describe("visibility (PATCH)", () => {
    it("admin changes visibility; member is forbidden; unknown space → 404", async () => {
      await createPOST(req("/api/spaces", "POST", "admin", { slug: "gv", ownerUserId: ownerId }));

      const member = await visibilityPATCH(
        req("/api/spaces/gv", "PATCH", "member", { visibility: "public" }),
        ctx("gv"),
      );
      expect(member.status).toBe(403);

      const ok = await visibilityPATCH(
        req("/api/spaces/gv", "PATCH", "admin", { visibility: "public" }),
        ctx("gv"),
      );
      expect(ok.status).toBe(200);

      const listed = await listGET(req("/api/spaces", "GET", "admin"));
      const found = (await listed.json()).spaces.find((s: { slug: string }) => s.slug === "gv");
      expect(found.visibility).toBe("public");

      const bad = await visibilityPATCH(
        req("/api/spaces/gv", "PATCH", "admin", { visibility: "nope" }),
        ctx("gv"),
      );
      expect(bad.status).toBe(400);

      const missing = await visibilityPATCH(
        req("/api/spaces/none", "PATCH", "admin", { visibility: "public" }),
        ctx("none"),
      );
      expect(missing.status).toBe(404);
    });
  });

  // Fix #3: a bad visibility on CREATE is a 400, not a silent coercion to private.
  describe("create — visibility validation", () => {
    it("rejects an unknown visibility (400) instead of coercing to private", async () => {
      const res = await createPOST(
        req("/api/spaces", "POST", "admin", { slug: "vbad", visibility: "banana", ownerUserId: ownerId }),
      );
      expect(res.status).toBe(400);
      // Nothing was created.
      const list = await listGET(req("/api/spaces", "GET", "admin"));
      const slugs = (await list.json()).spaces.map((s: { slug: string }) => s.slug);
      expect(slugs).not.toContain("vbad");
    });

    it("still defaults to private when visibility is omitted", async () => {
      const res = await createPOST(req("/api/spaces", "POST", "admin", { slug: "vdef", ownerUserId: ownerId }));
      expect(res.status).toBe(201);
      expect((await res.json()).space.visibility).toBe("private");
    });

    it("accepts each valid visibility", async () => {
      for (const v of ["private", "unlisted", "public"] as const) {
        const res = await createPOST(
          req("/api/spaces", "POST", "admin", { slug: `v-${v}`, visibility: v, ownerUserId: ownerId }),
        );
        expect(res.status).toBe(201);
        expect((await res.json()).space.visibility).toBe(v);
      }
    });
  });

  // Fix #2 (MAJOR): owner-or-admin can manage an EXISTING space (visibility +
  // members); a non-owner non-admin member is forbidden; admin manages any.
  describe("owner-vs-admin management authz", () => {
    it("a non-admin OWNER can PATCH visibility + add a member on a space THEY own", async () => {
      // Space owned BY the dev member (the principal `x-dev-role: member`
      // resolves to). Create it directly so ownership is the dev member.
      const memberId = await devMemberUserId();
      const target = await seedUser("addee");
      await createPOST(
        req("/api/spaces", "POST", "admin", { slug: "owned", ownerUserId: memberId }),
      );

      // Owner (non-admin) flips visibility.
      const vis = await visibilityPATCH(
        req("/api/spaces/owned", "PATCH", "member", { visibility: "unlisted" }),
        ctx("owned"),
      );
      expect(vis.status).toBe(200);
      const space = await db.query.spaces.findFirst({ where: eq(schema.spaces.slug, "owned") });
      expect(space!.visibility).toBe("unlisted");

      // Owner (non-admin) adds a member.
      const add = await membersPOST(
        req("/api/spaces/owned/members", "POST", "member", { userId: target, role: "reader" }),
        ctx("owned"),
      );
      expect(add.status).toBe(200);
      expect((await add.json()).role).toBe("reader");
    });

    it("a non-owner non-admin member is FORBIDDEN (403) on a space they don't own", async () => {
      // Space owned by the ADMIN; the dev member is neither admin nor owner.
      await createPOST(req("/api/spaces", "POST", "admin", { slug: "notmine", ownerUserId: ownerId }));
      const target = await seedUser("addee2");

      const vis = await visibilityPATCH(
        req("/api/spaces/notmine", "PATCH", "member", { visibility: "public" }),
        ctx("notmine"),
      );
      expect(vis.status).toBe(403);

      const add = await membersPOST(
        req("/api/spaces/notmine/members", "POST", "member", { userId: target, role: "reader" }),
        ctx("notmine"),
      );
      expect(add.status).toBe(403);
    });

    it("an ADMIN can manage ANY space (incl. one owned by someone else)", async () => {
      const memberId = await devMemberUserId();
      const target = await seedUser("addee3");
      await createPOST(req("/api/spaces", "POST", "admin", { slug: "any", ownerUserId: memberId }));

      const vis = await visibilityPATCH(
        req("/api/spaces/any", "PATCH", "admin", { visibility: "public" }),
        ctx("any"),
      );
      expect(vis.status).toBe(200);

      const add = await membersPOST(
        req("/api/spaces/any/members", "POST", "admin", { userId: target, role: "writer" }),
        ctx("any"),
      );
      expect(add.status).toBe(200);
      expect((await add.json()).role).toBe("writer");
    });

    it("unknown space → 404 on both manage endpoints (before the authz check)", async () => {
      const vis = await visibilityPATCH(
        req("/api/spaces/ghost", "PATCH", "admin", { visibility: "public" }),
        ctx("ghost"),
      );
      expect(vis.status).toBe(404);
      const add = await membersPOST(
        req("/api/spaces/ghost/members", "POST", "admin", { userId: ownerId, role: "reader" }),
        ctx("ghost"),
      );
      expect(add.status).toBe(404);
    });

    it("add-role stays reader|writer — no owner transfer via members POST (400)", async () => {
      const memberId = await devMemberUserId();
      const target = await seedUser("addee4");
      await createPOST(req("/api/spaces", "POST", "admin", { slug: "noxfer", ownerUserId: memberId }));
      const res = await membersPOST(
        req("/api/spaces/noxfer/members", "POST", "member", { userId: target, role: "owner" }),
        ctx("noxfer"),
      );
      expect(res.status).toBe(400);
    });
  });
});
