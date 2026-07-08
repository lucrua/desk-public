import { describe, it, expect, beforeEach } from "vitest";
import { resetDb } from "@/test/db";
import { spaceCtx } from "@/test/space-ctx";
import { db, schema } from "@/db";
import { PATCH as mirrorPATCH } from "./route";
import { POST as createSpacePOST } from "../../../route";
import { getPrincipal } from "@/lib/auth";
import { resolvePrincipalUserId } from "@/lib/principal-user";

/**
 * PATCH /api/spaces/[slug]/mirror — set source_mode / mirror_remote_url.
 * Gate is the EXACT SAME owner-or-admin `canManageSpace` check as
 * `PATCH /api/spaces/[slug]` (visibility/push_policy): staff-only (403
 * anonymous), then owner-or-admin (403 non-owner member), unknown space (404).
 * Mirrors the test shape of `../invites/route.test.ts` /
 * `../route` visibility+push_policy suite.
 */

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
const ctx = (slug: string) => spaceCtx(slug);

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

describe("PATCH /api/spaces/[slug]/mirror", () => {
  let adminOwnerId: number;
  beforeEach(async () => {
    await resetDb();
    adminOwnerId = await seedUser("owner", "admin");
    await createSpacePOST(req("/api/spaces", "POST", "admin", { slug: "p", ownerUserId: adminOwnerId }));
  });

  describe("auth — owner-or-admin only (matches visibility/push_policy)", () => {
    it("anonymous → 403", async () => {
      const res = await mirrorPATCH(
        req("/api/spaces/p/mirror", "PATCH", "anonymous", { source_mode: "mirrored" }),
        ctx("p"),
      );
      expect(res.status).toBe(403);
    });

    it("a member who is NOT the owner → 403", async () => {
      const res = await mirrorPATCH(
        req("/api/spaces/p/mirror", "PATCH", "member", { source_mode: "mirrored" }),
        ctx("p"),
      );
      expect(res.status).toBe(403);
    });

    it("admin → 200", async () => {
      const res = await mirrorPATCH(
        req("/api/spaces/p/mirror", "PATCH", "admin", { source_mode: "mirrored" }),
        ctx("p"),
      );
      expect(res.status).toBe(200);
    });

    it("the space OWNER (non-admin) can set mirror config → 200", async () => {
      const memberId = await devMemberUserId();
      await createSpacePOST(req("/api/spaces", "POST", "admin", { slug: "owned", ownerUserId: memberId }));
      const res = await mirrorPATCH(
        req("/api/spaces/owned/mirror", "PATCH", "member", { mirror_remote_url: "https://github.com/o/r.git" }),
        ctx("owned"),
      );
      expect(res.status).toBe(200);
    });

    it("unknown space → 404", async () => {
      const res = await mirrorPATCH(
        req("/api/spaces/nope/mirror", "PATCH", "admin", { source_mode: "hosted" }),
        ctx("nope"),
      );
      expect(res.status).toBe(404);
    });
  });

  describe("validation + effect", () => {
    it("no fields supplied → 400", async () => {
      const res = await mirrorPATCH(req("/api/spaces/p/mirror", "PATCH", "admin", {}), ctx("p"));
      expect(res.status).toBe(400);
    });

    it("invalid source_mode → 400", async () => {
      const res = await mirrorPATCH(
        req("/api/spaces/p/mirror", "PATCH", "admin", { source_mode: "banana" }),
        ctx("p"),
      );
      expect(res.status).toBe(400);
    });

    it("invalid mirror_remote_url type → 400", async () => {
      const res = await mirrorPATCH(
        req("/api/spaces/p/mirror", "PATCH", "admin", { mirror_remote_url: 42 }),
        ctx("p"),
      );
      expect(res.status).toBe(400);
    });

    it("sets source_mode and mirror_remote_url, returned + persisted", async () => {
      const res = await mirrorPATCH(
        req("/api/spaces/p/mirror", "PATCH", "admin", {
          source_mode: "mirrored",
          mirror_remote_url: "https://github.com/o/r.git",
        }),
        ctx("p"),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({
        ok: true,
        sourceMode: "mirrored",
        mirrorRemoteUrl: "https://github.com/o/r.git",
        mirrorState: null,
      });
      const space = await db.query.spaces.findFirst({ where: (s, { eq }) => eq(s.slug, "p") });
      expect(space?.sourceMode).toBe("mirrored");
      expect(space?.mirrorRemoteUrl).toBe("https://github.com/o/r.git");
    });

    it("mirror_remote_url: null clears the remote without touching source_mode", async () => {
      await mirrorPATCH(
        req("/api/spaces/p/mirror", "PATCH", "admin", {
          source_mode: "mirrored",
          mirror_remote_url: "https://github.com/o/r.git",
        }),
        ctx("p"),
      );
      const res = await mirrorPATCH(
        req("/api/spaces/p/mirror", "PATCH", "admin", { mirror_remote_url: null }),
        ctx("p"),
      );
      expect(res.status).toBe(200);
      const space = await db.query.spaces.findFirst({ where: (s, { eq }) => eq(s.slug, "p") });
      expect(space?.mirrorRemoteUrl).toBeNull();
      expect(space?.sourceMode).toBe("mirrored"); // unchanged
    });

    it("defaults to hosted with null mirror columns (regression)", async () => {
      const space = await db.query.spaces.findFirst({ where: (s, { eq }) => eq(s.slug, "p") });
      expect(space?.sourceMode).toBe("hosted");
      expect(space?.mirrorRemoteUrl).toBeNull();
      expect(space?.mirrorState).toBeNull();
    });
  });
});
