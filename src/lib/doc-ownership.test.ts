/**
 * Permission matrix tests for doc ownership + direct publish + approval queue.
 *
 * The publish-permission boundary is the whole point here — be exhaustive.
 * Tests cover:
 *   - Schema: migration 0014 column + owner set on create / null on existing
 *   - canPublishVersion logic
 *   - canDecideRevision logic
 *   - publishDoc: sets owner on create, keeps owner on update
 *   - setDocOwner: admin only, validates target user, emits event
 *   - listOpenRevisions: admin sees all, owner sees own, plain member → empty
 *   - REST POST /api/docs/[slug]/publish: owner succeeds, member-non-owner forbidden, anonymous forbidden
 *   - REST POST /api/docs (create): admin only
 *   - REST PUT /api/docs/[slug]/owner: admin only
 *   - REST GET /api/revisions?status=open: admin all / owner own / member empty
 *   - REST POST /api/revisions/[id]/accept|reject: guard relaxed to admin || owner
 *   - MCP publish_doc: create = admin, update = owner or admin
 *   - MCP decide_revision: admin || owner
 *   - MCP set_doc_owner + list_open_revisions
 */
import { describe, it, expect, beforeEach } from "vitest";
import { resetDb, seedAudiences, publishDocOk, seedUser, seedDevMemberInDefaultSpace } from "@/test/db";
import { resolvePrincipalUserId } from "@/lib/principal-user";
import { db } from "@/db";
import { docs, revisions } from "@/db/schema";
import { eq, isNull } from "drizzle-orm";
import { publishDoc, getDocBySlug, setDocOwner } from "@/lib/docs";
import { createRevision, listRevisions, listOpenRevisions } from "@/lib/revisions";
import { canPublishVersion, canDecideRevision, canSetOwner, canSeeApprovalQueueItem } from "@/lib/permissions";
import type { Principal } from "@/lib/auth";
import { TOOLS } from "@/lib/mcp/tools";
import { NextRequest } from "next/server";
import { POST as publishRoute } from "@/app/api/docs/[slug]/publish/route";
import { PUT as ownerRoute } from "@/app/api/docs/[slug]/owner/route";
import { GET as revisionsQueueRoute } from "@/app/api/revisions/route";
import { POST as acceptRoute } from "@/app/api/revisions/[id]/accept/route";
import { POST as rejectRoute } from "@/app/api/revisions/[id]/reject/route";
import { POST as createDocRoute } from "@/app/api/docs/route";

// ─── Test principals ─────────────────────────────────────────────────────────

const adminPrincipal = (userId: number): Principal => ({
  kind: "admin",
  name: "Admin",
  email: "admin@example.com",
  userId,
});

const memberPrincipal = (userId: number): Principal => ({
  kind: "member",
  name: "Member",
  email: "member@example.com",
  userId,
});

const memberNoUserId = (): Principal => ({
  kind: "member",
  name: "Dev Member",
  // No userId — dev-mode stub
});

const anonymous = (): Principal => ({ kind: "anonymous" });

// Gen-2: a member proposing a revision must be able to SEE the doc's space.
// Docs published with no spaceId land in the default `workspace` space; this
// helper makes the dev member a reader of it and returns the member scope to
// pass to createRevision, so member proposals on workspace docs succeed.
async function memberSeesWorkspaceScope(): Promise<{ viewer: "member"; userId: number }> {
  await seedDevMemberInDefaultSpace();
  const memberId = await resolvePrincipalUserId({ kind: "member", name: "Dev Member" });
  return { viewer: "member", userId: memberId! };
}

// ─── Route helpers ──────────────────────────────────────────────────────────

