import { describe, it, expect, beforeEach } from "vitest";
import { resetDb, createShareOk, publishDocOk } from "@/test/db";
import { setShareComments, revokeShare } from "@/lib/shares";
import { shareCommentLimiter } from "@/lib/rate-limit";
import { GET, POST } from "./route";

const DOC = {
  slug: "shared-doc",
  title: "Shared Doc",
  sourcePath: "os/s.md",
  audience: "external:alice",
  format: "md" as const,
  content: "# Hello",
  by: "admin",
};

const ctx = (token: string) => ({ params: Promise.resolve({ token }) });

function postReq(token: string, body: unknown) {
  return new Request(`http://test/api/s/${token}/comments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
function getReq(token: string) {
  return new Request(`http://test/api/s/${token}/comments`, { method: "GET" });
}

async function freshShare(label = "Microsoft") {
  const share = await createShareOk("shared-doc", label, "admin");
  // Recover the token from the share URL (raw token appears once).
  const token = share.shareUrl.split("/").pop()!;
  return { id: share.id, token, label };
}

describe("POST /api/s/[token]/comments — public path", () => {
  beforeEach(async () => {
    await resetDb();
    await publishDocOk(DOC);
    shareCommentLimiter.reset();
  });

  it("valid share + allowComments on → 201, author forced to link:<label>", async () => {
    const { token, label } = await freshShare("Microsoft");
    const res = await POST(postReq(token, { body: "great deck" }), ctx(token));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.comment.authorKind).toBe(`link:${label}`);
    expect(json.comment.authorName).toBe(label);
    expect(json.comment.body).toBe("great deck");
    // No internals leak.
    expect(json.comment.shareId).toBeUndefined();
    expect(json.comment.versionId).toBeUndefined();
  });

  it("author cannot be overridden by the client body", async () => {
    const { token, label } = await freshShare("Microsoft");
    const res = await POST(
      postReq(token, { body: "hi", authorName: "Spoofed", authorKind: "admin" }),
      ctx(token),
    );
    const json = await res.json();
    expect(json.comment.authorName).toBe(label);
    expect(json.comment.authorKind).toBe(`link:${label}`);
  });

  it("unknown token → uniform 404", async () => {
    const res = await POST(postReq("not-a-real-token", { body: "x" }), ctx("not-a-real-token"));
    expect(res.status).toBe(404);
  });

  it("revoked token → uniform 404", async () => {
    const { id, token } = await freshShare();
    await revokeShare(id);
    const res = await POST(postReq(token, { body: "x" }), ctx(token));
    expect(res.status).toBe(404);
  });

  it("comments-off → 404 with the SAME body as an unknown token (indistinguishable)", async () => {
    const { id, token } = await freshShare();
    await setShareComments(id, false);
    const off = await POST(postReq(token, { body: "x" }), ctx(token));
    const unknown = await POST(postReq("not-a-real-token", { body: "x" }), ctx("not-a-real-token"));
    expect(off.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await off.json()).toEqual(await unknown.json());
  });

  it("rate limit: 10 succeed, 11th → 429", async () => {
    const { token } = await freshShare();
    for (let i = 0; i < 10; i++) {
      const res = await POST(postReq(token, { body: `c${i}` }), ctx(token));
      expect(res.status).toBe(201);
    }
    const res = await POST(postReq(token, { body: "over" }), ctx(token));
    expect(res.status).toBe(429);
  });

  it("rate limit is per-share (another share is unaffected)", async () => {
    const a = await freshShare("A");
    const b = await freshShare("B");
    for (let i = 0; i < 10; i++) await POST(postReq(a.token, { body: `x${i}` }), ctx(a.token));
    expect((await POST(postReq(a.token, { body: "over" }), ctx(a.token))).status).toBe(429);
    // b still has its full budget.
    expect((await POST(postReq(b.token, { body: "ok" }), ctx(b.token))).status).toBe(201);
  });

  it("oversize body → 400", async () => {
    const { token } = await freshShare();
    const res = await POST(postReq(token, { body: "x".repeat(10_001) }), ctx(token));
    expect(res.status).toBe(400);
  });

  it("empty / missing body → 400", async () => {
    const { token } = await freshShare();
    expect((await POST(postReq(token, { body: "   " }), ctx(token))).status).toBe(400);
    expect((await POST(postReq(token, {}), ctx(token))).status).toBe(400);
  });
});

describe("GET /api/s/[token]/comments — public path", () => {
  beforeEach(async () => {
    await resetDb();
    await publishDocOk(DOC);
    shareCommentLimiter.reset();
  });

  it("returns only unresolved comments, minimal shape", async () => {
    const { token } = await freshShare();
    await POST(postReq(token, { body: "visible" }), ctx(token));
    const res = await GET(getReq(token), ctx(token));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.comments).toHaveLength(1);
    expect(json.comments[0].body).toBe("visible");
    expect(json.comments[0].shareId).toBeUndefined();
  });

  it("resolved comments are hidden on the public GET", async () => {
    const { id, token } = await freshShare();
    // Post then resolve via the service directly (admin action).
    const posted = await (await POST(postReq(token, { body: "done" }), ctx(token))).json();
    const { resolveComment } = await import("@/lib/comments");
    await resolveComment(posted.comment.id);
    void id;
    const res = await GET(getReq(token), ctx(token));
    expect((await res.json()).comments).toHaveLength(0);
  });

  it("unknown token → 404; comments-off → 404", async () => {
    expect((await GET(getReq("nope"), ctx("nope"))).status).toBe(404);
    const { id, token } = await freshShare();
    await setShareComments(id, false);
    expect((await GET(getReq(token), ctx(token))).status).toBe(404);
  });
});
