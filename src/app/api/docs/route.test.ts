import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import {
  resetDb,
  seedDevMemberInDefaultSpace,
  seedSpace,
  seedUser,
  publishDocOk,
} from "@/test/db";
import { HAVE_GIT, useTempDataDir, clearSpaceRepos } from "@/test/git";
import { publishDoc, unpublishDoc } from "@/lib/docs";
import { createSpace } from "@/lib/spaces";
import { GET, POST } from "./route";
import { GET as slugGET, DELETE as slugDELETE } from "./[slug]/route";

// Helpers
function makeHeaders(role: string | null, extraHeaders?: Record<string, string>) {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (role !== null) h["x-dev-role"] = role;
  if (extraHeaders) Object.assign(h, extraHeaders);
  return h;
}

function postReq(body: unknown, role: "admin" | "member" | "anonymous" | null = "admin") {
  return new Request("http://test/api/docs", {
    method: "POST",
    headers: makeHeaders(role === "anonymous" ? null : role),
    body: JSON.stringify(body),
  });
}

function getReq(role: "admin" | "member" | "anonymous" | null = "admin") {
  return new Request("http://test/api/docs", {
    method: "GET",
    headers: makeHeaders(role === "anonymous" ? null : role),
  });
}

function slugGetReq(slug: string, role: "admin" | "member" | "anonymous" | null = "admin") {
  return new Request(`http://test/api/docs/${slug}`, {
    method: "GET",
    headers: makeHeaders(role === "anonymous" ? null : role),
  });
}

function slugDeleteReq(slug: string, role: "admin" | "member" | "anonymous" | null = "admin") {
  return new Request(`http://test/api/docs/${slug}`, {
    method: "DELETE",
    headers: makeHeaders(role === "anonymous" ? null : role),
  });
}

// POST now commits a file into a SPACE (truth = git); it requires `space` +
// `path` and is gated by space membership, not the old admin-only create rule.
const validBody = {
  space: "wsx",
  path: "os/my-doc.md",
  content: "# Hello",
};

describe("POST /api/docs — space + path (git-truth)", () => {
  // Committing tests need a real bare repo — isolate to a throwaway data dir.
  let restore: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    ({ restore } = await useTempDataDir());
  });
  afterAll(async () => {
    if (restore) await restore();
  });

  beforeEach(async () => {
    await resetDb();
    await clearSpaceRepos();
    // A space owned by an admin; the dev `admin` principal acts as owner on it.
    const ownerId = await seedUser({ tokenName: "wsx-owner", displayName: "Owner", role: "admin" });
    await createSpace("wsx", ownerId, "private", "t");
  });

  it.skipIf(!HAVE_GIT)("admin commit → 200 with slug, url, ref (git)", async () => {
    const res = await POST(postReq(validBody, "admin"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(typeof json.slug).toBe("string");
    expect(json.ref).toBe("refs/heads/main");
    expect(json.target).toBe("main");
    expect(json.url).toContain(`/docs/${json.slug}`);
  });

  it("member who is not a space member → 403", async () => {
    const res = await POST(postReq(validBody, "member"));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json).toHaveProperty("error");
  });

  it("anonymous → 403", async () => {
    const res = await POST(postReq(validBody, "anonymous"));
    expect(res.status).toBe(403);
  });

  it("missing space → 400", async () => {
    const { space: _s, ...noSpace } = validBody;
    const res = await POST(postReq(noSpace, "admin"));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toHaveProperty("error");
  });

  it("missing path → 400", async () => {
    const { path: _p, ...noPath } = validBody;
    const res = await POST(postReq(noPath, "admin"));
    expect(res.status).toBe(400);
  });

  it("unsafe path (traversal) → 400", async () => {
    const res = await POST(postReq({ ...validBody, path: "../escape.md" }, "admin"));
    expect(res.status).toBe(400);
  });

  it("missing content → 400", async () => {
    const { content: _c, ...body } = validBody;
    const res = await POST(postReq(body, "admin"));
    expect(res.status).toBe(400);
  });

  it("oversized content → 413 (before any commit)", async () => {
    const huge = "x".repeat(2_000_001);
    const res = await POST(postReq({ ...validBody, content: huge }, "admin"));
    expect(res.status).toBe(413);
    const json = await res.json();
    expect(json).toHaveProperty("error");
  });

  it.skipIf(!HAVE_GIT)("content exactly at the cap → 200 (git)", async () => {
    const atCap = "x".repeat(2_000_000);
    const res = await POST(postReq({ ...validBody, content: atCap }, "admin"));
    expect(res.status).toBe(200);
  });
});

