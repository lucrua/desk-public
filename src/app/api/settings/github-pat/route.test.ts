import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resetDb } from "@/test/db";
import { db, schema } from "@/db";
import { GET as patGET, POST as patPOST, DELETE as patDELETE } from "./route";
import { hasInstanceGithubPat, getInstanceGithubPat } from "@/lib/instance-settings";
import { decryptToken } from "@/lib/crypto";

/**
 * GET/POST/DELETE /api/settings/github-pat — the instance-level GitHub mirror
 * PAT. ADMIN ONLY. PROVES: (a) the gate is admin-only (member/anonymous → 403);
 * (b) the PAT is NEVER returned in any response shape — GET/POST/DELETE all
 * carry only a boolean `configured` — while the value IS actually stored,
 * encrypted, and usable by the (route-inaccessible) internal getter.
 */

const TEST_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="; // 32-byte base64
const PAT = "github_pat_super_secret_value_123";

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

describe("GET/POST/DELETE /api/settings/github-pat", () => {
  let prevKey: string | undefined;
  beforeEach(async () => {
    prevKey = process.env.DESK_TOKEN_KEY;
    process.env.DESK_TOKEN_KEY = TEST_KEY;
    await resetDb();
  });
  afterEach(() => {
    if (prevKey === undefined) delete process.env.DESK_TOKEN_KEY;
    else process.env.DESK_TOKEN_KEY = prevKey;
  });

  describe("auth — admin only", () => {
    it("anonymous → 403 on GET/POST/DELETE", async () => {
      expect((await patGET(req("/api/settings/github-pat", "GET", "anonymous"))).status).toBe(403);
      expect(
        (await patPOST(req("/api/settings/github-pat", "POST", "anonymous", { pat: PAT }))).status,
      ).toBe(403);
      expect((await patDELETE(req("/api/settings/github-pat", "DELETE", "anonymous"))).status).toBe(403);
    });

    it("a plain member → 403 on GET/POST/DELETE", async () => {
      expect((await patGET(req("/api/settings/github-pat", "GET", "member"))).status).toBe(403);
      expect(
        (await patPOST(req("/api/settings/github-pat", "POST", "member", { pat: PAT }))).status,
      ).toBe(403);
      expect((await patDELETE(req("/api/settings/github-pat", "DELETE", "member"))).status).toBe(403);
    });

    it("admin → 200 on all three", async () => {
      expect((await patGET(req("/api/settings/github-pat", "GET", "admin"))).status).toBe(200);
      expect(
        (await patPOST(req("/api/settings/github-pat", "POST", "admin", { pat: PAT }))).status,
      ).toBe(200);
      expect((await patDELETE(req("/api/settings/github-pat", "DELETE", "admin"))).status).toBe(200);
    });
  });

  describe("the PAT is never returned — only a boolean", () => {
    it("GET before set → { configured: false }, nothing else", async () => {
      const res = await patGET(req("/api/settings/github-pat", "GET", "admin"));
      const body = await res.json();
      expect(body).toEqual({ configured: false });
    });

    it("POST sets it: response is exactly { ok:true, configured:true }, no pat key", async () => {
      const res = await patPOST(req("/api/settings/github-pat", "POST", "admin", { pat: PAT }));
      const body = await res.json();
      expect(body).toEqual({ ok: true, configured: true });
      expect(JSON.stringify(body)).not.toContain(PAT);
      expect(Object.keys(body).sort()).toEqual(["configured", "ok"]);
    });

    it("GET after set → { configured: true }, never the value", async () => {
      await patPOST(req("/api/settings/github-pat", "POST", "admin", { pat: PAT }));
      const res = await patGET(req("/api/settings/github-pat", "GET", "admin"));
      const body = await res.json();
      expect(body).toEqual({ configured: true });
      expect(JSON.stringify(body)).not.toContain(PAT);
    });

    it("is actually stored ENCRYPTED and decryptable only by the internal getter", async () => {
      await patPOST(req("/api/settings/github-pat", "POST", "admin", { pat: PAT }));
      const [row] = await db.select().from(schema.instanceSettings);
      expect(row.valueEnc).not.toContain(PAT);
      expect(decryptToken(row.valueEnc)).toBe(PAT);
      expect(await hasInstanceGithubPat()).toBe(true);
      expect(await getInstanceGithubPat()).toBe(PAT); // internal-only, never routed
    });

    it("DELETE clears it: response is { ok:true, configured:false }", async () => {
      await patPOST(req("/api/settings/github-pat", "POST", "admin", { pat: PAT }));
      const res = await patDELETE(req("/api/settings/github-pat", "DELETE", "admin"));
      const body = await res.json();
      expect(body).toEqual({ ok: true, configured: false });
      expect(await hasInstanceGithubPat()).toBe(false);
    });

    it("empty pat → 400", async () => {
      const res = await patPOST(req("/api/settings/github-pat", "POST", "admin", { pat: "" }));
      expect(res.status).toBe(400);
    });

    it("without DESK_TOKEN_KEY, POST refuses to store (500), stays unconfigured", async () => {
      delete process.env.DESK_TOKEN_KEY;
      const res = await patPOST(req("/api/settings/github-pat", "POST", "admin", { pat: PAT }));
      expect(res.status).toBe(500);
      expect(await hasInstanceGithubPat()).toBe(false);
    });
  });
});
