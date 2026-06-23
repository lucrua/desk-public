import { describe, it, expect, beforeEach } from "vitest";
import {
  resetDb,
  publishDocOk,
  seedDevMemberInDefaultSpace,
  seedSpace,
  seedUser,
} from "@/test/db";
import { publishDoc, getDocBySlug, listVersions, getVersionContent } from "@/lib/docs";
import { getRevision } from "@/lib/revisions";
import { GET, POST } from "./route";
import { POST as acceptRoute } from "@/app/api/revisions/[id]/accept/route";
import { POST as rejectRoute } from "@/app/api/revisions/[id]/reject/route";
import { MAX_CONTENT_CHARS, MAX_REVISION_NOTE_CHARS } from "@/lib/limits";

type Role = "admin" | "member" | "anonymous";

function headers(role: Role): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (role !== "anonymous") h["x-dev-role"] = role;
  return h;
}

function getReq(slug: string, role: Role = "admin", qs = "") {
  return new Request(`http://test/api/docs/${slug}/revisions${qs}`, {
    method: "GET",
    headers: headers(role),
  });
}
function postReq(slug: string, body: unknown, role: Role = "admin") {
  return new Request(`http://test/api/docs/${slug}/revisions`, {
    method: "POST",
    headers: headers(role),
    body: JSON.stringify(body),
  });
}
const ctx = (slug: string) => ({ params: Promise.resolve({ slug }) });
const idCtx = (id: string | number) => ({ params: Promise.resolve({ id: String(id) }) });

const TEAM_DOC = {
  slug: "team-doc",
  title: "Team Doc",
  sourcePath: "os/t.md",
  format: "md" as const,
  content: "# Hi\n\noriginal\n",
  by: "lucas",
};
const HIDDEN_DOC = { ...TEAM_DOC, slug: "pedro-doc" };
const HTML_DOC = { ...TEAM_DOC, slug: "html-doc", format: "html" as const, content: "<p>hi</p>" };

describe("GET/POST /api/docs/[slug]/revisions", () => {
  beforeEach(async () => {
    await resetDb();
    // TEAM_DOC + HTML_DOC land in the default workspace the dev member reads.
    await seedDevMemberInDefaultSpace();
    await publishDoc(TEAM_DOC);
    await publishDoc(HTML_DOC);
    // HIDDEN_DOC lives in a separate private space the dev member is not in.
    const ownerId = await seedUser({ email: "owner@test.local", displayName: "Owner", role: "admin" });
    const privateSpace = await seedSpace({ slug: "private-space", ownerId, visibility: "private" });
    await publishDocOk({ ...HIDDEN_DOC, spaceId: privateSpace });
  });

  it("admin POST creates a revision (201) authored by the principal", async () => {
    const res = await POST(postReq("team-doc", { content: "# Hi\n\nrevised\n", note: "tweak" }), ctx("team-doc"));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.revision.content).toBe("# Hi\n\nrevised\n");
    expect(json.revision.authorKind).toBe("admin");
    expect(json.revision.authorName).toBe("Dev Admin");
    expect(json.revision.note).toBe("tweak");
    expect(json.revision.status).toBe("open");
  });

  it("member POST on a doc in their space → 201, authored member", async () => {
    const res = await POST(postReq("team-doc", { content: "# member edit" }, "member"), ctx("team-doc"));
    expect(res.status).toBe(201);
    expect((await res.json()).revision.authorKind).toBe("member");
  });

  it("member on a doc in a space they're not in → 404 (uniform, no existence leak)", async () => {
    const res = await POST(postReq("pedro-doc", { content: "x" }, "member"), ctx("pedro-doc"));
    expect(res.status).toBe(404);
    const get = await GET(getReq("pedro-doc", "member"), ctx("pedro-doc"));
    expect(get.status).toBe(404);
  });

  it("html doc → 400 (no editor on html docs)", async () => {
    const res = await POST(postReq("html-doc", { content: "<p>x</p>" }), ctx("html-doc"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/markdown/i);
  });

  it("anonymous → 403", async () => {
    expect((await POST(postReq("team-doc", { content: "x" }, "anonymous"), ctx("team-doc"))).status).toBe(403);
    expect((await GET(getReq("team-doc", "anonymous"), ctx("team-doc"))).status).toBe(403);
  });

  it("missing/empty content → 400", async () => {
    expect((await POST(postReq("team-doc", {}), ctx("team-doc"))).status).toBe(400);
    expect((await POST(postReq("team-doc", { content: "" }), ctx("team-doc"))).status).toBe(400);
  });

  it("oversize content → 400", async () => {
    const big = "x".repeat(MAX_CONTENT_CHARS + 1);
    expect((await POST(postReq("team-doc", { content: big }), ctx("team-doc"))).status).toBe(400);
  });

  it("oversize note → 400", async () => {
    const note = "x".repeat(MAX_REVISION_NOTE_CHARS + 1);
    expect((await POST(postReq("team-doc", { content: "x", note }), ctx("team-doc"))).status).toBe(400);
  });

  it("GET lists revisions, filterable by status", async () => {
    await POST(postReq("team-doc", { content: "# a" }), ctx("team-doc"));
    await POST(postReq("team-doc", { content: "# b" }), ctx("team-doc"));
    const all = await (await GET(getReq("team-doc"), ctx("team-doc"))).json();
    expect(all.revisions).toHaveLength(2);
    const open = await (await GET(getReq("team-doc", "admin", "?status=open"), ctx("team-doc"))).json();
    expect(open.revisions).toHaveLength(2);
    const accepted = await (await GET(getReq("team-doc", "admin", "?status=accepted"), ctx("team-doc"))).json();
    expect(accepted.revisions).toHaveLength(0);
  });
});

