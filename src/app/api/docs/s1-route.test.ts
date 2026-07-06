import { describe, it, expect, beforeEach } from "vitest";
import { resetDb, publishDocOk } from "@/test/db";
import { getDocBySlug } from "@/lib/docs";
import { GET } from "./route";
import { PATCH as slugPATCH } from "./[slug]/route";

function headers(role: string | null) {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (role !== null) h["x-dev-role"] = role;
  return h;
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

// NOTE: POST /api/docs no longer accepts slug / sourcePath / audience /
// base_version_id / folder-path — it converged onto a git commit taking `space`
// + `path` (Convergence fix-pass, Slice 2). The retired-contract POST describes
// (audience-on-POST, base_version_id optimistic concurrency, folder-path-on-
// create) were removed here; the git-truth POST contract is covered in
// docs/route.test.ts + doc-ownership.test.ts. The PATCH (move) + GET (prefix)
// route behaviour below is unchanged and still exercised.

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
