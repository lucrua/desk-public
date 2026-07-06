import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resetDb } from "@/test/db";
import { db, schema } from "@/db";
import { POST as deployKeyPOST, DELETE as deployKeyDELETE } from "./route";
import { POST as createSpacePOST } from "../../../route";
import { hasSpaceDeployKey } from "@/lib/mirror";
import { getPrincipal } from "@/lib/auth";
import { resolvePrincipalUserId } from "@/lib/principal-user";

/**
 * POST/DELETE /api/spaces/[slug]/mirror/deploy-key — the per-space deploy-key
 * paste field. Same owner-or-admin gate as the other mirror-settings routes.
 * PROVES: the PEM is never echoed back in ANY response shape (set → only
 * {ok,hasDeployKey}; the stored value is asserted via `hasSpaceDeployKey`, the
 * boolean-only accessor — never a plaintext read).
 */

const TEST_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="; // 32-byte base64
const PEM = "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAsupersecretkeymaterial\n-----END OPENSSH PRIVATE KEY-----";

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

describe("POST/DELETE /api/spaces/[slug]/mirror/deploy-key", () => {
  let adminOwnerId: number;
  let prevKey: string | undefined;

  beforeEach(async () => {
    prevKey = process.env.DESK_TOKEN_KEY;
    process.env.DESK_TOKEN_KEY = TEST_KEY;
    await resetDb();
    adminOwnerId = await seedUser("owner", "admin");
    await createSpacePOST(req("/api/spaces", "POST", "admin", { slug: "p", ownerUserId: adminOwnerId }));
  });
  afterEach(() => {
    if (prevKey === undefined) delete process.env.DESK_TOKEN_KEY;
    else process.env.DESK_TOKEN_KEY = prevKey;
  });

  describe("auth — owner-or-admin only", () => {
    it("anonymous → 403", async () => {
      const res = await deployKeyPOST(
        req("/api/spaces/p/mirror/deploy-key", "POST", "anonymous", { privateKeyPem: PEM }),
        ctx("p"),
      );
      expect(res.status).toBe(403);
    });

    it("a member who is NOT the owner → 403", async () => {
      const res = await deployKeyPOST(
        req("/api/spaces/p/mirror/deploy-key", "POST", "member", { privateKeyPem: PEM }),
        ctx("p"),
      );
      expect(res.status).toBe(403);
    });

    it("the space OWNER (non-admin) can set the deploy key → 200", async () => {
      const memberId = await devMemberUserId();
      await createSpacePOST(req("/api/spaces", "POST", "admin", { slug: "owned", ownerUserId: memberId }));
      const res = await deployKeyPOST(
        req("/api/spaces/owned/mirror/deploy-key", "POST", "member", { privateKeyPem: PEM }),
        ctx("owned"),
      );
      expect(res.status).toBe(200);
    });

    it("unknown space → 404", async () => {
      const res = await deployKeyPOST(
        req("/api/spaces/nope/mirror/deploy-key", "POST", "admin", { privateKeyPem: PEM }),
        ctx("nope"),
      );
      expect(res.status).toBe(404);
    });
  });

  describe("set/clear — the response NEVER carries the key", () => {
    it("sets the key: response is {ok,hasDeployKey:true} only, stored encrypted", async () => {
      const res = await deployKeyPOST(
        req("/api/spaces/p/mirror/deploy-key", "POST", "admin", { privateKeyPem: PEM }),
        ctx("p"),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ ok: true, hasDeployKey: true });
      expect(JSON.stringify(body)).not.toContain("secretkeymaterial");
      expect(await hasSpaceDeployKey("p")).toBe(true);

      const space = await db.query.spaces.findFirst({ where: (s, { eq }) => eq(s.slug, "p") });
      expect(space?.mirrorDeployKeyEnc).toBeTruthy();
      expect(space?.mirrorDeployKeyEnc).not.toContain("secretkeymaterial");
    });

    it("clears the key: response is {ok,hasDeployKey:false}", async () => {
      await deployKeyPOST(
        req("/api/spaces/p/mirror/deploy-key", "POST", "admin", { privateKeyPem: PEM }),
        ctx("p"),
      );
      const res = await deployKeyDELETE(
        req("/api/spaces/p/mirror/deploy-key", "DELETE", "admin"),
        ctx("p"),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ ok: true, hasDeployKey: false });
      expect(await hasSpaceDeployKey("p")).toBe(false);
    });

    it("empty privateKeyPem → 400", async () => {
      const res = await deployKeyPOST(
        req("/api/spaces/p/mirror/deploy-key", "POST", "admin", { privateKeyPem: "" }),
        ctx("p"),
      );
      expect(res.status).toBe(400);
    });

    it("without DESK_TOKEN_KEY, refuses to store (500), key stays unset", async () => {
      delete process.env.DESK_TOKEN_KEY;
      const res = await deployKeyPOST(
        req("/api/spaces/p/mirror/deploy-key", "POST", "admin", { privateKeyPem: PEM }),
        ctx("p"),
      );
      expect(res.status).toBe(500);
      expect(await hasSpaceDeployKey("p")).toBe(false);
    });
  });
});
