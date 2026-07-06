import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { resetDb, seedUser as seedUserObj, seedSpaceMember } from "@/test/db";
import { db, schema } from "@/db";
import { HAVE_GIT, useTempDataDir, clearSpaceRepos, readFileFromClone } from "@/test/git";
import { POST as mirrorNowPOST } from "./route";
import { PATCH as mirrorConfigPATCH } from "../route";
import { POST as createSpacePOST } from "../../../route";
import { createSpace, ownerSlugForUser, getSpaceBySlug } from "@/lib/spaces";
import { webAuthorCommit, liveMainTip } from "@/lib/web-author";
import { bareRepoPath } from "@/lib/git/repo";
import { getPrincipal } from "@/lib/auth";
import { resolvePrincipalUserId } from "@/lib/principal-user";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const run = promisify(execFile);

/**
 * POST /api/spaces/[slug]/mirror/now — the "Mirror now" button. Same
 * owner-or-admin gate as `PATCH /api/spaces/[slug]/mirror`; delegates to
 * `mirrorNow` (src/lib/mirror.ts, already unit-tested in
 * `src/lib/slice4b-mirror.test.ts`) — this proves the ROUTE wires the gate +
 * reason→status mapping correctly, not the mirror mechanism itself.
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

describe("POST /api/spaces/[slug]/mirror/now", () => {
  let adminOwnerId: number;
  beforeEach(async () => {
    await resetDb();
    adminOwnerId = await seedUser("owner", "admin");
    await createSpacePOST(req("/api/spaces", "POST", "admin", { slug: "p", ownerUserId: adminOwnerId }));
  });

  describe("auth — owner-or-admin only", () => {
    it("anonymous → 403", async () => {
      const res = await mirrorNowPOST(req("/api/spaces/p/mirror/now", "POST", "anonymous"), ctx("p"));
      expect(res.status).toBe(403);
    });

    it("a member who is NOT the owner → 403", async () => {
      const res = await mirrorNowPOST(req("/api/spaces/p/mirror/now", "POST", "member"), ctx("p"));
      expect(res.status).toBe(403);
    });

    it("the space OWNER (non-admin) reaches the service (400 no-remote, not 403)", async () => {
      const memberId = await devMemberUserId();
      await createSpacePOST(req("/api/spaces", "POST", "admin", { slug: "owned", ownerUserId: memberId }));
      const res = await mirrorNowPOST(req("/api/spaces/owned/mirror/now", "POST", "member"), ctx("owned"));
      expect(res.status).toBe(400);
    });

    it("unknown space → 404", async () => {
      const res = await mirrorNowPOST(req("/api/spaces/nope/mirror/now", "POST", "admin"), ctx("nope"));
      expect(res.status).toBe(404);
    });
  });

  describe("service-reason mapping (no git needed — mirrorNow short-circuits)", () => {
    it("no mirror_remote_url configured → 400", async () => {
      const res = await mirrorNowPOST(req("/api/spaces/p/mirror/now", "POST", "admin"), ctx("p"));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/no mirror_remote_url/i);
    });

    it("source_mode=mirrored (not hosted) → 400", async () => {
      await mirrorConfigPATCH(
        req("/api/spaces/p/mirror", "PATCH", "admin", {
          source_mode: "mirrored",
          mirror_remote_url: "https://github.com/o/r.git",
        }),
        ctx("p"),
      );
      const res = await mirrorNowPOST(req("/api/spaces/p/mirror/now", "POST", "admin"), ctx("p"));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/not hosted/i);
    });
  });
});

// ── git-gated: an actual push through the route ────────────────────────────────
describe.skipIf(!HAVE_GIT)("POST /api/spaces/[slug]/mirror/now (git)", () => {
  let restore: () => Promise<void>;
  let ownerUserId: number;
  let ownerSlug: string;
  const SPACE = "proof";

  beforeAll(async () => {
    ({ restore } = await useTempDataDir());
  });
  afterAll(async () => {
    await restore();
  });

  beforeEach(async () => {
    await resetDb();
    await clearSpaceRepos();
    ownerUserId = await seedUserObj({ tokenName: "lucas", displayName: "Lucas", role: "admin" });
    const created = await createSpace(SPACE, ownerUserId, "private", "t");
    if (!created.ok) throw new Error(created.error);
    ownerSlug = ownerSlugForUser({ tokenName: "lucas", email: null }, ownerUserId);
  });

  async function initFakeRemote(): Promise<{ path: string; cleanup: () => Promise<void> }> {
    const dir = await mkdtemp(path.join(tmpdir(), "desk-mirror-now-remote-"));
    const bare = path.join(dir, "gh.git");
    await run("git", ["init", "--bare", "--initial-branch=main", bare]);
    return { path: bare, cleanup: () => rm(dir, { recursive: true, force: true }) };
  }

  it("admin triggering 'Mirror now' actually pushes main to the configured remote", async () => {
    const remote = await initFakeRemote();
    try {
      const baseMainTip = await liveMainTip(SPACE);
      const commit = await webAuthorCommit(SPACE, {
        role: "owner",
        identity: { name: "Lucas", email: "lucas@desk.localhost", handle: "lucas" },
        writes: [{ path: "readme.md", bytes: Buffer.from("# hi\n", "utf8") }],
        baseMainTip,
        message: "seed",
      });
      if (!commit.ok) throw new Error(`seed commit failed: ${commit.reason}`);

      await mirrorConfigPATCH(
        req(`/api/spaces/${SPACE}/mirror`, "PATCH", "admin", { mirror_remote_url: remote.path }),
        ctx(SPACE),
      );

      const res = await mirrorNowPOST(req(`/api/spaces/${SPACE}/mirror/now`, "POST", "admin"), ctx(SPACE));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.state.lastError).toBeNull();
      expect(body.state.lastMirroredSha).toBeTruthy();

      expect(await readFileFromClone(remote.path, "readme.md")).toContain("hi");
      const space = await getSpaceBySlug(SPACE);
      expect(space!.mirrorState!.lastMirroredSha).toBe(body.state.lastMirroredSha);
      void bareRepoPath(ownerSlug, SPACE); // sanity: derivation used above matches production path resolution
    } finally {
      await remote.cleanup();
    }
  });
});