describe("POST /api/revisions/[id]/accept | reject", () => {
  beforeEach(async () => {
    await resetDb();
    // The dev member proposes revisions, so it must read the doc's space.
    await seedDevMemberInDefaultSpace();
    await publishDoc(TEAM_DOC);
  });

  async function propose(content: string, role: Role = "member") {
    const res = await POST(postReq("team-doc", { content }, role), ctx("team-doc"));
    return (await res.json()).revision as { id: number };
  }

  it("admin accept publishes a new version + marks accepted", async () => {
    const before = await listVersions("team-doc");
    const rev = await propose("# Hi\n\nACCEPTED\n");
    const res = await acceptRoute(
      new Request("http://test", { method: "POST", headers: headers("admin") }),
      idCtx(rev.id),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.isNewVersion).toBe(true);
    expect(json.staleBase).toBe(false);

    const after = await listVersions("team-doc");
    expect(after.length).toBe(before.length + 1);
    const cur = await getDocBySlug("team-doc", { includeUnpublished: true });
    expect(await getVersionContent("team-doc", cur!.version!.id)).toBe("# Hi\n\nACCEPTED\n");
    // published by the accepting admin
    expect(after[0].publishedBy).toBe("Dev Admin");
    expect((await getRevision(rev.id))!.status).toBe("accepted");
  });

  it("member cannot accept (403)", async () => {
    const rev = await propose("# x");
    const res = await acceptRoute(
      new Request("http://test", { method: "POST", headers: headers("member") }),
      idCtx(rev.id),
    );
    expect(res.status).toBe(403);
  });

  it("admin reject marks rejected without a new version", async () => {
    const before = await listVersions("team-doc");
    const rev = await propose("# x");
    const res = await rejectRoute(
      new Request("http://test", { method: "POST", headers: headers("admin") }),
      idCtx(rev.id),
    );
    expect(res.status).toBe(200);
    expect((await getRevision(rev.id))!.status).toBe("rejected");
    expect((await listVersions("team-doc")).length).toBe(before.length);
  });

  it("double-decide → 409", async () => {
    const rev = await propose("# x");
    await acceptRoute(
      new Request("http://test", { method: "POST", headers: headers("admin") }),
      idCtx(rev.id),
    );
    const again = await acceptRoute(
      new Request("http://test", { method: "POST", headers: headers("admin") }),
      idCtx(rev.id),
    );
    expect(again.status).toBe(409);
    const rejAfterAccept = await rejectRoute(
      new Request("http://test", { method: "POST", headers: headers("admin") }),
      idCtx(rev.id),
    );
    expect(rejAfterAccept.status).toBe(409);
  });

  it("unknown id → 404", async () => {
    const acc = await acceptRoute(
      new Request("http://test", { method: "POST", headers: headers("admin") }),
      idCtx(99999),
    );
    expect(acc.status).toBe(404);
    const rej = await rejectRoute(
      new Request("http://test", { method: "POST", headers: headers("admin") }),
      idCtx(99999),
    );
    expect(rej.status).toBe(404);
  });

  it("invalid id → 400", async () => {
    const res = await acceptRoute(
      new Request("http://test", { method: "POST", headers: headers("admin") }),
      idCtx("abc"),
    );
    expect(res.status).toBe(400);
  });
});
