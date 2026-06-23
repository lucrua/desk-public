import { describe, it, expect, beforeEach } from "vitest";
import {
  resetDb,
  publishDocOk,
  seedDevMemberInDefaultSpace,
  seedSpace,
  seedUser,
} from "@/test/db";
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
  format: "md" as const,
  content: "# Hi\n\nbody one\n",
  by: "lucas",
};
const HIDDEN_DOC = { ...TEAM_DOC, slug: "pedro-doc" };

async function currentVersionId(slug: string): Promise<number> {
  const r = await getDocBySlug(slug, { includeUnpublished: true });
  return r!.version!.id;
}

describe("GET /api/docs/[slug]/versions/[id]", () => {
  beforeEach(async () => {
    await resetDb();
    // TEAM_DOC lands in the default workspace the dev member reads.
    await seedDevMemberInDefaultSpace();
    await publishDoc(TEAM_DOC);
    // HIDDEN_DOC lives in a separate private space the dev member is not in.
    const ownerId = await seedUser({ email: "owner@test.local", displayName: "Owner", role: "admin" });
    const privateSpace = await seedSpace({ slug: "private-space", ownerId, visibility: "private" });
    await publishDocOk({ ...HIDDEN_DOC, spaceId: privateSpace });
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

  it("member on a doc in their space gets content", async () => {
    const vid = await currentVersionId("team-doc");
    const res = await GET(getReq("team-doc", vid, "member"), ctx("team-doc", vid));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.content).toBe("# Hi\n\nbody one\n");
  });

  it("member on a doc in a space they're not in gets a uniform 404 (no existence leak)", async () => {
    const vid = await currentVersionId("pedro-doc");
    const res = await GET(getReq("pedro-doc", vid, "member"), ctx("pedro-doc", vid));
    expect(res.status).toBe(404);
  });

  it("anonymous → 403", async () => {
    const vid = await currentVersionId("team-doc");
    const res = await GET(getReq("team-doc", vid, "anonymous"), ctx("team-doc", vid));
    expect(res.status).toBe(403);
  });

  it("cross-doc version id → 404 (no content leak across docs)", async () => {
    const teamVid = await currentVersionId("team-doc");
    // Ask for team-doc's version under pedro-doc's slug.
    const res = await GET(getReq("pedro-doc", teamVid), ctx("pedro-doc", teamVid));
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