describe("GET /api/docs", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("admin gets all docs including unpublished", async () => {
    await publishDoc({
      slug: "pub-doc", title: "Pub", sourcePath: "a.md",
      format: "md", content: "hello", by: "lucas",
    });
    await publishDoc({
      slug: "unpub-doc", title: "Unpub", sourcePath: "b.md",
      format: "md", content: "bye", by: "lucas",
    });
    await unpublishDoc("unpub-doc");

    const res = await GET(getReq("admin"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.docs).toHaveLength(2);
  });

  it("member only sees published docs in their space", async () => {
    await publishDoc({
      slug: "pub-doc", title: "Pub", sourcePath: "a.md",
      format: "md", content: "hello", by: "lucas",
    });
    await publishDoc({
      slug: "unpub-doc", title: "Unpub", sourcePath: "b.md",
      format: "md", content: "bye", by: "lucas",
    });
    await unpublishDoc("unpub-doc");
    // Make the dev member a reader of the default workspace so it sees docs there.
    await seedDevMemberInDefaultSpace();

    const res = await GET(getReq("member"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.docs).toHaveLength(1);
    expect(json.docs[0].slug).toBe("pub-doc");
  });

  it("anonymous → 403", async () => {
    const res = await GET(getReq("anonymous"));
    expect(res.status).toBe(403);
  });
});

describe("GET /api/docs/[slug]", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("returns 404 for unknown slug", async () => {
    const res = await slugGET(slugGetReq("not-here", "admin"), {
      params: Promise.resolve({ slug: "not-here" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 200 with doc + versions + content for known slug", async () => {
    await publishDoc({
      slug: "my-doc", title: "My Doc", sourcePath: "x.md",
      format: "md", content: "# Hello", by: "lucas",
    });
    const res = await slugGET(slugGetReq("my-doc", "admin"), {
      params: Promise.resolve({ slug: "my-doc" }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.doc).toBeDefined();
    expect(json.doc.slug).toBe("my-doc");
    expect(json.versions).toBeDefined();
    expect(json.versions.length).toBeGreaterThan(0);
    expect(json.currentVersion).toBeDefined();
    expect(json.currentVersion.content).toBe("# Hello");
  });

  it("member gets 404 for unpublished doc", async () => {
    await publishDoc({
      slug: "my-doc", title: "My Doc", sourcePath: "x.md",
      format: "md", content: "# Hello", by: "lucas",
    });
    await unpublishDoc("my-doc");
    // Even a member of the doc's space can't see it once unpublished.
    await seedDevMemberInDefaultSpace();

    const res = await slugGET(slugGetReq("my-doc", "member"), {
      params: Promise.resolve({ slug: "my-doc" }),
    });
    expect(res.status).toBe(404);
  });

  it("admin can see unpublished doc", async () => {
    await publishDoc({
      slug: "my-doc", title: "My Doc", sourcePath: "x.md",
      format: "md", content: "# Hello", by: "lucas",
    });
    await unpublishDoc("my-doc");

    const res = await slugGET(slugGetReq("my-doc", "admin"), {
      params: Promise.resolve({ slug: "my-doc" }),
    });
    expect(res.status).toBe(200);
  });

  it("anonymous → 403", async () => {
    const res = await slugGET(slugGetReq("any-doc", "anonymous"), {
      params: Promise.resolve({ slug: "any-doc" }),
    });
    expect(res.status).toBe(403);
  });
});

describe("DELETE /api/docs/[slug]", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("admin unpublishes existing doc → 200 {ok: true}", async () => {
    await publishDoc({
      slug: "my-doc", title: "My Doc", sourcePath: "x.md",
      format: "md", content: "# Hello", by: "lucas",
    });
    const res = await slugDELETE(slugDeleteReq("my-doc", "admin"), {
      params: Promise.resolve({ slug: "my-doc" }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
  });

  it("admin delete on unknown slug → 404", async () => {
    const res = await slugDELETE(slugDeleteReq("ghost-doc", "admin"), {
      params: Promise.resolve({ slug: "ghost-doc" }),
    });
    expect(res.status).toBe(404);
  });

  it("member → 403", async () => {
    await publishDoc({
      slug: "my-doc", title: "My Doc", sourcePath: "x.md",
      format: "md", content: "# Hello", by: "lucas",
    });
    const res = await slugDELETE(slugDeleteReq("my-doc", "member"), {
      params: Promise.resolve({ slug: "my-doc" }),
    });
    expect(res.status).toBe(403);
  });

  it("anonymous → 403", async () => {
    const res = await slugDELETE(slugDeleteReq("my-doc", "anonymous"), {
      params: Promise.resolve({ slug: "my-doc" }),
    });
    expect(res.status).toBe(403);
  });

  it("republish after DELETE clears unpublishedAt (smoke test via service)", async () => {
    await publishDoc({
      slug: "my-doc", title: "My Doc", sourcePath: "x.md",
      format: "md", content: "# Hello", by: "lucas",
    });
    await slugDELETE(slugDeleteReq("my-doc", "admin"), {
      params: Promise.resolve({ slug: "my-doc" }),
    });
    // Republish via the publishDoc service seam (a deleted slug is free — a fresh
    // publish mints a brand-new live doc at that slug). The route now commits to
    // git, so this smoke test drives the service directly.
    await publishDoc({
      slug: "my-doc", title: "My Doc", sourcePath: "x.md", format: "md", content: "# Hello", by: "lucas",
    });
    // Make the dev member a reader of the default workspace so it sees the republished doc.
    await seedDevMemberInDefaultSpace();
    // Now GET should work for member
    const getRes = await slugGET(slugGetReq("my-doc", "member"), {
      params: Promise.resolve({ slug: "my-doc" }),
    });
    expect(getRes.status).toBe(200);
  });
});

// ── Space scoping: member API access limited to docs in their space ──────────

describe("GET /api/docs — space scoping (member's space vs a private space)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("member list EXCLUDES docs in spaces the member is not in", async () => {
    // Visible doc: published with no spaceId → lands in the default workspace,
    // which the dev member is a reader of.
    await seedDevMemberInDefaultSpace();
    await publishDocOk({ slug: "team-doc", title: "Team", sourcePath: "a.md", format: "md", content: "t", by: "lucas" });

    // Hidden docs: a separate PRIVATE space the dev member is not a member of.
    const ownerId = await seedUser({ email: "owner@test.local", displayName: "Owner", role: "admin" });
    const privateSpace = await seedSpace({ slug: "private-space", ownerId, visibility: "private" });
    await publishDocOk({ slug: "pedro-doc", title: "Pedro", sourcePath: "b.md", format: "md", content: "p", by: "lucas", spaceId: privateSpace });
    await publishDocOk({ slug: "dani-doc", title: "Dani", sourcePath: "c.md", format: "md", content: "d", by: "lucas", spaceId: privateSpace });

    const res = await GET(getReq("member"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.docs).toHaveLength(1);
    expect(json.docs[0].slug).toBe("team-doc");
  });

  it("admin list INCLUDES docs across all spaces", async () => {
    await publishDocOk({ slug: "team-doc", title: "Team", sourcePath: "a.md", format: "md", content: "t", by: "lucas" });
    const ownerId = await seedUser({ email: "owner@test.local", displayName: "Owner", role: "admin" });
    const privateSpace = await seedSpace({ slug: "private-space", ownerId, visibility: "private" });
    await publishDocOk({ slug: "pedro-doc", title: "Pedro", sourcePath: "b.md", format: "md", content: "p", by: "lucas", spaceId: privateSpace });
    await publishDocOk({ slug: "dani-doc", title: "Dani", sourcePath: "c.md", format: "md", content: "d", by: "lucas", spaceId: privateSpace });

    const res = await GET(getReq("admin"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.docs).toHaveLength(3);
  });
});

describe("GET /api/docs/[slug] — space scoping (member's space vs a private space)", () => {
  let privateSpace: number;

  beforeEach(async () => {
    await resetDb();
    // Default workspace the dev member can read.
    await seedDevMemberInDefaultSpace();
    // A separate private space the dev member is NOT in.
    const ownerId = await seedUser({ email: "owner@test.local", displayName: "Owner", role: "admin" });
    privateSpace = await seedSpace({ slug: "private-space", ownerId, visibility: "private" });
  });

  it("member GET of a doc in a private space → 404 (identical body to a missing-slug 404)", async () => {
    await publishDocOk({ slug: "pedro-doc", title: "Pedro", sourcePath: "b.md", format: "md", content: "secret", by: "lucas", spaceId: privateSpace });

    const res = await slugGET(slugGetReq("pedro-doc", "member"), {
      params: Promise.resolve({ slug: "pedro-doc" }),
    });
    expect(res.status).toBe(404);

    // Must carry the same error body as a genuinely missing slug.
    const deniedJson = await res.json();
    const missingRes = await slugGET(slugGetReq("no-such-slug", "member"), {
      params: Promise.resolve({ slug: "no-such-slug" }),
    });
    expect(missingRes.status).toBe(404);
    const missingJson = await missingRes.json();
    // Both have an "error" key — existence is not signalled.
    expect(deniedJson).toHaveProperty("error");
    expect(missingJson).toHaveProperty("error");
  });

  it("member GET of another doc in a private space → 404", async () => {
    await publishDocOk({ slug: "dani-doc", title: "Dani", sourcePath: "c.md", format: "md", content: "secret", by: "lucas", spaceId: privateSpace });

    const res = await slugGET(slugGetReq("dani-doc", "member"), {
      params: Promise.resolve({ slug: "dani-doc" }),
    });
    expect(res.status).toBe(404);
  });

  it("member GET of a doc in their space → 200 with content", async () => {
    await publishDocOk({ slug: "team-doc", title: "Team", sourcePath: "a.md", format: "md", content: "# Hello", by: "lucas" });

    const res = await slugGET(slugGetReq("team-doc", "member"), {
      params: Promise.resolve({ slug: "team-doc" }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.doc.slug).toBe("team-doc");
    expect(json.currentVersion.content).toBe("# Hello");
  });

  it("admin GET of a doc in a private space → 200 with full content", async () => {
    await publishDocOk({ slug: "pedro-doc", title: "Pedro", sourcePath: "b.md", format: "md", content: "admin sees this", by: "lucas", spaceId: privateSpace });

    const res = await slugGET(slugGetReq("pedro-doc", "admin"), {
      params: Promise.resolve({ slug: "pedro-doc" }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.doc.slug).toBe("pedro-doc");
    expect(json.currentVersion.content).toBe("admin sees this");
  });

  it("versions list omits content (existing rule preserved)", async () => {
    await publishDocOk({ slug: "team-doc", title: "Team", sourcePath: "a.md", format: "md", content: "v1", by: "lucas" });
    await publishDocOk({ slug: "team-doc", title: "Team", sourcePath: "a.md", format: "md", content: "v2", by: "lucas" });

    const res = await slugGET(slugGetReq("team-doc", "admin"), {
      params: Promise.resolve({ slug: "team-doc" }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    // versions list must NOT contain content
    for (const v of json.versions) {
      expect(v).not.toHaveProperty("content");
    }
    // currentVersion DOES contain content
    expect(json.currentVersion).toHaveProperty("content");
  });
});
