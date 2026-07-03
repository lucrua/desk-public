/**
 * Unit tests for the pure MCP tool registry (handlers in isolation, no
 * transport). Complements the route-level protocol tests in
 * src/app/api/mcp/mcp.test.ts — here we hit each handler directly with a
 * principal + args to pin down the authz matrix and the masking helper.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import {
  resetDb,
  seedAudiences,
  publishDocOk,
  seedDevMemberInDefaultSpace,
  seedSpace,
  seedUser,
} from "@/test/db";
import { HAVE_GIT, useTempDataDir, clearSpaceRepos } from "@/test/git";
import { getDocBySlug, getVersionContent } from "@/lib/docs";
import { listComments } from "@/lib/comments";
import type { Principal } from "@/lib/auth";
import { TOOLS, maskContact, type ToolDef } from "./tools";

// decide_revision accept commits to a real bare repo (truth = git). Isolate the
// whole file to a throwaway DESK_DATA_DIR + wipe repos per-test so the shared
// default `.desk-data` can't leak state across suites.
let __restoreDataDir: (() => Promise<void>) | undefined;
beforeAll(async () => {
  ({ restore: __restoreDataDir } = await useTempDataDir());
});
afterAll(async () => {
  if (__restoreDataDir) await __restoreDataDir();
});
beforeEach(async () => {
  await clearSpaceRepos();
});

const admin: Principal = { kind: "admin", name: "Admin", email: "admin@desk.test", tokenName: "ci" };
const member: Principal = { kind: "member", name: "Member" };
const anon: Principal = { kind: "anonymous" };

function tool(name: string): ToolDef {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

async function run(name: string, principal: Principal, args: Record<string, unknown> = {}) {
  // The route validates args against inputSchema before dispatch; here we call
  // handlers with already-shaped args.
  return tool(name).handler(principal, args as never);
}

describe("MCP tools — registry shape", () => {
  it("exposes exactly 43 uniquely-named tools, each with a description", () => {
    expect(TOOLS).toHaveLength(43);
    const names = new Set(TOOLS.map((t) => t.name));
    expect(names.size).toBe(43);
    for (const t of TOOLS) {
      expect(t.description.length).toBeGreaterThan(10);
      expect(typeof t.inputSchema).toBe("object");
    }
  });
});

describe("MCP tools — authz matrix", () => {
  beforeEach(async () => {
    await resetDb();
    await seedAudiences();
  });

  const staffTools = ["list_docs", "whoami"];
  const adminTools = [
    // publish_doc and decide_revision guards relaxed to admin || owner —
    // removed from this list (see doc-ownership.test.ts for their permission matrix).
    // user CRUD, access-request, and bucket-lifecycle tools were dropped from MCP
    // in the Slice-1.5 (D8) audit (REST-only now); update_doc (merged path+owner)
    // is admin-only and tested in tools-s1.test.ts + doc-ownership.test.ts.
    "unpublish_doc",
    "create_share",
    "list_shares",
    "revoke_share",
    "list_doc_shares",
    "resolve_comment",
    "delete_comment",
    "update_doc",
  ];

  it("staff-read tools reject anonymous with staff-only error", async () => {
    for (const name of [...staffTools, "get_doc", "get_version", "propose_revision", "list_revisions"]) {
      const r = await run(name, anon, { slug: "x", version_id: 1 });
      expect(r.isError).toBe(true);
      expect(r.structuredContent?.error).toMatch(/staff only/i);
    }
  });

  it("admin tools reject member with admin-only error", async () => {
    for (const name of adminTools) {
      const r = await run(name, member, {
        slug: "x",
        title: "X",
        source_path: "p",
        audience: "team",
        format: "md",
        content: "# x",
        doc_slug: "x",
        label: "l",
        id: 1,
        display_name: "X",
        member_visible: true,
        allow: true,
        key: "k",
      });
      expect(r.isError).toBe(true);
      expect(r.structuredContent?.error).toMatch(/admin only/i);
    }
  });

  it("staff-read tools succeed for member", async () => {
    for (const name of staffTools) {
      const r = await run(name, member, {});
      expect(r.isError).toBeFalsy();
    }
  });
});

describe("MCP tools — behaviour", () => {
  beforeEach(async () => {
    await resetDb();
    await seedAudiences();
    // Member reads docs in the default `workspace` space.
    await seedDevMemberInDefaultSpace();
  });

  it("get_doc returns content + versions for an existing doc (admin)", async () => {
    await publishDocOk({
      slug: "d1",
      title: "D1",
      sourcePath: "os/d1.md",
      audience: "team",
      format: "md",
      content: "# d1",
      by: "lucas",
    });
    const r = await run("get_doc", admin, { slug: "d1" });
    expect(r.isError).toBeFalsy();
    const sc = r.structuredContent as { doc: { slug: string }; currentVersion: { content: string }; versions: unknown[] };
    expect(sc.doc.slug).toBe("d1");
    expect(sc.currentVersion.content).toBe("# d1");
    expect(sc.versions).toHaveLength(1);
  });

  it("publish_doc rejects an unknown space (no existence leak)", async () => {
    const r = await run("publish_doc", admin, {
      space: "ghost-space",
      path: "os/n.md",
      content: "# n",
    });
    expect(r.isError).toBe(true);
  });

  it("publish_doc rejects oversized content (before any commit)", async () => {
    // `workspace` exists (seedDevMemberInDefaultSpace); the size cap is checked
    // after the space gate but before the git commit, so no repo is needed.
    const r = await run("publish_doc", admin, {
      space: "workspace",
      path: "os/big.md",
      content: "x".repeat(2_000_001),
    });
    expect(r.isError).toBe(true);
    expect(r.structuredContent?.error).toMatch(/too large/i);
  });

  it("add_comment + list_comments round-trip (staff, author from principal)", async () => {
    await publishDocOk({
      slug: "cdoc",
      title: "C",
      sourcePath: "os/c.md",
      audience: "team",
      format: "md",
      content: "# c",
      by: "lucas",
    });
    const added = await run("add_comment", member, { slug: "cdoc", body: "  hi there  " });
    expect(added.isError).toBeFalsy();
    const ac = added.structuredContent as { comment: { body: string; authorKind: string; authorName: string } };
    expect(ac.comment.body).toBe("hi there"); // trimmed
    expect(ac.comment.authorKind).toBe("member");
    expect(ac.comment.authorName).toBe("Member");

    const listed = await run("list_comments", admin, { slug: "cdoc" });
    const lc = listed.structuredContent as { comments: unknown[] };
    expect(lc.comments).toHaveLength(1);
  });

  it("add_comment rejects an oversize body", async () => {
    await publishDocOk({
      slug: "cdoc2", title: "C2", sourcePath: "os/c2.md", audience: "team", format: "md", content: "# c", by: "lucas",
    });
    const r = await run("add_comment", admin, { slug: "cdoc2", body: "x".repeat(10_001) });
    expect(r.isError).toBe(true);
    expect(r.structuredContent?.error).toMatch(/too long/i);
  });

  it("list_comments / add_comment 404 on an unknown slug (no existence leak)", async () => {
    const l = await run("list_comments", admin, { slug: "nope" });
    expect(l.isError).toBe(true);
    const a = await run("add_comment", admin, { slug: "nope", body: "x" });
    expect(a.isError).toBe(true);
  });

  it("member cannot comment on a doc in a space they're not in (scoped 404)", async () => {
    const owner = await seedUser({ email: "secret-owner@x.com", displayName: "Owner", role: "admin" });
    const secretSpace = await seedSpace({ slug: "secret-space", ownerId: owner, visibility: "private" });
    await publishDocOk({
      slug: "secret", title: "S", sourcePath: "os/s.md", format: "md", content: "# s", by: "lucas", spaceId: secretSpace,
    });
    const r = await run("add_comment", member, { slug: "secret", body: "x" });
    expect(r.isError).toBe(true);
    expect(r.structuredContent?.error).toMatch(/not found/i);
  });

  it("whoami masks email and tokenName", async () => {
    const r = await run("whoami", admin, {});
    const sc = r.structuredContent as { email: string; tokenName: string };
    expect(sc.email).not.toBe("admin@desk.test");
    expect(sc.email).toContain("@desk.test");
    expect(sc.email.startsWith("a")).toBe(true);
  });
});

// Per-share view-log (list_share_views) + comment-toggle (set_share_comments)
// were dropped from MCP in the Slice-1.5 (D8) audit — they are web-UI-only now
// (REST GET /api/shares/[id]/views, PATCH /api/shares/[id]). list_doc_shares
// stays (an agent audits the links on a doc it published).
describe("MCP tools — doc shares", () => {
  beforeEach(async () => {
    await resetDb();
    await seedAudiences();
  });

  async function publishAndShare(): Promise<number> {
    await publishDocOk({
      slug: "sdoc", title: "S", sourcePath: "os/s.md", audience: "team", format: "md", content: "# s", by: "lucas",
    });
    const created = await run("create_share", admin, { doc_slug: "sdoc", label: "Recipient" });
    return (created.structuredContent as { id: number }).id;
  }

  it("list_doc_shares lists shares for a doc; 404s an unknown slug", async () => {
    await publishAndShare();
    const r = await run("list_doc_shares", admin, { slug: "sdoc" });
    expect(r.isError).toBeFalsy();
    expect((r.structuredContent as { shares: unknown[] }).shares).toHaveLength(1);

    const missing = await run("list_doc_shares", admin, { slug: "nope" });
    expect(missing.isError).toBe(true);
    expect(missing.structuredContent?.error).toMatch(/not found/i);
  });
});

describe("MCP tools — update_doc (merged set_doc_path + set_doc_owner)", () => {
  beforeEach(async () => {
    await resetDb();
    await seedAudiences();
    await seedDevMemberInDefaultSpace();
  });

  it("moves a doc to a folder path (DB effect)", async () => {
    await publishDocOk({
      slug: "udoc", title: "U", sourcePath: "os/u.md", format: "md", content: "# u", by: "lucas",
    });
    const r = await run("update_doc", admin, { slug: "udoc", path: "os/sub" });
    expect(r.isError).toBeFalsy();
    expect((r.structuredContent as { path: string }).path).toBe("os/sub");
    const doc = await getDocBySlug("udoc", { includeUnpublished: true, scope: { viewer: "admin" } });
    expect(doc!.doc.path).toBe("os/sub");
  });

  it("reassigns the owner (DB effect)", async () => {
    await publishDocOk({
      slug: "udoc2", title: "U2", sourcePath: "os/u2.md", format: "md", content: "# u2", by: "lucas",
    });
    const newOwner = await seedUser({ email: "newowner@x.com", displayName: "New Owner", role: "member" });
    const r = await run("update_doc", admin, { slug: "udoc2", owner_user_id: newOwner });
    expect(r.isError).toBeFalsy();
    const doc = await getDocBySlug("udoc2", { includeUnpublished: true, scope: { viewer: "admin" } });
    expect(doc!.doc.ownerUserId).toBe(newOwner);
  });

  it("updates path AND owner in one call", async () => {
    await publishDocOk({
      slug: "udoc3", title: "U3", sourcePath: "os/u3.md", format: "md", content: "# u3", by: "lucas",
    });
    const newOwner = await seedUser({ email: "owner3@x.com", displayName: "Owner3", role: "member" });
    const r = await run("update_doc", admin, { slug: "udoc3", path: "reports", owner_user_id: newOwner });
    expect(r.isError).toBeFalsy();
    const doc = await getDocBySlug("udoc3", { includeUnpublished: true, scope: { viewer: "admin" } });
    expect(doc!.doc.path).toBe("reports");
    expect(doc!.doc.ownerUserId).toBe(newOwner);
  });

  it("rejects an empty update (no fields)", async () => {
    await publishDocOk({
      slug: "udoc4", title: "U4", sourcePath: "os/u4.md", format: "md", content: "# u4", by: "lucas",
    });
    const r = await run("update_doc", admin, { slug: "udoc4" });
    expect(r.isError).toBe(true);
    expect(r.structuredContent?.error).toMatch(/nothing to update/i);
  });

  it("404s an unknown slug", async () => {
    const r = await run("update_doc", admin, { slug: "nope", path: "os" });
    expect(r.isError).toBe(true);
    expect(r.structuredContent?.error).toMatch(/not found/i);
  });

  it("rejects an inactive / unknown owner_user_id", async () => {
    await publishDocOk({
      slug: "udoc5", title: "U5", sourcePath: "os/u5.md", format: "md", content: "# u5", by: "lucas",
    });
    const r = await run("update_doc", admin, { slug: "udoc5", owner_user_id: 99999 });
    expect(r.isError).toBe(true);
    expect(r.structuredContent?.error).toMatch(/does not exist or is inactive/i);
  });
});

describe("MCP tools — get_version", () => {
  beforeEach(async () => {
    await resetDb();
    await seedAudiences();
    // Member reads docs in the default `workspace` space.
    await seedDevMemberInDefaultSpace();
  });

  it("returns a version's content for an in-scope doc (staff)", async () => {
    const pub = await publishDocOk({
      slug: "vdoc", title: "V", sourcePath: "os/v.md", format: "md", content: "# v1", by: "lucas",
    });
    const r = await run("get_version", member, { slug: "vdoc", version_id: pub.versionId });
    expect(r.isError).toBeFalsy();
    expect((r.structuredContent as { content: string }).content).toBe("# v1");
  });

  it("404s a member on a doc in a space they're not in (scoped, no leak)", async () => {
    const owner = await seedUser({ email: "vsecret-owner@x.com", displayName: "Owner", role: "admin" });
    const secretSpace = await seedSpace({ slug: "vsecret-space", ownerId: owner, visibility: "private" });
    const pub = await publishDocOk({
      slug: "vsecret", title: "VS", sourcePath: "os/vs.md", format: "md", content: "# secret", by: "lucas", spaceId: secretSpace,
    });
    const r = await run("get_version", member, { slug: "vsecret", version_id: pub.versionId });
    expect(r.isError).toBe(true);
    expect(r.structuredContent?.error).toMatch(/not found/i);
  });

  it("404s a cross-doc version id (guarded by the service)", async () => {
    await publishDocOk({
      slug: "va", title: "VA", sourcePath: "os/va.md", audience: "team", format: "md", content: "# a", by: "lucas",
    });
    const pubB = await publishDocOk({
      slug: "vb", title: "VB", sourcePath: "os/vb.md", audience: "team", format: "md", content: "# b", by: "lucas",
    });
    // Ask doc va for vb's version id → not-found (no cross-doc leak).
    const r = await run("get_version", admin, { slug: "va", version_id: pubB.versionId });
    expect(r.isError).toBe(true);
    expect(r.structuredContent?.error).toMatch(/not found/i);
  });
});

describe("MCP tools — comment moderation", () => {
  beforeEach(async () => {
    await resetDb();
    await seedAudiences();
  });

  async function publishWithComment(): Promise<number> {
    await publishDocOk({
      slug: "mdoc", title: "M", sourcePath: "os/m.md", audience: "team", format: "md", content: "# m", by: "lucas",
    });
    const added = await run("add_comment", admin, { slug: "mdoc", body: "a comment" });
    return (added.structuredContent as { comment: { id: number } }).comment.id;
  }

  it("resolve_comment marks it resolved (DB effect)", async () => {
    const id = await publishWithComment();
    const r = await run("resolve_comment", admin, { id });
    expect(r.isError).toBeFalsy();
    const doc = await getDocBySlug("mdoc", { includeUnpublished: true, scope: { viewer: "admin" } });
    const open = await listComments(doc!.doc.id, { includeResolved: false });
    expect(open).toHaveLength(0);
  });

  it("delete_comment removes it (DB effect)", async () => {
    const id = await publishWithComment();
    const r = await run("delete_comment", admin, { id });
    expect(r.isError).toBeFalsy();
    const doc = await getDocBySlug("mdoc", { includeUnpublished: true, scope: { viewer: "admin" } });
    const all = await listComments(doc!.doc.id, { includeResolved: true });
    expect(all).toHaveLength(0);
  });

  it("resolve / delete 404 an unknown id", async () => {
    expect((await run("resolve_comment", admin, { id: 4242 })).isError).toBe(true);
    expect((await run("delete_comment", admin, { id: 4242 })).isError).toBe(true);
  });
});

describe("MCP tools — revisions behaviour", () => {
  beforeEach(async () => {
    await resetDb();
    await seedAudiences();
    // Member reads docs in the default `workspace` space.
    await seedDevMemberInDefaultSpace();
    await publishDocOk({
      slug: "rdoc", title: "R", sourcePath: "os/r.md", format: "md", content: "# r\n\norig\n", by: "lucas",
    });
    // rhidden lives in a SEPARATE private space the dev-member isn't in.
    const owner = await seedUser({ email: "rhidden-owner@x.com", displayName: "Owner", role: "admin" });
    const hiddenSpace = await seedSpace({ slug: "rhidden-space", ownerId: owner, visibility: "private" });
    await publishDocOk({
      slug: "rhidden", title: "RH", sourcePath: "os/rh.md", format: "md", content: "# rh", by: "lucas", spaceId: hiddenSpace,
    });
    await publishDocOk({
      slug: "rhtml", title: "RHTML", sourcePath: "os/rh.md", format: "html", content: "<p>x</p>", by: "lucas",
    });
  });

  it("propose_revision (member) creates an open revision; list_revisions shows it", async () => {
    const r = await run("propose_revision", member, { slug: "rdoc", content: "# r\n\nrevised\n", note: "tweak" });
    expect(r.isError).toBeFalsy();
    expect((r.structuredContent as { revision: { status: string } }).revision.status).toBe("open");

    const list = await run("list_revisions", member, { slug: "rdoc" });
    expect(list.isError).toBeFalsy();
    expect((list.structuredContent as { revisions: unknown[] }).revisions).toHaveLength(1);
  });

  it("propose_revision on an html doc → error", async () => {
    const r = await run("propose_revision", admin, { slug: "rhtml", content: "<p>y</p>" });
    expect(r.isError).toBe(true);
    expect(r.structuredContent?.error).toMatch(/markdown/i);
  });

  it("member propose_revision on a doc in a space they're not in → not-found (no leak)", async () => {
    const r = await run("propose_revision", member, { slug: "rhidden", content: "# changed" });
    expect(r.isError).toBe(true);
    expect(r.structuredContent?.error).toMatch(/not found/i);
  });

  it.skipIf(!HAVE_GIT)("decide_revision accept publishes a new version (admin, git commit)", async () => {
    const created = await run("propose_revision", member, { slug: "rdoc", content: "# r\n\nACCEPTED\n" });
    const id = (created.structuredContent as { revision: { id: number } }).revision.id;
    const r = await run("decide_revision", admin, { id, accept: true });
    expect(r.isError).toBeFalsy();
    const payload = r.structuredContent as { status: string; isNewVersion: boolean; staleBase: boolean };
    expect(payload.status).toBe("accepted");
    expect(payload.isNewVersion).toBe(true);
    expect(payload.staleBase).toBe(false);

    const cur = await getDocBySlug("rdoc", { includeUnpublished: true, scope: { viewer: "admin" } });
    const content = await getVersionContent("rdoc", cur!.version!.id);
    expect(content).toBe("# r\n\nACCEPTED\n");
  });

  it("decide_revision reject marks rejected; double-decide → error", async () => {
    const created = await run("propose_revision", admin, { slug: "rdoc", content: "# x" });
    const id = (created.structuredContent as { revision: { id: number } }).revision.id;
    const rej = await run("decide_revision", admin, { id, accept: false });
    expect(rej.isError).toBeFalsy();
    expect((rej.structuredContent as { status: string }).status).toBe("rejected");
    const again = await run("decide_revision", admin, { id, accept: true });
    expect(again.isError).toBe(true);
    expect(again.structuredContent?.error).toMatch(/already decided/i);
  });

  it("decide_revision on an unknown id → not-found error", async () => {
    expect((await run("decide_revision", admin, { id: 4242, accept: true })).isError).toBe(true);
  });
});

describe("maskContact", () => {
  it("masks an email keeping first char + domain", () => {
    expect(maskContact("pedro@example.net")).toBe("p****@example.net");
  });
  it("masks a token name keeping first + last", () => {
    expect(maskContact("ci-token")).toBe("c******n");
  });
  it("masks a 2-char value", () => {
    expect(maskContact("ab")).toBe("a*");
  });
  it("returns null for undefined", () => {
    expect(maskContact(undefined)).toBeNull();
  });
});
