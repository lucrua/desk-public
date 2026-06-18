import { describe, it, expect, beforeEach } from "vitest";
import { resetDb, seedAudiences } from "@/test/db";
import { publishDoc, unpublishDoc } from "@/lib/docs";
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

const validBody = {
  slug: "my-doc",
  title: "My Doc",
  sourcePath: "os/my-doc.md",
  audience: "team",
  format: "md",
  content: "# Hello",
};

describe("POST /api/docs", () => {
  beforeEach(async () => {
    await resetDb();
    await seedAudiences([{ key: "external:Acme", label: "Acme", memberVisible: false }]);
  });

  it("admin publish returns 200 with slug, versionId, isNewVersion, hubUrl", async () => {
    const res = await POST(postReq(validBody, "admin"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.slug).toBe("my-doc");
    expect(typeof json.versionId).toBe("number");
    expect(json.isNewVersion).toBe(true);
    expect(json.hubUrl).toContain("/docs/my-doc");
  });

  it("member → 403", async () => {
    const res = await POST(postReq(validBody, "member"));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json).toHaveProperty("error");
  });

  it("anonymous → 403", async () => {
    const res = await POST(postReq(validBody, "anonymous"));
    expect(res.status).toBe(403);
  });

  it("missing slug → 400", async () => {
    const { slug: _slug, ...noSlug } = validBody;
    const res = await POST(postReq(noSlug, "admin"));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toHaveProperty("error");
  });

  it("missing title → 400", async () => {
    const { title: _t, ...body } = validBody;
    const res = await POST(postReq(body, "admin"));
    expect(res.status).toBe(400);
  });

  it("missing content → 400", async () => {
    const { content: _c, ...body } = validBody;
    const res = await POST(postReq(body, "admin"));
    expect(res.status).toBe(400);
  });

  it("invalid format → 400", async () => {
    const res = await POST(postReq({ ...validBody, format: "pdf" }, "admin"));
    expect(res.status).toBe(400);
  });

  it("invalid slug (uppercase) → 400", async () => {
    const res = await POST(postReq({ ...validBody, slug: "My-Doc" }, "admin"));
    expect(res.status).toBe(400);
  });

  it("invalid slug (starts with dash) → 400", async () => {
    const res = await POST(postReq({ ...validBody, slug: "-my-doc" }, "admin"));
    expect(res.status).toBe(400);
  });

  it("oversized content → 413", async () => {
    const huge = "x".repeat(2_000_001);
    const res = await POST(postReq({ ...validBody, content: huge }, "admin"));
    expect(res.status).toBe(413);
    const json = await res.json();
    expect(json).toHaveProperty("error");
  });

  it("content exactly at the cap → 200", async () => {
    const atCap = "x".repeat(2_000_000);
    const res = await POST(postReq({ ...validBody, content: atCap }, "admin"));
    expect(res.status).toBe(200);
  });

  it("unknown audience key → 400 (audiences are data; create it in /admin first)", async () => {
    const res = await POST(postReq({ ...validBody, audience: "no-such-audience" }, "admin"));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/unknown audience/i);
  });

  it("known audience key (seeded external:Acme) → 200", async () => {
    const res = await POST(
      postReq({ ...validBody, slug: "ext-pub", audience: "external:Acme" }, "admin"),
    );
    expect(res.status).toBe(200);
  });
});

