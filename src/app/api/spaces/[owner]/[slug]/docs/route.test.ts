/**
 * Route-level authz matrix for the web-author write endpoint (Web-author W1/W2,
 * Security assertions 1-4). Calls the POST/PUT handlers directly with crafted
 * dev-auth requests + a temp DESK_DATA_DIR so the real git binary commits into
 * an on-disk bare repo. No socket.
 *
 * The dev role-switcher maps `x-dev-role: admin` → the lowest active admin user
 * and `x-dev-role: member` → the reserved `dev-member` user (principal-user.ts).
 * So we make the dev-admin the space OWNER and the dev-member a WRITER/READER to
 * exercise every role through the same header.
 *
 * Covered:
 *  1. reader / non-member / anonymous write → uniform 404, main tip UNCHANGED.
 *  2. writer under push_policy=proposal → cannot commit main; lands on
 *     proposals/<handle>; main UNCHANGED.
 *  3. CAS: two edits off the same baseCommit → second is 409 stale, no clobber.
 *  4. owner/admin commit to main → 200, projects (docs row), git has the commit.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { eq, and } from "drizzle-orm";
import { resetDb } from "@/test/db";
import { spaceCtx } from "@/test/space-ctx";
import { db, schema } from "@/db";
import {
  createSpace,
  setSpaceMemberRole,
  setSpacePushPolicy,
  ownerSlugForUser,
} from "@/lib/spaces";
import { resolvePrincipalUserId } from "@/lib/principal-user";
import { bareRepoPath, refTip } from "@/lib/git/repo";
import { POST, PUT } from "./route";

const run = promisify(execFile);

let HAVE_GIT = true;
try {
  await run("git", ["--version"]);
} catch {
  HAVE_GIT = false;
}

const SPACE = "wa";

function reqJson(method: string, role: string | null, body: unknown): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (role) headers["x-dev-role"] = role;
  return new Request(`http://localhost/api/spaces/${SPACE}/docs`, {
    method,
    headers,
    body: JSON.stringify(body),
  });
}

const ctx = () => spaceCtx(SPACE);

describe.skipIf(!HAVE_GIT)("web-author route authz matrix", () => {
  let dataDir: string;
  let prevDataDir: string | undefined;
  let ownerSlug: string;
  let ownerUserId: number;

  beforeAll(async () => {
    await resetDb();
    dataDir = await mkdtemp(path.join(tmpdir(), "desk-wa-route-"));
    prevDataDir = process.env.DESK_DATA_DIR;
    process.env.DESK_DATA_DIR = dataDir;

    // dev-admin = lowest active admin → the space OWNER.
    ownerUserId = (await resolvePrincipalUserId({ kind: "admin", name: "Dev Admin" }))!;
    // dev-member = the reserved stub user → a space member we toggle writer/reader.
    const memberUserId = (await resolvePrincipalUserId({ kind: "member", name: "Dev Member" }))!;

    const owner = await db.query.users.findFirst({ where: eq(schema.users.id, ownerUserId) });
    ownerSlug = ownerSlugForUser(owner ?? null, ownerUserId);

    await createSpace(SPACE, ownerUserId, "private", "t");
    await setSpaceMemberRole(SPACE, memberUserId, "reader", "t");
  });

  afterAll(async () => {
    if (prevDataDir === undefined) delete process.env.DESK_DATA_DIR;
    else process.env.DESK_DATA_DIR = prevDataDir;
    await rm(dataDir, { recursive: true, force: true });
  });

  function repoPath(): string {
    return bareRepoPath(ownerSlug, SPACE);
  }

  // ── 4: owner/admin commit to main projects ──────────────────────────────────
  describe("owner-direct (assertion 4)", () => {
    beforeEach(async () => {
      await setSpacePushPolicy(SPACE, "direct", "t");
    });

    it("admin/owner creates a doc on main → 200, projects, git has the commit", async () => {
      const res = await POST(
        reqJson("POST", "admin", { title: "Hello World", content: "first body" }),
        ctx(),
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as { target: string; slug: string; newSha: string };
      expect(json.target).toBe("main");

      // git: main tip == returned sha.
      const tip = await refTip(repoPath(), "main");
      expect(tip).toBe(json.newSha);

      // projects: a docs row exists for the derived slug, in this space.
      const rows = await db
        .select()
        .from(schema.docs)
        .where(eq(schema.docs.slug, json.slug));
      expect(rows.length).toBe(1);
      expect(rows[0].title).toBe("Hello World");
    });
  });

  // ── 1: reader / non-member / anonymous → uniform 404, no ref moved ──────────
  describe("read-only / unauthenticated (assertion 1)", () => {
    beforeEach(async () => {
      await setSpacePushPolicy(SPACE, "direct", "t");
    });

    it("a READER write → 404, main tip unchanged", async () => {
      await setSpaceMemberRole(SPACE, await devMemberId(), "reader", "t");
      const before = await refTip(repoPath(), "main");
      const res = await POST(
        reqJson("POST", "member", { title: "Reader Doc", content: "nope" }),
        ctx(),
      );
      expect(res.status).toBe(404);
      expect(await refTip(repoPath(), "main")).toBe(before);
    });

    it("an ANONYMOUS write → 404, main tip unchanged", async () => {
      const before = await refTip(repoPath(), "main");
      const res = await POST(
        reqJson("POST", null, { title: "Anon Doc", content: "nope" }),
        ctx(),
      );
      expect(res.status).toBe(404);
      expect(await refTip(repoPath(), "main")).toBe(before);
    });

    it("a NON-MEMBER (unknown user) write → 404", async () => {
      // Remove the dev-member from the space → they are a non-member now.
      await setSpaceMemberRole(SPACE, await devMemberId(), null, "t");
      const before = await refTip(repoPath(), "main");
      const res = await POST(
        reqJson("POST", "member", { title: "Outsider", content: "nope" }),
        ctx(),
      );
      expect(res.status).toBe(404);
      expect(await refTip(repoPath(), "main")).toBe(before);
      // restore as reader for isolation
      await setSpaceMemberRole(SPACE, await devMemberId(), "reader", "t");
    });
  });

  // ── 2: writer under proposal policy → proposals/<handle>, main unchanged ────
  describe("writer under proposal policy (assertion 2)", () => {
    beforeEach(async () => {
      await setSpacePushPolicy(SPACE, "proposal", "t");
      await setSpaceMemberRole(SPACE, await devMemberId(), "writer", "t");
    });

    it("a WRITER's create lands on proposals/<handle>, main UNCHANGED", async () => {
      const mainBefore = await refTip(repoPath(), "main");
      const res = await POST(
        reqJson("POST", "member", { title: "Proposed Doc", content: "guest body" }),
        ctx(),
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as { target: string; ref: string; newSha: string };
      expect(json.target).toBe("proposal");
      expect(json.ref.startsWith("refs/heads/proposals/")).toBe(true);

      // The proposal ref now points at the commit.
      expect(await refTip(repoPath(), json.ref)).toBe(json.newSha);
      // main is untouched.
      expect(await refTip(repoPath(), "main")).toBe(mainBefore);
    });
  });

  // ── 3: CAS — two edits off the same baseCommit, second is stale ─────────────
  describe("CAS stale rejection (assertion 3)", () => {
    let editSlug: string;
    let baseCommit: string;

    beforeEach(async () => {
      await setSpacePushPolicy(SPACE, "direct", "t");
      // Seed a doc as owner to edit.
      const res = await POST(
        reqJson("POST", "admin", { title: "Edit Target", content: "v0" }),
        ctx(),
      );
      const j = (await res.json()) as { slug: string; newSha: string };
      editSlug = j.slug;
      baseCommit = j.newSha;
    });

    it("the SECOND edit off a stale base → 409, first edit not clobbered", async () => {
      const first = await PUT(
        reqJson("PUT", "admin", { slug: editSlug, content: "v1-first", baseCommit }),
        ctx(),
      );
      expect(first.status).toBe(200);
      const firstJson = (await first.json()) as { newSha: string };

      // Second edit still claims the ORIGINAL baseCommit → stale.
      const second = await PUT(
        reqJson("PUT", "admin", { slug: editSlug, content: "v1-second", baseCommit }),
        ctx(),
      );
      expect(second.status).toBe(409);

      // main tip is the FIRST edit (not clobbered).
      expect(await refTip(repoPath(), "main")).toBe(firstJson.newSha);
    });
  });

  async function devMemberId(): Promise<number> {
    return (await resolvePrincipalUserId({ kind: "member", name: "Dev Member" }))!;
  }
});
