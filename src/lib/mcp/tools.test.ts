/**
 * Unit tests for the pure MCP tool registry (handlers in isolation, no
 * transport). Complements the route-level protocol tests in
 * src/app/api/mcp/mcp.test.ts — here we hit each handler directly with a
 * principal + args to pin down the authz matrix and the masking helper.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { resetDb, seedAudiences, publishDocOk } from "@/test/db";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
import { getDocBySlug, getVersionContent } from "@/lib/docs";
import { getUserById } from "@/lib/users";
import { listAudiences } from "@/lib/audiences";
import { listShares, recordView } from "@/lib/shares";
import { listComments } from "@/lib/comments";
import type { Principal } from "@/lib/auth";
import { TOOLS, maskContact, type ToolDef } from "./tools";

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
  it("exposes exactly 63 uniquely-named tools, each with a description", () => {
    expect(TOOLS).toHaveLength(63);
    const names = new Set(TOOLS.map((t) => t.name));
    expect(names.size).toBe(63);
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

  const staffTools = ["list_docs", "list_audiences", "whoami"];
  const adminTools = [
    // publish_doc and decide_revision guards relaxed to admin || owner —
    // removed from this list (see doc-ownership.test.ts for their permission matrix).
    "unpublish_doc",
    "create_share",
    "list_shares",
    "revoke_share",
    // admin-management surface (MCP parity batch)
    "list_users",
    "create_user",
    "update_user",
    "list_user_emails",
    "add_user_email",
    "remove_user_email",
    "list_access_requests",
    "approve_access_request",
    "dismiss_access_request",
    "create_audience",
    "update_audience",
    "delete_audience",
    "set_share_comments",
    "list_share_views",
    "list_doc_shares",
    "resolve_comment",
    "delete_comment",
    "set_doc_owner",
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
  });

  it("get_doc returns content + versions for an existing doc (admin)", async () => {
    await publishDocOk({
      slug: "d1",
      title: "D1",
      sourcePath: "os/d1.md",
      audience: "team",
      format: "md",
      content: "# d1",
      by: "admin",
    });
    const r = await run("get_doc", admin, { slug: "d1" });
    expect(r.isError).toBeFalsy();
    const sc = r.structuredContent as { doc: { slug: string }; currentVersion: { content: string }; versions: unknown[] };
    expect(sc.doc.slug).toBe("d1");
    expect(sc.currentVersion.content).toBe("# d1");
    expect(sc.versions).toHaveLength(1);
  });

  it("publish_doc with no audience defaults to `private`", async () => {
    const r = await run("publish_doc", admin, {
      slug: "no-aud",
      title: "No Aud",
      source_path: "os/n.md",
      format: "md",
      content: "# n",
    });
    expect(r.isError).toBeFalsy();
    const doc = await getDocBySlug("no-aud");
    expect(doc!.doc.audience).toBe("private");
  });

  it("publish_doc rejects oversized content", async () => {
    const r = await run("publish_doc", admin, {
      slug: "big",
      title: "Big",
      source_path: "os/big.md",
      audience: "team",
      format: "md",
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
      by: "admin",
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
      slug: "cdoc2", title: "C2", sourcePath: "os/c2.md", audience: "team", format: "md", content: "# c", by: "admin",
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

  it("member cannot comment on a hidden-audience doc (scoped 404)", async () => {
    await publishDocOk({
      slug: "secret", title: "S", sourcePath: "os/s.md", audience: "alice", format: "md", content: "# s", by: "admin",
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

// ── admin-management surface (MCP parity batch) ──────────────────────────────

describe("MCP tools — user management", () => {
  beforeEach(async () => {
    await resetDb();
    await seedAudiences();
  });

  it("create_user → list_users round-trips (DB effect)", async () => {
    const created = await run("create_user", admin, {
      display_name: "Bob",
      email: "Bob@Example.COM",
    });
    expect(created.isError).toBeFalsy();
    const cu = created.structuredContent as { user: { id: number; email: string; role: string } };
    expect(cu.user.email).toBe("bob@example.com"); // normalized
    expect(cu.user.role).toBe("member");

    const listed = await run("list_users", admin, {});
    const lu = listed.structuredContent as { users: Array<{ id: number }> };
    expect(lu.users.some((u) => u.id === cu.user.id)).toBe(true);
  });

  it("create_user with no identifier returns an error result", async () => {
    const r = await run("create_user", admin, { display_name: "NoId" });
    expect(r.isError).toBe(true);
    expect(r.structuredContent?.error).toMatch(/at least one/i);
  });

  it("create_user with a duplicate email returns an error result", async () => {
    await run("create_user", admin, { display_name: "A", email: "dup@x.com" });
    const r = await run("create_user", admin, { display_name: "B", email: "dup@x.com" });
    expect(r.isError).toBe(true);
    expect(r.structuredContent?.error).toMatch(/already exists/i);
  });

  it("update_user changes the display name (DB effect)", async () => {
    const created = await run("create_user", admin, { display_name: "Old", email: "u@x.com" });
    const id = (created.structuredContent as { user: { id: number } }).user.id;
    const upd = await run("update_user", admin, { id, display_name: "New" });
    expect(upd.isError).toBeFalsy();

    const got = await getUserById(id);
    expect(got?.displayName).toBe("New");
  });

  it("update_user clears tokenName when passed explicit null", async () => {
    const created = await run("create_user", admin, {
      display_name: "T",
      token_name: "svc-token-1",
    });
    const id = (created.structuredContent as { user: { id: number } }).user.id;
    const upd = await run("update_user", admin, { id, token_name: null });
    expect(upd.isError).toBeFalsy();
    expect((await getUserById(id))?.tokenName).toBeNull();
  });

  it("update_user 404s an unknown id", async () => {
    const r = await run("update_user", admin, { id: 99999, display_name: "X" });
    expect(r.isError).toBe(true);
    expect(r.structuredContent?.error).toMatch(/not found/i);
  });

  it("update_user rejects self-deactivation (matched by email)", async () => {
    // The acting admin's email matches the target row → guard fires.
    const created = await run("create_user", admin, {
      display_name: "Me",
      email: "admin@desk.test",
    });
    const id = (created.structuredContent as { user: { id: number } }).user.id;
    const r = await run("update_user", admin, { id, active: false });
    expect(r.isError).toBe(true);
    expect(r.structuredContent?.error).toMatch(/can't deactivate yourself/i);
    // And the row stays active (no mutation happened).
    expect((await getUserById(id))?.active).toBe(1);
  });

  it("update_user allows deactivating a DIFFERENT user", async () => {
    const created = await run("create_user", admin, {
      display_name: "Other",
      email: "other@x.com",
    });
    const id = (created.structuredContent as { user: { id: number } }).user.id;
    const r = await run("update_user", admin, { id, active: false });
    expect(r.isError).toBeFalsy();
    expect((await getUserById(id))?.active).toBe(0);
  });

  // ── role promote/demote (multi-admin model v2) ─────────────────────────────

  it("update_user with role:'admin' promotes a member to admin", async () => {
    const created = await run("create_user", admin, { display_name: "Promo", email: "promo@x.com" });
    const id = (created.structuredContent as { user: { id: number } }).user.id;
    const r = await run("update_user", admin, { id, role: "admin" });
    expect(r.isError).toBeFalsy();
    expect((await getUserById(id))?.role).toBe("admin");
  });

  it("update_user with role:'member' demotes another admin when not last", async () => {
    // Need two admins: the acting principal (admin fixture) and a DB-row admin.
    // Since `admin` is a fixture principal (not a DB row), it won't trigger
    // the last-admin guard (guard counts DB rows).
    // Create two admin rows so DB-level count is 2.
    const u1 = await run("create_user", admin, { display_name: "A1", email: "a1@x.com" });
    const id1 = (u1.structuredContent as { user: { id: number } }).user.id;
    await db.update(schema.users).set({ role: "admin" }).where(eq(schema.users.id, id1));
    const u2 = await run("create_user", admin, { display_name: "A2", email: "a2@x.com" });
    const id2 = (u2.structuredContent as { user: { id: number } }).user.id;
    await db.update(schema.users).set({ role: "admin" }).where(eq(schema.users.id, id2));

    // Demote u1 — guard should allow it (2 admins).
    const r = await run("update_user", admin, { id: id1, role: "member" });
    expect(r.isError).toBeFalsy();
    expect((await getUserById(id1))?.role).toBe("member");
  });

  it("last-admin guard (MCP): demoting the only active admin → error result", async () => {
    const created = await run("create_user", admin, { display_name: "Solo", email: "solo@x.com" });
    const id = (created.structuredContent as { user: { id: number } }).user.id;
    await db.update(schema.users).set({ role: "admin" }).where(eq(schema.users.id, id));
    // Only 1 admin DB row.
    const r = await run("update_user", admin, { id, role: "member" });
    expect(r.isError).toBe(true);
    expect(r.structuredContent?.error).toMatch(/only active admin/i);
    expect((await getUserById(id))?.role).toBe("admin"); // unchanged
  });

  it("last-admin guard (MCP): deactivating the only active admin → error result", async () => {
    const created = await run("create_user", admin, { display_name: "Solo2", email: "solo2@x.com" });
    const id = (created.structuredContent as { user: { id: number } }).user.id;
    await db.update(schema.users).set({ role: "admin" }).where(eq(schema.users.id, id));
    const r = await run("update_user", admin, { id, active: false });
    expect(r.isError).toBe(true);
    expect(r.structuredContent?.error).toMatch(/only active admin/i);
    expect((await getUserById(id))?.active).toBe(1);
  });

  // ── privilege-escalation negatives ─────────────────────────────────────────

  it("member calling update_user with role:'admin' on another user → Forbidden", async () => {
    const created = await run("create_user", admin, { display_name: "X", email: "x@x.com" });
    const id = (created.structuredContent as { user: { id: number } }).user.id;
    const r = await run("update_user", member, { id, role: "admin" });
    expect(r.isError).toBe(true);
    expect(r.structuredContent?.error).toMatch(/admin only/i);
  });

  it("member calling update_user with role:'admin' on self → Forbidden", async () => {
    const created = await run("create_user", admin, { display_name: "Self", email: "self@x.com" });
    const id = (created.structuredContent as { user: { id: number } }).user.id;
    const r = await run("update_user", member, { id, role: "admin" });
    expect(r.isError).toBe(true);
    expect(r.structuredContent?.error).toMatch(/admin only/i);
  });

  it("anonymous calling update_user with role:'admin' → Forbidden", async () => {
    const created = await run("create_user", admin, { display_name: "Y", email: "y@x.com" });
    const id = (created.structuredContent as { user: { id: number } }).user.id;
    const r = await run("update_user", anon, { id, role: "admin" });
    expect(r.isError).toBe(true);
    expect(r.structuredContent?.error).toMatch(/admin only/i);
  });

  // ── multiple emails per user (add/remove/list) ─────────────────────────────

  async function newUser(email: string): Promise<number> {
    const created = await run("create_user", admin, { display_name: "U", email });
    return (created.structuredContent as { user: { id: number } }).user.id;
  }

  it("add_user_email → list_user_emails round-trips (normalized)", async () => {
    const id = await newUser("primary@x.com");
    const add = await run("add_user_email", admin, { id, email: "Alias@X.com" });
    expect(add.isError).toBeFalsy();
    const list = await run("list_user_emails", admin, { id });
    const sc = list.structuredContent as { emails: Array<{ email: string; primary: boolean }> };
    expect(sc.emails.map((e) => e.email).sort()).toEqual(["alias@x.com", "primary@x.com"]);
    expect(sc.emails.find((e) => e.email === "primary@x.com")!.primary).toBe(true);
  });

  it("add_user_email → duplicate error when the email is on another user", async () => {
    await newUser("taken@x.com");
    const id = await newUser("p@x.com");
    const r = await run("add_user_email", admin, { id, email: "taken@x.com" });
    expect(r.isError).toBe(true);
    expect(r.structuredContent?.error).toMatch(/already belongs/i);
  });

  it("add_user_email → not-found for an unknown id", async () => {
    const r = await run("add_user_email", admin, { id: 99999, email: "x@x.com" });
    expect(r.isError).toBe(true);
    expect(r.structuredContent?.error).toMatch(/not found/i);
  });

  it("remove_user_email → last-email guard for a token-less user", async () => {
    const id = await newUser("only@x.com");
    const r = await run("remove_user_email", admin, { id, email: "only@x.com" });
    expect(r.isError).toBe(true);
    expect(r.structuredContent?.error).toMatch(/last email/i);
  });

  it("remove_user_email → ok when the user keeps another email", async () => {
    const id = await newUser("primary@x.com");
    await run("add_user_email", admin, { id, email: "secondary@x.com" });
    const r = await run("remove_user_email", admin, { id, email: "primary@x.com" });
    expect(r.isError).toBeFalsy();
    const list = await run("list_user_emails", admin, { id });
    const sc = list.structuredContent as { emails: Array<{ email: string }> };
    expect(sc.emails.map((e) => e.email)).toEqual(["secondary@x.com"]);
  });

  it("list_user_emails → not-found for an unknown id", async () => {
    const r = await run("list_user_emails", admin, { id: 99999 });
    expect(r.isError).toBe(true);
    expect(r.structuredContent?.error).toMatch(/not found/i);
  });
});

describe("MCP tools — access requests", () => {
  beforeEach(async () => {
    await resetDb();
    await seedAudiences();
  });

  async function seedRequest(email: string): Promise<number> {
    const [row] = await db
      .insert(schema.accessRequests)
      .values({ email })
      .returning({ id: schema.accessRequests.id });
    return row.id;
  }

  it("list_access_requests returns pending rows", async () => {
    await seedRequest("pending@x.com");
    const r = await run("list_access_requests", admin, {});
    const sc = r.structuredContent as { accessRequests: Array<{ email: string }> };
    expect(sc.accessRequests.map((a) => a.email)).toContain("pending@x.com");
  });

  it("approve_access_request creates a user and clears the request (DB effect)", async () => {
    const id = await seedRequest("approve@x.com");
    const r = await run("approve_access_request", admin, { id });
    expect(r.isError).toBeFalsy();
    const userId = (r.structuredContent as { userId: number }).userId;
    expect((await getUserById(userId))?.email).toBe("approve@x.com");
    const remaining = await db.select().from(schema.accessRequests);
    expect(remaining).toHaveLength(0);
  });

  it("dismiss_access_request deletes the request (DB effect)", async () => {
    const id = await seedRequest("dismiss@x.com");
    const r = await run("dismiss_access_request", admin, { id });
    expect(r.isError).toBeFalsy();
    expect(await db.select().from(schema.accessRequests)).toHaveLength(0);
  });

  it("approve_access_request with alias_of_user_id adds the email to an existing user (no new user)", async () => {
    const created = await run("create_user", admin, { display_name: "Admin", email: "owner@example.com" });
    const targetId = (created.structuredContent as { user: { id: number } }).user.id;
    const id = await seedRequest("admin@example.com");
    const r = await run("approve_access_request", admin, { id, alias_of_user_id: targetId });
    expect(r.isError).toBeFalsy();
    expect((r.structuredContent as { userId: number }).userId).toBe(targetId);
    // No new user created — only the one we made.
    const listed = await run("list_users", admin, {});
    expect((listed.structuredContent as { users: unknown[] }).users).toHaveLength(1);
    // The email landed on the target.
    const emails = await run("list_user_emails", admin, { id: targetId });
    const sc = emails.structuredContent as { emails: Array<{ email: string }> };
    expect(sc.emails.map((e) => e.email)).toContain("admin@example.com");
  });

  it("approve_access_request with an unknown alias_of_user_id → error", async () => {
    const id = await seedRequest("orphan@x.com");
    const r = await run("approve_access_request", admin, { id, alias_of_user_id: 99999 });
    expect(r.isError).toBe(true);
    expect(r.structuredContent?.error).toMatch(/not found/i);
  });

  it("approve / dismiss 404 an unknown id", async () => {
    expect((await run("approve_access_request", admin, { id: 4242 })).isError).toBe(true);
    expect((await run("dismiss_access_request", admin, { id: 4242 })).isError).toBe(true);
  });
});

describe("MCP tools — audience management", () => {
  beforeEach(async () => {
    await resetDb();
    await seedAudiences();
  });

  it("create_audience adds a row (DB effect)", async () => {
    const r = await run("create_audience", admin, {
      key: "external",
      label: "External",
      member_visible: true,
    });
    expect(r.isError).toBeFalsy();
    const audiences = await listAudiences();
    expect(audiences.some((a) => a.key === "external" && a.memberVisible)).toBe(true);
  });

  it("create_audience rejects an invalid key", async () => {
    const r = await run("create_audience", admin, { key: "Bad Key", label: "X" });
    expect(r.isError).toBe(true);
    expect(r.structuredContent?.error).toMatch(/invalid key/i);
  });

  it("create_audience rejects a duplicate key", async () => {
    const r = await run("create_audience", admin, { key: "team", label: "Dup" });
    expect(r.isError).toBe(true);
    expect(r.structuredContent?.error).toMatch(/already exists/i);
  });

  it("update_audience toggles member visibility (DB effect)", async () => {
    const before = (await listAudiences()).find((a) => a.key === "alice")!;
    expect(before.memberVisible).toBe(false);
    const r = await run("update_audience", admin, { id: before.id, member_visible: true });
    expect(r.isError).toBeFalsy();
    const after = (await listAudiences()).find((a) => a.key === "alice")!;
    expect(after.memberVisible).toBe(true);
  });

  it("update_audience 404s an unknown id", async () => {
    const r = await run("update_audience", admin, { id: 9999, member_visible: true });
    expect(r.isError).toBe(true);
  });

  it("delete_audience removes an unused audience (DB effect)", async () => {
    const created = await run("create_audience", admin, { key: "temp", label: "Temp" });
    const id = (created.structuredContent as { audience: { id: number } }).audience.id;
    const r = await run("delete_audience", admin, { id });
    expect(r.isError).toBeFalsy();
    expect((await listAudiences()).some((a) => a.key === "temp")).toBe(false);
  });

  it("delete_audience refuses an in-use audience", async () => {
    await publishDocOk({
      slug: "ad", title: "AD", sourcePath: "os/ad.md", audience: "team", format: "md", content: "# ad", by: "admin",
    });
    const teamId = (await listAudiences()).find((a) => a.key === "team")!.id;
    const r = await run("delete_audience", admin, { id: teamId });
    expect(r.isError).toBe(true);
    expect(r.structuredContent?.error).toMatch(/in use/i);
  });
});

describe("MCP tools — share management + views", () => {
  beforeEach(async () => {
    await resetDb();
    await seedAudiences();
  });

  async function publishAndShare(): Promise<number> {
    await publishDocOk({
      slug: "sdoc", title: "S", sourcePath: "os/s.md", audience: "team", format: "md", content: "# s", by: "admin",
    });
    const created = await run("create_share", admin, { doc_slug: "sdoc", label: "Recipient" });
    return (created.structuredContent as { id: number }).id;
  }

  it("set_share_comments toggles the flag (DB effect)", async () => {
    const shareId = await publishAndShare();
    const r = await run("set_share_comments", admin, { id: shareId, allow: true });
    expect(r.isError).toBeFalsy();
    const share = (await listShares()).find((s) => s.id === shareId)!;
    expect(share.allowComments).toBe(true);
  });

  it("set_share_comments 404s an unknown id", async () => {
    const r = await run("set_share_comments", admin, { id: 7777, allow: true });
    expect(r.isError).toBe(true);
  });

  it("list_share_views returns the view log shape (uaLabel etc.)", async () => {
    const shareId = await publishAndShare();
    const share = (await listShares()).find((s) => s.id === shareId)!;
    // Record a view directly so there's something to list.
    const doc = await getDocBySlug("sdoc", { includeUnpublished: true, scope: { viewer: "admin" } });
    await recordView(shareId, doc!.version!.id, "1.2.3.4", "curl/8.0");
    const r = await run("list_share_views", admin, { id: shareId });
    expect(r.isError).toBeFalsy();
    const views = (r.structuredContent as { views: Array<{ uaLabel: string; ip: string }> }).views;
    expect(views).toHaveLength(1);
    expect(views[0].uaLabel).toBe("agent/script");
    expect(views[0].ip).toBe("1.2.3.4");
    expect(share.viewCount).toBe(0); // sanity: the list was computed before the view
  });

  it("list_share_views returns [] for an unknown id (no existence signal)", async () => {
    const r = await run("list_share_views", admin, { id: 9999 });
    expect(r.isError).toBeFalsy();
    expect((r.structuredContent as { views: unknown[] }).views).toHaveLength(0);
  });

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

describe("MCP tools — get_version", () => {
  beforeEach(async () => {
    await resetDb();
    await seedAudiences();
  });

  it("returns a version's content for an in-scope doc (staff)", async () => {
    const pub = await publishDocOk({
      slug: "vdoc", title: "V", sourcePath: "os/v.md", audience: "team", format: "md", content: "# v1", by: "admin",
    });
    const r = await run("get_version", member, { slug: "vdoc", version_id: pub.versionId });
    expect(r.isError).toBeFalsy();
    expect((r.structuredContent as { content: string }).content).toBe("# v1");
  });

  it("404s a member on a hidden-audience doc (scoped, no leak)", async () => {
    const pub = await publishDocOk({
      slug: "vsecret", title: "VS", sourcePath: "os/vs.md", audience: "alice", format: "md", content: "# secret", by: "admin",
    });
    const r = await run("get_version", member, { slug: "vsecret", version_id: pub.versionId });
    expect(r.isError).toBe(true);
    expect(r.structuredContent?.error).toMatch(/not found/i);
  });

  it("404s a cross-doc version id (guarded by the service)", async () => {
    await publishDocOk({
      slug: "va", title: "VA", sourcePath: "os/va.md", audience: "team", format: "md", content: "# a", by: "admin",
    });
    const pubB = await publishDocOk({
      slug: "vb", title: "VB", sourcePath: "os/vb.md", audience: "team", format: "md", content: "# b", by: "admin",
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
      slug: "mdoc", title: "M", sourcePath: "os/m.md", audience: "team", format: "md", content: "# m", by: "admin",
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
    await publishDocOk({
      slug: "rdoc", title: "R", sourcePath: "os/r.md", audience: "team", format: "md", content: "# r\n\norig\n", by: "admin",
    });
    await publishDocOk({
      slug: "rhidden", title: "RH", sourcePath: "os/rh.md", audience: "alice", format: "md", content: "# rh", by: "admin",
    });
    await publishDocOk({
      slug: "rhtml", title: "RHTML", sourcePath: "os/rh.md", audience: "team", format: "html", content: "<p>x</p>", by: "admin",
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

  it("member propose_revision on a hidden-audience doc → not-found (no leak)", async () => {
    const r = await run("propose_revision", member, { slug: "rhidden", content: "# changed" });
    expect(r.isError).toBe(true);
    expect(r.structuredContent?.error).toMatch(/not found/i);
  });

  it("decide_revision accept publishes a new version (admin)", async () => {
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
    expect(maskContact("alice@example.com")).toBe("a****@example.com");
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
