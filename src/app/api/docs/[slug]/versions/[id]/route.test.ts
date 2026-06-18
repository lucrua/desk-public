import { describe, it, expect, beforeEach } from "vitest";
import { resetDb, seedAudiences } from "@/test/db";
import { publishDoc, getDocBySlug } from "@/lib/docs";
import { GET } from "./route";

type Role = "admin" | "member" | "anonymous";

function headers(role: Role): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (role !== "anonymous") h["x-dev-role"] = role;
  return h;
}

function getReq(slug: string, id: string | number, role: Role = "admin") {
  return new Request(`http://test/api/docs/${slug}/versions/${id}`, {
    method: "GET",
    headers: headers(role),
  });
}
const ctx = (slug: string, id: string | number) => ({
  params: Promise.resolve({ slug, id: String(id) }),
});

const TEAM_DOC = {
  slug: "team-doc",
  title: "Team Doc",
  sourcePath: "os/t.md",
  audience: "team",
  format: "md" as const,
  content: "# Hi\n\nbody one\n",
  by: "admin",
};
const HIDDEN_DOC = { ...TEAM_DOC, slug: "alice-doc", audience: "alice" };

async function currentVersionId(slug: string): Promise<number> {
  const r = await getDocBySlug(slug, { includeUnpublished: true });
  return r!.version!.id;
}

describe("GET /api/docs/[slug]/versions/[id]", () => {
  beforeEach(async () => {
    await resetDb();
    await seedAudiences();
    await publishDoc(TEAM_DOC);
    await publishDoc(HIDDEN_DOC);
  });

  it("admin gets the raw content of a version", async () => {
    const vid = await currentVersionId("team-doc");
    const res = await GET(getReq("team-doc", vid), ctx("team-doc", vid));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.slug).toBe("team-doc");
    expect(json.versionId).toBe(vid);
    expect(json.content).toBe("# Hi\n\nbody one\n");
  });

  it("member on a member-visible doc gets content", async () => {
    const vid = await currentVersionId("team-doc");
    const res = await GET(getReq("team-doc", vid, "member"), ctx("team-doc", vid));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.content).toBe("# Hi\n\nbody one\n");
  });

  it("member on a hidden audience gets a uniform 404 (no existence leak)", async () => {
    const vid = await currentVersionId("alice-doc");
    const res = await GET(getReq("alice-doc", vid, "member"), ctx("alice-doc", vid));
    expect(res.status).toBe(404);
  });

  it("anonymous → 403", async () => {
    const vid = await currentVersionId("team-doc");
    const res = await GET(getReq("team-doc", vid, "anonymous"), ctx("team-doc", vid));
    expect(res.status).toBe(403);
  });

  it("cross-doc version id → 404 (no content leak across docs)", async () => {
    const teamVid = await currentVersionId("team-doc");
    // Ask for team-doc's version under alice-doc's slug.
    const res = await GET(getReq("alice-doc", teamVid), ctx("alice-doc", teamVid));
    expect(res.status).toBe(404);
  });

  it("non-numeric id → 400", async () => {
    const res = await GET(getReq("team-doc", "abc"), ctx("team-doc", "abc"));
    expect(res.status).toBe(400);
  });

  it("unknown version id → 404", async () => {
    const res = await GET(getReq("team-doc", 999999), ctx("team-doc", 999999));
    expect(res.status).toBe(404);
  });

  it("unknown slug → 404", async () => {
    const res = await GET(getReq("nope", 1), ctx("nope", 1));
    expect(res.status).toBe(404);
  });
});