function fakeRequest(
  method: string,
  url: string,
  body?: unknown,
  role?: "admin" | "member" | "anon",
): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (role === "admin") headers.set("x-dev-role", "admin");
  else if (role === "member") headers.set("x-dev-role", "member");
  // anon: no header
  return new Request(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

// ─── Fixtures ──────────────────────────────────────────────────────────────

async function seedOwnerDoc(ownerUserId: number) {
  return publishDoc({
    slug: "owned-doc",
    title: "Owned Doc",
    sourcePath: "test/owned.md",
    audience: "team",
    format: "md",
    content: "# Owned\n\noriginal",
    by: "owner",
    ownerUserId,
  });
}

async function getDocRow(slug: string) {
  const [row] = await db.select().from(docs).where(eq(docs.slug, slug)).limit(1);
  return row ?? null;
}

// ─── Unit: canPublishVersion ─────────────────────────────────────────────────

describe("canPublishVersion", () => {
  it("admin returns true regardless of ownerUserId", () => {
    const p = adminPrincipal(1);
    expect(canPublishVersion(p, { ownerUserId: 99 })).toBe(true);
    expect(canPublishVersion(p, { ownerUserId: null })).toBe(true);
  });

  it("member with matching userId returns true", () => {
    const p = memberPrincipal(5);
    expect(canPublishVersion(p, { ownerUserId: 5 })).toBe(true);
  });

  it("member with non-matching userId returns false", () => {
    const p = memberPrincipal(5);
    expect(canPublishVersion(p, { ownerUserId: 6 })).toBe(false);
  });

  it("member with null ownerUserId (legacy doc) returns false", () => {
    const p = memberPrincipal(5);
    expect(canPublishVersion(p, { ownerUserId: null })).toBe(false);
  });

  it("member with undefined userId (dev mode) returns false", () => {
    const p = memberNoUserId();
    expect(canPublishVersion(p, { ownerUserId: 5 })).toBe(false);
  });

  it("anonymous returns false", () => {
    expect(canPublishVersion(anonymous(), { ownerUserId: 5 })).toBe(false);
  });
});

describe("canDecideRevision", () => {
  it("admin returns true", () => {
    expect(canDecideRevision(adminPrincipal(1), { ownerUserId: 99 })).toBe(true);
  });

  it("owner returns true", () => {
    expect(canDecideRevision(memberPrincipal(7), { ownerUserId: 7 })).toBe(true);
  });

  it("non-owner member returns false", () => {
    expect(canDecideRevision(memberPrincipal(7), { ownerUserId: 8 })).toBe(false);
  });
});

describe("canSetOwner", () => {
  it("admin returns true", () => {
    expect(canSetOwner(adminPrincipal(1))).toBe(true);
  });

  it("member returns false", () => {
    expect(canSetOwner(memberPrincipal(1))).toBe(false);
  });
});

describe("canSeeApprovalQueueItem", () => {
  it("admin sees all", () => {
    expect(canSeeApprovalQueueItem(adminPrincipal(1), { ownerUserId: 99 })).toBe(true);
    expect(canSeeApprovalQueueItem(adminPrincipal(1), { ownerUserId: null })).toBe(true);
  });

  it("owner sees own", () => {
    expect(canSeeApprovalQueueItem(memberPrincipal(5), { ownerUserId: 5 })).toBe(true);
  });

  it("non-owner member sees nothing", () => {
    expect(canSeeApprovalQueueItem(memberPrincipal(5), { ownerUserId: 6 })).toBe(false);
  });
});

// ─── Service: publishDoc ownership ──────────────────────────────────────────

describe("publishDoc — ownership", () => {
  beforeEach(async () => {
    await resetDb();
    await seedAudiences();
  });

  it("creates a doc with ownerUserId set to creator", async () => {
    const adminId = await seedUser({ email: "a@test.com", displayName: "Admin", role: "admin" });
    const result = await publishDoc({
      slug: "new-doc",
      title: "New Doc",
      sourcePath: "t.md",
      audience: "team",
      format: "md",
      content: "hello",
      by: "Admin",
      ownerUserId: adminId,
    });
    if (!result.ok) throw new Error("publishDoc failed");
    expect(result.ownerUserId).toBe(adminId);
    const row = await getDocRow("new-doc");
    expect(row?.ownerUserId).toBe(adminId);
  });

  it("existing docs (no ownerUserId passed) stay null", async () => {
    // Publish without ownerUserId
    await publishDocOk({
      slug: "legacy-doc",
      title: "Legacy",
      sourcePath: "t.md",
      audience: "team",
      format: "md",
      content: "original",
      by: "system",
    });
    const row = await getDocRow("legacy-doc");
    expect(row?.ownerUserId).toBeNull();
  });

  it("update does NOT change owner_user_id (immutable)", async () => {
    const adminId = await seedUser({ email: "b@test.com", displayName: "Admin2", role: "admin" });
    const otherId = await seedUser({ email: "c@test.com", displayName: "Other", role: "member" });

    // Create with adminId as owner
    await publishDoc({
      slug: "stable-owner-doc",
      title: "Doc",
      sourcePath: "t.md",
      audience: "team",
      format: "md",
      content: "v1",
      by: "Admin2",
      ownerUserId: adminId,
    });

    // Update with otherId — owner must NOT change
    const r2 = await publishDoc({
      slug: "stable-owner-doc",
      title: "Doc v2",
      sourcePath: "t.md",
      audience: "team",
      format: "md",
      content: "v2 updated",
      by: "Other",
      ownerUserId: otherId, // ignored on update
    });
    if (!r2.ok) throw new Error("publishDoc failed");
    // ownerUserId in result is from the DB — should still be adminId
    expect(r2.ownerUserId).toBe(adminId);
    const row = await getDocRow("stable-owner-doc");
    expect(row?.ownerUserId).toBe(adminId);
  });
});

// ─── Service: setDocOwner ───────────────────────────────────────────────────

describe("setDocOwner", () => {
  beforeEach(async () => {
    await resetDb();
    await seedAudiences();
  });

  it("admin reassigns owner, emits doc.owner_changed event", async () => {
    const adminId = await seedUser({ email: "adm@test.com", displayName: "Admin", role: "admin" });
    const memberId = await seedUser({ email: "m@test.com", displayName: "Mem", role: "member" });

    await publishDocOk({
      slug: "reassign-doc",
      title: "Doc",
      sourcePath: "t.md",
      audience: "team",
      format: "md",
      content: "hi",
      by: "Admin",
      ownerUserId: adminId,
    });

    const result = await setDocOwner("reassign-doc", memberId, "Admin");
    expect(result).toBe("ok");

    const row = await getDocRow("reassign-doc");
    expect(row?.ownerUserId).toBe(memberId);
  });

  it("returns not-found for unknown slug", async () => {
    const adminId = await seedUser({ email: "adm2@test.com", displayName: "Admin2", role: "admin" });
    const result = await setDocOwner("no-such-doc", adminId, "Admin2");
    expect(result).toBe("not-found");
  });

  it("returns invalid-user for unknown user", async () => {
    await seedAudiences();
    await publishDocOk({
      slug: "owner-check-doc",
      title: "Doc",
      sourcePath: "t.md",
      audience: "team",
      format: "md",
      content: "hi",
      by: "system",
    });
    const result = await setDocOwner("owner-check-doc", 99999, "Admin");
    expect(result).toBe("invalid-user");
  });

  it("returns invalid-user for inactive user", async () => {
    const inactiveId = await seedUser({
      email: "inactive@test.com",
      displayName: "Inactive",
      role: "member",
      active: 0,
    });
    await publishDocOk({
      slug: "inactive-target-doc",
      title: "Doc",
      sourcePath: "t.md",
      audience: "team",
      format: "md",
      content: "hi",
      by: "system",
    });
    const result = await setDocOwner("inactive-target-doc", inactiveId, "Admin");
    expect(result).toBe("invalid-user");
  });
});

// ─── Service: listOpenRevisions ─────────────────────────────────────────────

describe("listOpenRevisions", () => {
  let adminId: number;
  let ownerId: number;
  let memberId: number;
  // Member scope that can SEE the default-workspace docs (so proposals land).
  let proposerScope: { viewer: "member"; userId: number };

  beforeEach(async () => {
    await resetDb();
    proposerScope = await memberSeesWorkspaceScope();
    adminId = await seedUser({ email: "adm@t.com", displayName: "Admin", role: "admin" });
    ownerId = await seedUser({ email: "owner@t.com", displayName: "Owner", role: "member" });
    memberId = await seedUser({ email: "plain@t.com", displayName: "Plain", role: "member" });
  });

  it("returns all open revisions for admin (no filter)", async () => {
    // Create two docs with different owners
    await publishDocOk({ slug: "doc-a", title: "A", sourcePath: "a.md", format: "md", content: "v1", by: "Owner", ownerUserId: ownerId });
    await publishDocOk({ slug: "doc-b", title: "B", sourcePath: "b.md", format: "md", content: "v1", by: "Admin", ownerUserId: adminId });

    // Propose revision on each
    await createRevision({ slug: "doc-a", authorName: "Plain", authorKind: "member", scope: proposerScope, content: "proposed a" });
    await createRevision({ slug: "doc-b", authorName: "Plain", authorKind: "member", scope: proposerScope, content: "proposed b" });

    const all = await listOpenRevisions();
    expect(all.length).toBe(2);
    expect(all.every((r) => r.status === "open")).toBe(true);
    expect(all.map((r) => r.docSlug).sort()).toEqual(["doc-a", "doc-b"]);
  });

  it("returns only own-doc revisions for owner", async () => {
    await publishDocOk({ slug: "doc-c", title: "C", sourcePath: "c.md", format: "md", content: "v1", by: "Owner", ownerUserId: ownerId });
    await publishDocOk({ slug: "doc-d", title: "D", sourcePath: "d.md", format: "md", content: "v1", by: "Admin", ownerUserId: adminId });

    await createRevision({ slug: "doc-c", authorName: "Plain", authorKind: "member", scope: proposerScope, content: "proposed c" });
    await createRevision({ slug: "doc-d", authorName: "Plain", authorKind: "member", scope: proposerScope, content: "proposed d" });

    const ownerView = await listOpenRevisions({ ownerUserId: ownerId });
    expect(ownerView.length).toBe(1);
    expect(ownerView[0].docSlug).toBe("doc-c");
  });

  it("returns empty for a member who owns no docs", async () => {
    await publishDocOk({ slug: "doc-e", title: "E", sourcePath: "e.md", format: "md", content: "v1", by: "Admin", ownerUserId: adminId });
    await createRevision({ slug: "doc-e", authorName: "Plain", authorKind: "member", scope: proposerScope, content: "proposed e" });

    const none = await listOpenRevisions({ ownerUserId: memberId });
    expect(none).toHaveLength(0);
  });
});

// ─── REST: POST /api/docs/[slug]/publish ────────────────────────────────────

describe("REST POST /api/docs/[slug]/publish — permission matrix", () => {
  let ownerId: number;
  let nonOwnerId: number;

  beforeEach(async () => {
    await resetDb();
    await seedAudiences();
    ownerId = await seedUser({ email: "owner@test.com", displayName: "Owner", role: "member" });
    nonOwnerId = await seedUser({ email: "nonowner@test.com", displayName: "NonOwner", role: "member" });
  });

  async function setupDoc(ownerUserId?: number) {
    // Use admin user for creation
    await seedUser({ email: "admin@test.com", displayName: "Admin", role: "admin" });
    await publishDocOk({
      slug: "pub-test-doc",
      title: "Pub Test",
      sourcePath: "t.md",
      audience: "team",
      format: "md",
      content: "# Original",
      by: "Admin",
      ownerUserId,
    });
  }

  it("anonymous → 403", async () => {
    await setupDoc(ownerId);
    const req = fakeRequest("POST", "http://localhost/api/docs/pub-test-doc/publish", { content: "new" }, "anon");
    const res = await publishRoute(req, { params: Promise.resolve({ slug: "pub-test-doc" }) });
    expect(res.status).toBe(403);
  });

  it("member who is NOT the owner → 403 (forged /publish attempt)", async () => {
    await setupDoc(ownerId);
    // nonOwnerId is a member but NOT the owner — must be rejected
    const req = fakeRequest("POST", "http://localhost/api/docs/pub-test-doc/publish", { content: "forged" }, "member");
    const res = await publishRoute(req, { params: Promise.resolve({ slug: "pub-test-doc" }) });
    // In dev mode, x-dev-role=member maps to a dev principal with no userId
    // so this tests the "member without userId → forbidden" path
    expect(res.status).toBe(403);
  });

  it("admin → 200 and creates new version", async () => {
    await setupDoc(ownerId);
    const req = fakeRequest("POST", "http://localhost/api/docs/pub-test-doc/publish", { content: "admin updated" }, "admin");
    const res = await publishRoute(req, { params: Promise.resolve({ slug: "pub-test-doc" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.versionId).toBeTypeOf("number");
  });

  it("doc does not exist → 403 (no existence signal)", async () => {
    const req = fakeRequest("POST", "http://localhost/api/docs/no-such-doc/publish", { content: "x" }, "admin");
    const res = await publishRoute(req, { params: Promise.resolve({ slug: "no-such-doc" }) });
    expect(res.status).toBe(403);
  });

  it("missing content → 400", async () => {
    await setupDoc(ownerId);
    const req = fakeRequest("POST", "http://localhost/api/docs/pub-test-doc/publish", {}, "admin");
    const res = await publishRoute(req, { params: Promise.resolve({ slug: "pub-test-doc" }) });
    expect(res.status).toBe(400);
  });

  it("admin publishes → no revision row created (direct publish path)", async () => {
    await setupDoc(ownerId);
    const before = await listRevisions((await getDocRow("pub-test-doc"))!.id);

    const req = fakeRequest("POST", "http://localhost/api/docs/pub-test-doc/publish", { content: "direct v2" }, "admin");
    const res = await publishRoute(req, { params: Promise.resolve({ slug: "pub-test-doc" }) });
    expect(res.status).toBe(200);

    const after = await listRevisions((await getDocRow("pub-test-doc"))!.id);
    // No new revision row created
    expect(after.length).toBe(before.length);
  });
});

// ─── REST: POST /api/docs (create) — admin only ──────────────────────────────

describe("REST POST /api/docs — create is admin only", () => {
  beforeEach(async () => {
    await resetDb();
    await seedAudiences();
  });

  it("member POSTing a new slug → 403", async () => {
    const req = fakeRequest("POST", "http://localhost/api/docs", {
      slug: "brand-new-doc",
      title: "Brand New",
      sourcePath: "t.md",
      audience: "team",
      format: "md",
      content: "hi",
    }, "member");
    const res = await createDocRoute(req);
    expect(res.status).toBe(403);
  });

  it("admin POSTing new slug → 200", async () => {
    const req = fakeRequest("POST", "http://localhost/api/docs", {
      slug: "admin-create-doc",
      title: "Admin Create",
      sourcePath: "t.md",
      audience: "team",
      format: "md",
      content: "hi",
    }, "admin");
    const res = await createDocRoute(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.slug).toBe("admin-create-doc");
  });
});

// ─── REST: PUT /api/docs/[slug]/owner — admin only ──────────────────────────

describe("REST PUT /api/docs/[slug]/owner", () => {
  let targetUserId: number;

  beforeEach(async () => {
    await resetDb();
    await seedAudiences();
    targetUserId = await seedUser({ email: "target@test.com", displayName: "Target", role: "member" });
    await publishDocOk({ slug: "owner-route-doc", title: "Doc", sourcePath: "t.md", audience: "team", format: "md", content: "hi", by: "Admin" });
  });

  it("admin → 200, updates owner", async () => {
    const req = fakeRequest("PUT", "http://localhost/api/docs/owner-route-doc/owner", { ownerUserId: targetUserId }, "admin");
    const res = await ownerRoute(req, { params: Promise.resolve({ slug: "owner-route-doc" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ownerUserId).toBe(targetUserId);
  });

  it("member → 403", async () => {
    const req = fakeRequest("PUT", "http://localhost/api/docs/owner-route-doc/owner", { ownerUserId: targetUserId }, "member");
    const res = await ownerRoute(req, { params: Promise.resolve({ slug: "owner-route-doc" }) });
    expect(res.status).toBe(403);
  });

  it("unknown user → 400", async () => {
    const req = fakeRequest("PUT", "http://localhost/api/docs/owner-route-doc/owner", { ownerUserId: 99999 }, "admin");
    const res = await ownerRoute(req, { params: Promise.resolve({ slug: "owner-route-doc" }) });
    expect(res.status).toBe(400);
  });

  it("unknown slug → 404", async () => {
    const req = fakeRequest("PUT", "http://localhost/api/docs/no-doc/owner", { ownerUserId: targetUserId }, "admin");
    const res = await ownerRoute(req, { params: Promise.resolve({ slug: "no-doc" }) });
    expect(res.status).toBe(404);
  });
});

// ─── REST: GET /api/revisions?status=open ───────────────────────────────────

describe("REST GET /api/revisions?status=open", () => {
  beforeEach(async () => {
    await resetDb();
    const proposerScope = await memberSeesWorkspaceScope();
    // Create a doc with a revision
    await publishDocOk({ slug: "queue-doc", title: "Queue Doc", sourcePath: "t.md", format: "md", content: "v1", by: "Admin" });
    await createRevision({ slug: "queue-doc", authorName: "Plain", authorKind: "member", scope: proposerScope, content: "proposed" });
  });

  it("admin → 200 with all revisions", async () => {
    const req = fakeRequest("GET", "http://localhost/api/revisions?status=open", undefined, "admin");
    const res = await revisionsQueueRoute(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.revisions)).toBe(true);
    expect(body.revisions.length).toBeGreaterThanOrEqual(1);
  });

  it("member (no owned docs, dev mode) → 403", async () => {
    const req = fakeRequest("GET", "http://localhost/api/revisions?status=open", undefined, "member");
    const res = await revisionsQueueRoute(req);
    expect(res.status).toBe(403);
  });

  it("anonymous → 403", async () => {
    const req = fakeRequest("GET", "http://localhost/api/revisions?status=open", undefined, "anon");
    const res = await revisionsQueueRoute(req);
    expect(res.status).toBe(403);
  });

  it("missing status param → 400", async () => {
    const req = fakeRequest("GET", "http://localhost/api/revisions", undefined, "admin");
    const res = await revisionsQueueRoute(req);
    expect(res.status).toBe(400);
  });
});

// ─── REST: accept/reject revision — relaxed guard ───────────────────────────

describe("REST POST /api/revisions/[id]/accept — admin || owner", () => {
  let adminDocRevId: number;

  beforeEach(async () => {
    await resetDb();
    const proposerScope = await memberSeesWorkspaceScope();
    await publishDocOk({ slug: "decide-doc", title: "Decide Doc", sourcePath: "t.md", format: "md", content: "v1", by: "Admin" });
    const rev = await createRevision({ slug: "decide-doc", authorName: "Plain", authorKind: "member", scope: proposerScope, content: "proposed body" });
    adminDocRevId = rev!.id;
  });

  it("admin → 200 (accept)", async () => {
    const req = fakeRequest("POST", `http://localhost/api/revisions/${adminDocRevId}/accept`, undefined, "admin");
    const res = await acceptRoute(req, { params: Promise.resolve({ id: String(adminDocRevId) }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("anonymous → 403 (reject)", async () => {
    const req = fakeRequest("POST", `http://localhost/api/revisions/${adminDocRevId}/reject`, undefined, "anon");
    const res = await rejectRoute(req, { params: Promise.resolve({ id: String(adminDocRevId) }) });
    expect(res.status).toBe(403);
  });

  it("member who is NOT owner → 403 (accept)", async () => {
    // In dev mode, x-dev-role=member gives a no-userId principal which is not the owner
    const req = fakeRequest("POST", `http://localhost/api/revisions/${adminDocRevId}/accept`, undefined, "member");
    const res = await acceptRoute(req, { params: Promise.resolve({ id: String(adminDocRevId) }) });
    // Doc has null ownerUserId (no owner set in beforeEach), member without userId → forbidden
    expect(res.status).toBe(403);
  });
});

describe("REST POST /api/revisions/[id]/reject — admin || owner", () => {
  let revId: number;

  beforeEach(async () => {
    await resetDb();
    const proposerScope = await memberSeesWorkspaceScope();
    await publishDocOk({ slug: "reject-doc", title: "Reject Doc", sourcePath: "t.md", format: "md", content: "v1", by: "Admin" });
    const rev = await createRevision({ slug: "reject-doc", authorName: "Mem", authorKind: "member", scope: proposerScope, content: "proposed" });
    revId = rev!.id;
  });

  it("admin → 200 (reject)", async () => {
    const req = fakeRequest("POST", `http://localhost/api/revisions/${revId}/reject`, undefined, "admin");
    const res = await rejectRoute(req, { params: Promise.resolve({ id: String(revId) }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("anonymous → 403", async () => {
    const req = fakeRequest("POST", `http://localhost/api/revisions/${revId}/reject`, undefined, "anon");
    const res = await rejectRoute(req, { params: Promise.resolve({ id: String(revId) }) });
    expect(res.status).toBe(403);
  });
});

// ─── MCP: publish_doc — relaxed guard ───────────────────────────────────────

describe("MCP publish_doc — permission matrix", () => {
  const publishDocTool = TOOLS.find((t) => t.name === "publish_doc")!;
  let realAdminId: number;

  beforeEach(async () => {
    await resetDb();
    await seedAudiences();
    realAdminId = await seedUser({ email: "adm@mcp.com", displayName: "Admin", role: "admin" });
  });

  it("admin creates new slug → ok", async () => {
    const p = adminPrincipal(realAdminId);
    const result = await publishDocTool.handler(p, {
      slug: "mcp-new",
      title: "MCP New",
      source_path: "t.md",
      audience: "team",
      format: "md",
      content: "hello mcp",
    });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.slug).toBe("mcp-new");
  });

  it("member creates new slug → error (admin-only create)", async () => {
    const memberId = await seedUser({ email: "m@mcp.com", displayName: "Member", role: "member" });
    const p = memberPrincipal(memberId);
    const result = await publishDocTool.handler(p, {
      slug: "mcp-member-new",
      title: "Member New",
      source_path: "t.md",
      audience: "team",
      format: "md",
      content: "test",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("admin");
  });

  it("anonymous creates new slug → error", async () => {
    const p = anonymous();
    const result = await publishDocTool.handler(p, {
      slug: "mcp-anon-new",
      title: "Anon New",
      source_path: "t.md",
      audience: "team",
      format: "md",
      content: "test",
    });
    expect(result.isError).toBe(true);
  });

  it("admin updates existing slug → ok", async () => {
    // Create the doc first
    await publishDoc({ slug: "mcp-existing", title: "Existing", sourcePath: "t.md", audience: "team", format: "md", content: "v1", by: "Admin", ownerUserId: realAdminId });

    const p = adminPrincipal(realAdminId);
    const result = await publishDocTool.handler(p, {
      slug: "mcp-existing",
      title: "Existing Updated",
      source_path: "t.md",
      audience: "team",
      format: "md",
      content: "v2 updated content",
    });
    expect(result.isError).toBeFalsy();
  });

  it("member (non-owner) tries to update existing slug → error", async () => {
    const memberId = await seedUser({ email: "m2@mcp.com", displayName: "Member2", role: "member" });
    await publishDoc({ slug: "mcp-admin-doc", title: "Admin Doc", sourcePath: "t.md", audience: "team", format: "md", content: "v1", by: "Admin", ownerUserId: realAdminId });

    // memberId is NOT the owner
    const p = memberPrincipal(memberId);
    const result = await publishDocTool.handler(p, {
      slug: "mcp-admin-doc",
      title: "Admin Doc Updated",
      source_path: "t.md",
      audience: "team",
      format: "md",
      content: "sneaky update",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Forbidden");
  });
});

// ─── MCP: decide_revision — relaxed guard ───────────────────────────────────

describe("MCP decide_revision — admin || owner", () => {
  const decideRevisionTool = TOOLS.find((t) => t.name === "decide_revision")!;
  let revId: number;
  let adminId: number;

  beforeEach(async () => {
    await resetDb();
    const proposerScope = await memberSeesWorkspaceScope();
    adminId = await seedUser({ email: "adm@decide.com", displayName: "Admin", role: "admin" });
    await publishDocOk({ slug: "mcp-decide-doc", title: "Decide Doc", sourcePath: "t.md", format: "md", content: "v1", by: "Admin" });
    const rev = await createRevision({ slug: "mcp-decide-doc", authorName: "Plain", authorKind: "member", scope: proposerScope, content: "proposed" });
    revId = rev!.id;
  });

  it("admin accepts → ok", async () => {
    const p = adminPrincipal(adminId);
    const result = await decideRevisionTool.handler(p, { id: revId, accept: true });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.status).toBe("accepted");
  });
});

describe("MCP decide_revision — non-owner member → error", () => {
  const decideRevisionTool = TOOLS.find((t) => t.name === "decide_revision")!;
  let revId: number;

  beforeEach(async () => {
    await resetDb();
    const proposerScope = await memberSeesWorkspaceScope();
    // Doc with null owner
    await publishDocOk({ slug: "mcp-noowner-doc", title: "NoOwner", sourcePath: "t.md", format: "md", content: "v1", by: "Admin" });
    const rev = await createRevision({ slug: "mcp-noowner-doc", authorName: "Plain", authorKind: "member", scope: proposerScope, content: "proposed" });
    revId = rev!.id;
  });

  it("member with no ownership → error", async () => {
    const p = memberPrincipal(99);
    const result = await decideRevisionTool.handler(p, { id: revId, accept: false });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Forbidden");
  });
});

// ─── MCP: owner reassignment via update_doc ──────────────────────────────────
// set_doc_owner was merged into update_doc in the Slice-1.5 (D8) audit; owner
// reassignment is now update_doc({ slug, owner_user_id }).

describe("MCP update_doc — owner reassignment", () => {
  const updateDocTool = TOOLS.find((t) => t.name === "update_doc")!;
  let targetUserId: number;
  let adminId: number;

  beforeEach(async () => {
    await resetDb();
    await seedAudiences();
    adminId = await seedUser({ email: "adm@owner.com", displayName: "Admin", role: "admin" });
    targetUserId = await seedUser({ email: "tgt@mcp.com", displayName: "Target", role: "member" });
    await publishDocOk({ slug: "mcp-owner-doc", title: "MCP Owner Doc", sourcePath: "t.md", audience: "team", format: "md", content: "hi", by: "Admin" });
  });

  it("admin reassigns owner → ok", async () => {
    const p = adminPrincipal(adminId);
    const result = await updateDocTool.handler(p, { slug: "mcp-owner-doc", owner_user_id: targetUserId });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.ownerUserId).toBe(targetUserId);
  });

  it("member → error", async () => {
    const p = memberPrincipal(targetUserId);
    const result = await updateDocTool.handler(p, { slug: "mcp-owner-doc", owner_user_id: targetUserId });
    expect(result.isError).toBe(true);
  });

  it("unknown slug → error", async () => {
    const p = adminPrincipal(adminId);
    const result = await updateDocTool.handler(p, { slug: "no-doc", owner_user_id: targetUserId });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not found");
  });

  it("unknown/inactive user → error", async () => {
    const p = adminPrincipal(adminId);
    const result = await updateDocTool.handler(p, { slug: "mcp-owner-doc", owner_user_id: 99999 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("inactive");
  });
});

// ─── MCP: list_open_revisions ────────────────────────────────────────────────

describe("MCP list_open_revisions", () => {
  const listOpenRevsTool = TOOLS.find((t) => t.name === "list_open_revisions")!;
  let adminId: number;

  beforeEach(async () => {
    await resetDb();
    const proposerScope = await memberSeesWorkspaceScope();
    adminId = await seedUser({ email: "adm@queue.com", displayName: "Admin", role: "admin" });
    await publishDocOk({ slug: "mcp-queue-doc", title: "Queue Doc", sourcePath: "t.md", format: "md", content: "v1", by: "Admin" });
    await createRevision({ slug: "mcp-queue-doc", authorName: "Plain", authorKind: "member", scope: proposerScope, content: "proposed" });
  });

  it("admin sees all", async () => {
    const p = adminPrincipal(adminId);
    const result = await listOpenRevsTool.handler(p, {});
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.revisions.length).toBeGreaterThanOrEqual(1);
  });

  it("member without userId (dev mode) → error", async () => {
    const p = memberNoUserId();
    const result = await listOpenRevsTool.handler(p, {});
    expect(result.isError).toBe(true);
  });

  it("anonymous → error", async () => {
    const p = anonymous();
    const result = await listOpenRevsTool.handler(p, {});
    expect(result.isError).toBe(true);
  });
});

// ─── MCP tool count check ────────────────────────────────────────────────────

describe("MCP tool registry", () => {
  it("includes update_doc (merged owner reassignment) and list_open_revisions", () => {
    const names = TOOLS.map((t) => t.name);
    expect(names).toContain("update_doc");
    expect(names).toContain("list_open_revisions");
    // set_doc_owner was merged into update_doc in the Slice-1.5 (D8) audit.
    expect(names).not.toContain("set_doc_owner");
  });

  it("decide_revision tool exists", () => {
    expect(TOOLS.find((t) => t.name === "decide_revision")).toBeDefined();
  });

  it("publish_doc tool exists", () => {
    expect(TOOLS.find((t) => t.name === "publish_doc")).toBeDefined();
  });
});
