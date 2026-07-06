import { describe, it, expect, beforeEach } from "vitest";
import { resetDb, publishDocOk } from "@/test/db";
import { createDirectoryShare, revokeShare } from "@/lib/shares";
import { GET, POST } from "./route";

const ctx = (token: string, slug: string) => ({
  params: Promise.resolve({ token, slug }),
});
const postReq = (token: string, slug: string, body: unknown) =>
  new Request(`http://test/api/s/${token}/${slug}/comments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const getReq = (token: string, slug: string) =>
  new Request(`http://test/api/s/${token}/${slug}/comments`, { method: "GET" });

function doc(over: Record<string, unknown> = {}) {
  return {
    slug: "x",
    title: "X",
    sourcePath: "x.md",
    format: "md" as const,
    content: "# body",
    by: "lucas",
    ...over,
  } as Parameters<typeof publishDocOk>[0];
}

async function dirShare(prefix: string, allowComments = true) {
  const out = await createDirectoryShare("workspace", prefix, "Folder", "lucas", undefined, allowComments);
  if (!out.ok) throw new Error("create failed");
  return { id: out.id, token: out.shareUrl.split("/").pop()! };
}

describe("/api/s/[token]/[slug]/comments — directory-doc comments", () => {
  beforeEach(async () => {
    await resetDb();
    await publishDocOk(doc({ slug: "finance-q3", path: "finance/q3" }));
    await publishDocOk(doc({ slug: "marketing", path: "marketing" }));
  });

  it("POST 201 for a published doc under the prefix; author forced to link:<label>", async () => {
    const { token } = await dirShare("finance");
    const res = await POST(postReq(token, "finance-q3", { body: "hello" }), ctx(token, "finance-q3"));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.comment.authorKind).toBe("link:Folder");

    // It shows in GET.
    const getRes = await GET(getReq(token, "finance-q3"), ctx(token, "finance-q3"));
    const list = await getRes.json();
    expect(list.comments).toHaveLength(1);
  });

  it("404 for a slug OUTSIDE the prefix (marketing)", async () => {
    const { token } = await dirShare("finance");
    const res = await POST(postReq(token, "marketing", { body: "x" }), ctx(token, "marketing"));
    expect(res.status).toBe(404);
  });

  it("404 (uniform) when comments are off — same body as no-token", async () => {
    const { token } = await dirShare("finance", false);
    const res = await POST(postReq(token, "finance-q3", { body: "x" }), ctx(token, "finance-q3"));
    expect(res.status).toBe(404);
  });

  it("404 after the dir token is revoked", async () => {
    const { id, token } = await dirShare("finance");
    await revokeShare(id);
    const res = await POST(postReq(token, "finance-q3", { body: "x" }), ctx(token, "finance-q3"));
    expect(res.status).toBe(404);
  });
});
