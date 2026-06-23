import { describe, it, expect, beforeEach } from "vitest";
import {
  resetDb,
  publishDocOk,
  seedDevMemberInDefaultSpace,
  seedSpace,
  seedUser,
} from "@/test/db";
import { publishDoc } from "@/lib/docs";
import { GET, POST } from "./route";
import { POST as resolvePost } from "@/app/api/comments/[id]/resolve/route";
import { DELETE as deleteRoute } from "@/app/api/comments/[id]/route";

type Role = "admin" | "member" | "anonymous";

function headers(role: Role): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (role !== "anonymous") h["x-dev-role"] = role;
  return h;
}

function getReq(slug: string, role: Role = "admin") {
  return new Request(`http://test/api/docs/${slug}/comments`, {
    method: "GET",
    headers: headers(role),
  });
}
function postReq(slug: string, body: unknown, role: Role = "admin") {
  return new Request(`http://test/api/docs/${slug}/comments`, {
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
  content: "# Hi",
  by: "lucas",
};
const HIDDEN_DOC = { ...TEAM_DOC, slug: "pedro-doc" };

describe("GET/POST /api/docs/[slug]/comments", () => {
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

  it("admin POST creates a comment (201) authored by the principal", async () => {
    const res = await POST(postReq("team-doc", { body: "  looks good  " }), ctx("team-doc"));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.comment.body).toBe("looks good");
    expect(json.comment.authorKind).toBe("admin");
    expect(json.comment.authorName).toBe("Dev Admin");
  });

  it("member POST on a doc in their space → 201, authored member", async () => {
    const res = await POST(postReq("team-doc", { body: "from member" }, "member"), ctx("team-doc"));
    expect(res.status).toBe(201);
    expect((await res.json()).comment.authorKind).toBe("member");
  });

  it("member on a doc in a space they're not in → 404 (uniform, no existence leak)", async () => {
    const res = await POST(postReq("pedro-doc", { body: "x" }, "member"), ctx("pedro-doc"));
    expect(res.status).toBe(404);
    const get = await GET(getReq("pedro-doc", "member"), ctx("pedro-doc"));
    expect(get.status).toBe(404);
  });

  it("anonymous → 403", async () => {
    const res = await POST(postReq("team-doc", { body: "x" }, "anonymous"), ctx("team-doc"));
    expect(res.status).toBe(403);
  });

  it("unknown slug → 404", async () => {
    const res = await POST(postReq("nope", { body: "x" }), ctx("nope"));
    expect(res.status).toBe(404);
  });

  it("empty body → 400", async () => {
    const res = await POST(postReq("team-doc", { body: "   " }), ctx("team-doc"));
    expect(res.status).toBe(400);
  });

  it("missing body → 400", async () => {
    const res = await POST(postReq("team-doc", {}), ctx("team-doc"));
    expect(res.status).toBe(400);
  });

  it("oversize body → 400", async () => {
    const res = await POST(postReq("team-doc", { body: "x".repeat(10_001) }), ctx("team-doc"));
    expect(res.status).toBe(400);
  });

  it("GET returns the thread including resolved (staff)", async () => {
    await POST(postReq("team-doc", { body: "one" }), ctx("team-doc"));
    const c2 = await (await POST(postReq("team-doc", { body: "two" }), ctx("team-doc"))).json();
    await resolvePost(new Request("http://t", { method: "POST", headers: headers("admin") }), idCtx(c2.comment.id));

    const res = await GET(getReq("team-doc"), ctx("team-doc"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.comments).toHaveLength(2); // resolved still shown to staff
  });
});

describe("admin resolve / delete", () => {
  beforeEach(async () => {
    await resetDb();
    await publishDoc(TEAM_DOC);
  });

  async function makeComment() {
    const r = await POST(postReq("team-doc", { body: "todo" }), ctx("team-doc"));
    return (await r.json()).comment.id as number;
  }

  it("admin resolve → 200; member → 403", async () => {
    const id = await makeComment();
    const memberRes = await resolvePost(
      new Request("http://t", { method: "POST", headers: headers("member") }),
      idCtx(id),
    );
    expect(memberRes.status).toBe(403);
    const adminRes = await resolvePost(
      new Request("http://t", { method: "POST", headers: headers("admin") }),
      idCtx(id),
    );
    expect(adminRes.status).toBe(200);
  });

  it("resolve unknown id → 404", async () => {
    const res = await resolvePost(
      new Request("http://t", { method: "POST", headers: headers("admin") }),
      idCtx(99999),
    );
    expect(res.status).toBe(404);
  });

  it("admin delete → 200 and removes it; member → 403", async () => {
    const id = await makeComment();
    const memberRes = await deleteRoute(
      new Request("http://t", { method: "DELETE", headers: headers("member") }),
      idCtx(id),
    );
    expect(memberRes.status).toBe(403);
    const adminRes = await deleteRoute(
      new Request("http://t", { method: "DELETE", headers: headers("admin") }),
      idCtx(id),
    );
    expect(adminRes.status).toBe(200);
    // Gone now.
    const after = await GET(getReq("team-doc"), ctx("team-doc"));
    expect((await after.json()).comments).toHaveLength(0);
  });

  it("delete unknown id → 404", async () => {
    const res = await deleteRoute(
      new Request("http://t", { method: "DELETE", headers: headers("admin") }),
      idCtx(99999),
    );
    expect(res.status).toBe(404);
  });
});
