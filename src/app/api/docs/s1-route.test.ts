import { describe, it, expect, beforeEach } from "vitest";
import { resetDb, publishDocOk } from "@/test/db";
import { getDocBySlug } from "@/lib/docs";
import { POST, GET } from "./route";
import { PATCH as slugPATCH } from "./[slug]/route";

function headers(role: string | null) {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (role !== null) h["x-dev-role"] = role;
  return h;
}

function postReq(body: unknown, role: string | null = "admin") {
  return new Request("http://test/api/docs", {
    method: "POST",
    headers: headers(role),
    body: JSON.stringify(body),
  });
}

function patchReq(slug: string, body: unknown, role: string | null = "admin") {
  return new Request(`http://test/api/docs/${slug}`, {
    method: "PATCH",
    headers: headers(role),
    body: JSON.stringify(body),
  });
}

function getReq(url: string, role: string | null = "admin") {
  return new Request(`http://test${url}`, { method: "GET", headers: headers(role) });
}

const base = {
  slug: "conc-doc",
  title: "Conc",
  sourcePath: "os/conc.md",
  format: "md" as const,
  content: "# v1",
};

describe("POST /api/docs — audience is vestigial (Gen-2 consolidation)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("omitting audience still publishes (200) — visibility follows the space", async () => {
    const res = await POST(postReq({ ...base, slug: "no-aud" }));
    expect(res.status).toBe(200);
    const doc = await getDocBySlug("no-aud");
    expect(doc).toBeTruthy();
    // Audience is vestigial: no longer set on publish.
    expect(doc!.doc.audience).toBeNull();
  });

  it("an `audience` field in the body is ignored, not rejected", async () => {
    // Any value (including ones that used to be unknown / empty) is accepted now.
    expect((await POST(postReq({ ...base, slug: "with-aud", audience: "team" }))).status).toBe(200);
    expect((await POST(postReq({ ...base, slug: "any-aud", audience: "nope" }))).status).toBe(200);
    expect((await POST(postReq({ ...base, slug: "empty-aud", audience: "" }))).status).toBe(200);
  });
});

describe("PATCH /api/docs/[slug] — audience removed (visibility follows the space)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  function ctx(slug: string) {
    return { params: Promise.resolve({ slug }) };
  }

  it("PATCH with only { audience } → 400 (PATCH supports { path } only)", async () => {
    await publishDocOk({ ...base, slug: "a", by: "lucas" });
    const res = await slugPATCH(patchReq("a", { audience: "team" }), ctx("a"));
    // Audience is no longer a mutable per-doc field; PATCH supports { path } only.
    expect(res.status).toBe(400);
  });

  it("member → 403 before any body validation", async () => {
    await publishDocOk({ ...base, slug: "b", by: "lucas" });
    expect((await slugPATCH(patchReq("b", { path: "team" }, "member"), ctx("b"))).status).toBe(403);
  });
});

describe("POST /api/docs — optimistic concurrency (base_version_id)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("matching base_version_id appends a new version (200)", async () => {
    const v1 = await publishDocOk({ ...base, by: "lucas" });
    const res = await POST(
      postReq({ ...base, content: "# v2", baseVersionId: v1.versionId }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.isNewVersion).toBe(true);
  });

  it("stale base_version_id → 409 with current_version_id + current_content_hash", async () => {
    const v1 = await publishDocOk({ ...base, by: "lucas" });
    // advance the doc so v1 is no longer current
    const v2 = await publishDocOk({ ...base, content: "# v2", by: "lucas" });

    const res = await POST(
      postReq({ ...base, content: "# v3 from stale", baseVersionId: v1.versionId }),
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBeTruthy();
    expect(json.current_version_id).toBe(v2.versionId);
    expect(typeof json.current_content_hash).toBe("string");
    expect(json.current_content_hash.length).toBeGreaterThan(0);

    // The conflicting publish must NOT have created a version.
    const doc = await getDocBySlug("conc-doc");
    expect(doc!.doc.currentVersionId).toBe(v2.versionId);
  });

  it("absent base_version_id keeps back-compat append behaviour", async () => {
    await publishDocOk({ ...base, by: "lucas" });
    const res = await POST(postReq({ ...base, content: "# v2" }));
    expect(res.status).toBe(200);
  });

  it("base_version_id on a brand-new slug is ignored (nothing to conflict with)", async () => {
    const res = await POST(postReq({ ...base, slug: "fresh", baseVersionId: 999 }));
    expect(res.status).toBe(200);
  });

  it("non-integer base_version_id → 400", async () => {
    const res = await POST(postReq({ ...base, baseVersionId: "nope" }));
    expect(res.status).toBe(400);
  });
});

