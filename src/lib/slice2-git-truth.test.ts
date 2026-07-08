/**
 * Convergence fix-pass, Slice 2 — git-truth write convergence (findings 1 + 2).
 *
 * Proves that the retired-DB-write paths now funnel through a REAL git commit
 * (webAuthorCommit → commitFilesToRef) and that the projection is rebuilt from
 * git by the indexer — never a second DB write:
 *
 *   - MCP `publish_doc` (space + path) → commit on `main`, doc projects, AND the
 *     bytes are retrievable by a fresh `git clone` (truth = git, not just DB);
 *   - push_policy routing: a non-owner writer under `proposal` lands on a
 *     `proposals/*` ref, NOT `main` (no projection until accepted);
 *   - `acceptRevision` → the revision content is a real commit on `main` + the
 *     projection matches the clone;
 *   - CAS: a stale base is rejected as `stale`; accept reads the LIVE tip so it
 *     succeeds even when `main` moved past the revision's base;
 *   - `publish_doc` without `space` / `path` is rejected by the wire schema.
 *
 * Skipped when the host has no usable `git` (mirrors the e2e suites).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { z } from "zod";
import { resetDb, seedUser, seedSpaceMember } from "@/test/db";
import {
  HAVE_GIT,
  useTempDataDir,
  clearSpaceRepos,
  readFileFromClone,
} from "@/test/git";
import {
  createSpace,
  setSpacePushPolicy,
  ownerSlugForUser,
} from "@/lib/spaces";
import { bareRepoPath } from "@/lib/git/repo";
import { getDocBySlug } from "@/lib/docs";
import { createRevision, acceptRevision } from "@/lib/revisions";
import { webAuthorCommit } from "@/lib/web-author";
import { resolvePrincipalUserId } from "@/lib/principal-user";
import type { Principal } from "@/lib/auth";
import { TOOLS, type ToolDef } from "@/lib/mcp/tools";

const admin: Principal = { kind: "admin", name: "Admin" };
const member: Principal = { kind: "member", name: "Member" };

function tool(name: string): ToolDef {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}
async function run(name: string, principal: Principal, args: Record<string, unknown> = {}) {
  return tool(name).handler(principal, args as never);
}
function structured(res: Awaited<ReturnType<ToolDef["handler"]>>) {
  return res.structuredContent as Record<string, unknown>;
}

const SPACE = "proof";

describe.skipIf(!HAVE_GIT)("Slice 2 — git-truth write convergence", () => {
  let restore: () => Promise<void>;
  let ownerUserId: number;
  let ownerSlug: string;
  let spaceId: number;

  beforeAll(async () => {
    ({ restore } = await useTempDataDir());
  });
  afterAll(async () => {
    await restore();
  });

  beforeEach(async () => {
    await resetDb();
    await clearSpaceRepos();
    // Owner = a real admin user; the dev `admin` principal resolves to the
    // lowest-id admin (this row), and acts as `owner` on any space.
    ownerUserId = await seedUser({ tokenName: "lucas", displayName: "Lucas", role: "admin" });
    const created = await createSpace(SPACE, ownerUserId, "private", "t");
    if (!created.ok) throw new Error(created.error);
    spaceId = created.space.id;
    ownerSlug = ownerSlugForUser({ tokenName: "lucas", email: null }, ownerUserId);
  });

  const repoPath = () => bareRepoPath(ownerSlug, SPACE);

  // ── publish_doc (MCP) ──────────────────────────────────────────────────────
  describe("MCP publish_doc → main commit + projection + clone", () => {
    it("commits to main, projects the doc, and the bytes are in a fresh clone", async () => {
      const res = await run("publish_doc", admin, {
        space: SPACE,
        path: "reports/q1.md",
        title: "Q1 Report",
        content: "revenue up and to the right",
      });
      expect(res.isError).toBeFalsy();
      const out = structured(res);
      expect(out.target).toBe("main");
      expect(out.ref).toBe("refs/heads/main");
      expect(typeof out.slug).toBe("string");
      expect(out.url).toContain(`/docs/${out.slug}`);

      // Projection renders the doc from git.
      const doc = await getDocBySlug(out.slug as string, { includeUnpublished: true });
      expect(doc).not.toBeNull();
      expect(doc!.doc.spaceId).toBe(spaceId);
      expect(doc!.version!.content).toContain("revenue up and to the right");

      // A fresh clone retrieves the committed file — truth is in git.
      const cloned = await readFileFromClone(repoPath(), "reports/q1.md");
      expect(cloned).toContain("revenue up and to the right");
      expect(cloned).toContain("# Q1 Report"); // title prepended (md, no H1)
    });

    it("a raw (non-doc) path lands as a file but does not project a doc", async () => {
      const res = await run("publish_doc", admin, {
        space: SPACE,
        path: "assets/data.json",
        content: '{"k":1}',
      });
      expect(res.isError).toBeFalsy();
      const out = structured(res);
      expect(out.target).toBe("main");
      expect(out.slug).toBeNull(); // non-doc → no projection
      const cloned = await readFileFromClone(repoPath(), "assets/data.json");
      expect(cloned).toBe('{"k":1}');
    });

    it("rejects a bad space (uniform error, no existence leak)", async () => {
      const res = await run("publish_doc", admin, {
        space: "no-such-space",
        path: "a.md",
        content: "x",
      });
      expect(res.isError).toBe(true);
    });

    it("rejects an unsafe path", async () => {
      const res = await run("publish_doc", admin, {
        space: SPACE,
        path: "../escape.md",
        content: "x",
      });
      expect(res.isError).toBe(true);
    });
  });

  // ── wire schema: space + path are REQUIRED, audience is gone ────────────────
  describe("publish_doc wire schema", () => {
    const shape = () => z.object(tool("publish_doc").inputSchema);

    it("requires space", () => {
      expect(shape().safeParse({ path: "a.md", content: "x" }).success).toBe(false);
    });
    it("requires path", () => {
      expect(shape().safeParse({ space: SPACE, content: "x" }).success).toBe(false);
    });
    it("accepts space + path + content", () => {
      expect(shape().safeParse({ space: SPACE, path: "a.md", content: "x" }).success).toBe(true);
    });
    it("dropped the vestigial audience param", () => {
      expect("audience" in tool("publish_doc").inputSchema).toBe(false);
      expect("slug" in tool("publish_doc").inputSchema).toBe(false);
      expect("source_path" in tool("publish_doc").inputSchema).toBe(false);
    });
  });

  // ── push_policy routing (proposal mode) ─────────────────────────────────────
  describe("push_policy routing", () => {
    it("a non-owner writer under `proposal` lands on proposals/*, not main", async () => {
      // Establish main first (owner/admin write).
      await run("publish_doc", admin, { space: SPACE, path: "readme.md", content: "hello" });
      await setSpacePushPolicy(spaceId, "proposal", "t");

      // A member who is a WRITER of the space.
      const memberId = (await resolvePrincipalUserId(member))!;
      await seedSpaceMember(spaceId, memberId, "writer");

      const res = await run("publish_doc", member, {
        space: SPACE,
        path: "reports/draft.md",
        title: "Draft",
        content: "work in progress",
      });
      expect(res.isError).toBeFalsy();
      const out = structured(res);
      expect(out.target).toBe("proposal");
      expect(out.ref).toContain("refs/heads/proposals/");
      expect(out.slug).toBeNull(); // proposal isn't projected on main
      // main must NOT carry the proposed file.
      expect(await readFileFromClone(repoPath(), "reports/draft.md")).toBeNull();
      // main is intact.
      expect(await readFileFromClone(repoPath(), "readme.md")).toBe("hello");
    });

    it("the space owner still writes main directly under `proposal`", async () => {
      await run("publish_doc", admin, { space: SPACE, path: "readme.md", content: "hi" });
      await setSpacePushPolicy(spaceId, "proposal", "t");
      const res = await run("publish_doc", admin, {
        space: SPACE,
        path: "owner.md",
        content: "owner writes main",
      });
      expect(res.isError).toBeFalsy();
      expect(structured(res).target).toBe("main");
    });
  });

  // ── acceptRevision → git commit + projection ────────────────────────────────
  describe("acceptRevision commits to git", () => {
    it("accept publishes the revision content as a real commit on main", async () => {
      const pub = await run("publish_doc", admin, {
        space: SPACE,
        path: "os/guide.md",
        content: "# Guide\n\noriginal body\n",
      });
      const slug = structured(pub).slug as string;

      const rev = await createRevision({
        slug,
        authorName: "Alex",
        authorKind: "member",
        scope: { viewer: "admin" },
        content: "# Guide\n\nREVISED body\n",
      });
      expect(rev).not.toBeNull();

      const res = await acceptRevision(rev!.id, { by: "Owner" });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.isNewVersion).toBe(true);

      // Projection now matches the revision.
      const doc = await getDocBySlug(slug, { includeUnpublished: true });
      expect(doc!.version!.content).toBe("# Guide\n\nREVISED body\n");

      // The clone shows the committed revision content (truth = git).
      expect(await readFileFromClone(repoPath(), "os/guide.md")).toBe(
        "# Guide\n\nREVISED body\n",
      );

      // The revision row transitioned open → accepted (attribution retained).
      const { getRevision } = await import("@/lib/revisions");
      const persisted = await getRevision(rev!.id);
      expect(persisted!.status).toBe("accepted");
      expect(persisted!.authorName).toBe("Alex");
    });

    it("accept reads the LIVE tip → succeeds even after main moved past the base", async () => {
      const pub = await run("publish_doc", admin, {
        space: SPACE,
        path: "os/x.md",
        content: "# X\n\nv1\n",
      });
      const slug = structured(pub).slug as string;
      const rev = await createRevision({
        slug,
        authorName: "A",
        authorKind: "admin",
        scope: { viewer: "admin" },
        content: "# X\n\nrev\n",
      });
      // main moves: a sibling file is committed after the proposal is filed.
      await run("publish_doc", admin, { space: SPACE, path: "os/y.md", content: "sibling" });

      const res = await acceptRevision(rev!.id, { by: "Owner" });
      expect(res.ok).toBe(true);
      // x.md carries the revision; y.md was NOT clobbered (commit built on live tip).
      expect(await readFileFromClone(repoPath(), "os/x.md")).toBe("# X\n\nrev\n");
      expect(await readFileFromClone(repoPath(), "os/y.md")).toBe("sibling");
    });
  });

  // ── CAS: a stale base is rejected ───────────────────────────────────────────
  describe("CAS / stale", () => {
    it("webAuthorCommit rejects a stale base as `stale` (main moved under the caller)", async () => {
      await run("publish_doc", admin, { space: SPACE, path: "a.md", content: "one" });
      // main now has a tip; committing with baseMainTip=null asserts "main absent"
      // → the CAS loses → stale (never a silent overwrite).
      const result = await webAuthorCommit(spaceId, {
        role: "owner",
        identity: { name: "x", email: "x@x", handle: "x" },
        writes: [{ path: "b.md", bytes: Buffer.from("two", "utf8") }],
        baseMainTip: null,
        message: "stale attempt",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("stale");
      // b.md never landed on main.
      expect(await readFileFromClone(repoPath(), "b.md")).toBeNull();
    });
  });
});