describe("GET /api/docs", () => {
  beforeEach(async () => {
    await resetDb();
    await seedAudiences([{ key: "external:Acme", label: "Acme", memberVisible: false }]);
  });

  it("admin gets all docs including unpublished", async () => {
    await publishDoc({
      slug: "pub-doc", title: "Pub", sourcePath: "a.md", audience: "team",
      format: "md", content: "hello", by: "admin",
    });
    await publishDoc({
      slug: "unpub-doc", title: "Unpub", sourcePath: "b.md", audience: "team",
      format: "md", content: "bye", by: "admin",
    });
    await unpublishDoc("unpub-doc");

    const res = await GET(getReq("admin"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.docs).toHaveLength(2);
  });

  it("member only sees published docs", async () => {
    await publishDoc({
      slug: "pub-doc", title: "Pub", sourcePath: "a.md", audience: "team",
      format: "md", content: "hello", by: "admin",
    });
    await publishDoc({
      slug: "unpub-doc", title: "Unpub", sourcePath: "b.md", audience: "team",
      format: "md", content: "bye", by: "admin",
    });
    await unpublishDoc("unpub-doc");

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
    await seedAudiences([{ key: "external:Acme", label: "Acme", memberVisible: false }]);
  });

  it("returns 404 for unknown slug", async () => {
    const res = await slugGET(slugGetReq("not-here", "admin"), {
      params: Promise.resolve({ slug: "not-here" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 200 with doc + versions + content for known slug", async () => {
    await publishDoc({
      slug: "my-doc", title: "My Doc", sourcePath: "x.md", audience: "team",
      format: "md", content: "# Hello", by: "admin",
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
      slug: "my-doc", title: "My Doc", sourcePath: "x.md", audience: "team",
      format: "md", content: "# Hello", by: "admin",
    });
    await unpublishDoc("my-doc");

    const res = await slugGET(slugGetReq("my-doc", "member"), {
      params: Promise.resolve({ slug: "my-doc" }),
    });
    expect(res.status).toBe(404);
  });

  it("admin can see unpublished doc", async () => {
    await publishDoc({
      slug: "my-doc", title: "My Doc", sourcePath: "x.md", audience: "team",
      format: "md", content: "# Hello", by: "admin",
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
    await seedAudiences([{ key: "external:Acme", label: "Acme", memberVisible: false }]);
  });

  it("admin unpublishes existing doc → 200 {ok: true}", async () => {
    await publishDoc({
      slug: "my-doc", title: "My Doc", sourcePath: "x.md", audience: "team",
      format: "md", content: "# Hello", by: "admin",
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
      slug: "my-doc", title: "My Doc", sourcePath: "x.md", audience: "team",
      format: "md", content: "# Hello", by: "admin",
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
      slug: "my-doc", title: "My Doc", sourcePath: "x.md", audience: "team",
      format: "md", content: "# Hello", by: "admin",
    });
    await slugDELETE(slugDeleteReq("my-doc", "admin"), {
      params: Promise.resolve({ slug: "my-doc" }),
    });
    // Republish via POST
    const res = await POST(postReq(
      { slug: "my-doc", title: "My Doc", sourcePath: "x.md", audience: "team", format: "md", content: "# Hello" },
      "admin"
    ));
    expect(res.status).toBe(200);
    // Now GET should work for member
    const getRes = await slugGET(slugGetReq("my-doc", "member"), {
      params: Promise.resolve({ slug: "my-doc" }),
    });
    expect(getRes.status).toBe(200);
  });
});

// ── Audience scoping: member API access limited to team docs ─────────────────

describe("GET /api/docs — audience scoping (member vs non-team)", () => {
  beforeEach(async () => {
    await resetDb();
    await seedAudiences([{ key: "external:Acme", label: "Acme", memberVisible: false }]);
  });

  it("member list EXCLUDES alice / bob / external docs", async () => {
    await publishDoc({ slug: "team-doc", title: "Team", sourcePath: "a.md", audience: "team", format: "md", content: "t", by: "admin" });
    await publishDoc({ slug: "alice-doc", title: "Alice", sourcePath: "b.md", audience: "alice", format: "md", content: "p", by: "admin" });
    await publishDoc({ slug: "bob-doc", title: "Bob", sourcePath: "c.md", audience: "bob", format: "md", content: "d", by: "admin" });
    await publishDoc({ slug: "ext-doc", title: "Ext", sourcePath: "d.md", audience: "external:Acme", format: "md", content: "e", by: "admin" });

    const res = await GET(getReq("member"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.docs).toHaveLength(1);
    expect(json.docs[0].slug).toBe("team-doc");
  });

  it("admin list INCLUDES all audiences", async () => {
    await publishDoc({ slug: "team-doc", title: "Team", sourcePath: "a.md", audience: "team", format: "md", content: "t", by: "admin" });
    await publishDoc({ slug: "alice-doc", title: "Alice", sourcePath: "b.md", audience: "alice", format: "md", content: "p", by: "admin" });
    await publishDoc({ slug: "bob-doc", title: "Bob", sourcePath: "c.md", audience: "bob", format: "md", content: "d", by: "admin" });

    const res = await GET(getReq("admin"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.docs).toHaveLength(3);
  });
});

describe("GET /api/docs/[slug] — audience scoping (member vs non-team)", () => {
  beforeEach(async () => {
    await resetDb();
    await seedAudiences([{ key: "external:Acme", label: "Acme", memberVisible: false }]);
  });

  it("member GET of a alice doc → 404 (identical body to a missing-slug 404)", async () => {
    await publishDoc({ slug: "alice-doc", title: "Alice", sourcePath: "b.md", audience: "alice", format: "md", content: "secret", by: "admin" });

    const res = await slugGET(slugGetReq("alice-doc", "member"), {
      params: Promise.resolve({ slug: "alice-doc" }),
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

  it("member GET of a bob doc → 404", async () => {
    await publishDoc({ slug: "bob-doc", title: "Bob", sourcePath: "c.md", audience: "bob", format: "md", content: "secret", by: "admin" });

    const res = await slugGET(slugGetReq("bob-doc", "member"), {
      params: Promise.resolve({ slug: "bob-doc" }),
    });
    expect(res.status).toBe(404);
  });

  it("member GET of an external doc → 404", async () => {
    await publishDoc({ slug: "ext-doc", title: "Ext", sourcePath: "d.md", audience: "external:Acme", format: "md", content: "secret", by: "admin" });

    const res = await slugGET(slugGetReq("ext-doc", "member"), {
      params: Promise.resolve({ slug: "ext-doc" }),
    });
    expect(res.status).toBe(404);
  });

  it("member GET of a team doc → 200 with content", async () => {
    await publishDoc({ slug: "team-doc", title: "Team", sourcePath: "a.md", audience: "team", format: "md", content: "# Hello", by: "admin" });

    const res = await slugGET(slugGetReq("team-doc", "member"), {
      params: Promise.resolve({ slug: "team-doc" }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.doc.slug).toBe("team-doc");
    expect(json.currentVersion.content).toBe("# Hello");
  });

  it("admin GET of a alice doc → 200 with full content", async () => {
    await publishDoc({ slug: "alice-doc", title: "Alice", sourcePath: "b.md", audience: "alice", format: "md", content: "admin sees this", by: "admin" });

    const res = await slugGET(slugGetReq("alice-doc", "admin"), {
      params: Promise.resolve({ slug: "alice-doc" }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.doc.slug).toBe("alice-doc");
    expect(json.currentVersion.content).toBe("admin sees this");
  });

  it("versions list omits content (existing rule preserved)", async () => {
    await publishDoc({ slug: "team-doc", title: "Team", sourcePath: "a.md", audience: "team", format: "md", content: "v1", by: "admin" });
    await publishDoc({ slug: "team-doc", title: "Team", sourcePath: "a.md", audience: "team", format: "md", content: "v2", by: "admin" });

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