describe("POST /api/docs — path on create", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("valid path is stored", async () => {
    const res = await POST(postReq({ ...base, slug: "p1", path: "os/canon" }));
    expect(res.status).toBe(200);
    const doc = await getDocBySlug("p1");
    expect(doc!.doc.path).toBe("os/canon");
  });

  it("invalid path → 400", async () => {
    const res = await POST(postReq({ ...base, slug: "p2", path: "OS/Bad" }));
    expect(res.status).toBe(400);
  });

  it("path is canonicalized (leading/trailing slashes stripped)", async () => {
    const res = await POST(postReq({ ...base, slug: "p3", path: "/os/canon/" }));
    expect(res.status).toBe(200);
    const doc = await getDocBySlug("p3");
    expect(doc!.doc.path).toBe("os/canon");
  });
});

describe("PATCH /api/docs/[slug] — Move (path)", () => {
  beforeEach(async () => {
    await resetDb();
    await publishDocOk({ ...base, by: "lucas" });
  });

  it("admin moves the doc to a new path (200, moved: true)", async () => {
    const res = await slugPATCH(patchReq("conc-doc", { path: "team/notes" }), {
      params: Promise.resolve({ slug: "conc-doc" }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.moved).toBe(true);
    expect(json.path).toBe("team/notes");
    const doc = await getDocBySlug("conc-doc");
    expect(doc!.doc.path).toBe("team/notes");
  });

  it("moving to the same path is a noop (200, moved: false)", async () => {
    await slugPATCH(patchReq("conc-doc", { path: "x" }), {
      params: Promise.resolve({ slug: "conc-doc" }),
    });
    const res = await slugPATCH(patchReq("conc-doc", { path: "x" }), {
      params: Promise.resolve({ slug: "conc-doc" }),
    });
    const json = await res.json();
    expect(json.moved).toBe(false);
  });

  it("member is forbidden (403)", async () => {
    const res = await slugPATCH(patchReq("conc-doc", { path: "x" }, "member"), {
      params: Promise.resolve({ slug: "conc-doc" }),
    });
    expect(res.status).toBe(403);
  });

  it("invalid path → 400", async () => {
    const res = await slugPATCH(patchReq("conc-doc", { path: "Bad Path" }), {
      params: Promise.resolve({ slug: "conc-doc" }),
    });
    expect(res.status).toBe(400);
  });

  it("unknown slug → 404", async () => {
    const res = await slugPATCH(patchReq("nope", { path: "x" }), {
      params: Promise.resolve({ slug: "nope" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("GET /api/docs — ?path= prefix filter", () => {
  beforeEach(async () => {
    await resetDb();
    await publishDocOk({ ...base, slug: "root-doc", path: "", by: "lucas" });
    await publishDocOk({ ...base, slug: "os-doc", path: "os", by: "lucas" });
    await publishDocOk({ ...base, slug: "canon-doc", path: "os/canon", by: "lucas" });
    await publishDocOk({ ...base, slug: "other-doc", path: "team", by: "lucas" });
  });

  it("prefix matches the folder and its descendants", async () => {
    const res = await GET(getReq("/api/docs?path=os"));
    const json = await res.json();
    const slugs = json.docs.map((d: { slug: string }) => d.slug).sort();
    expect(slugs).toEqual(["canon-doc", "os-doc"]);
  });

  it("no path = all docs", async () => {
    const res = await GET(getReq("/api/docs"));
    const json = await res.json();
    expect(json.docs).toHaveLength(4);
  });

  it("invalid path → 400", async () => {
    const res = await GET(getReq("/api/docs?path=Bad"));
    expect(res.status).toBe(400);
  });
});
