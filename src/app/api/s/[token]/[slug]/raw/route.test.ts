import { describe, it, expect, beforeEach } from "vitest";
import { resetDb, publishDocOk } from "@/test/db";
import { createDirectoryShare, revokeShare } from "@/lib/shares";
import { GET } from "./route";

const ctx = (token: string, slug: string) => ({
  params: Promise.resolve({ token, slug }),
});
const getReq = (token: string, slug: string) =>
  new Request(`http://test/api/s/${token}/${slug}/raw`, { method: "GET" });

function doc(over: Record<string, unknown> = {}) {
  return {
    slug: "x",
    title: "X",
    sourcePath: "x.md",
    audience: "private",
    format: "md" as const,
    content: "# body",
    by: "lucas",
    ...over,
  } as Parameters<typeof publishDocOk>[0];
}

async function dirShare(prefix: string) {
  const out = await createDirectoryShare(prefix, "Folder", "lucas");
  if (!out.ok) throw new Error("create failed");
  return { id: out.id, token: out.shareUrl.split("/").pop()! };
}

describe("GET /api/s/[token]/[slug]/raw — directory-doc download", () => {
  beforeEach(async () => {
    await resetDb();
    await publishDocOk(doc({ slug: "finance-q3", path: "finance/q3", content: "# Q3 body" }));
    await publishDocOk(doc({ slug: "financial-decoy", path: "financial", content: "# decoy" }));
    await publishDocOk(doc({ slug: "marketing", path: "marketing", content: "# mkt" }));
  });

  it("200 + attachment for a published doc under the prefix", async () => {
    const { token } = await dirShare("finance");
    const res = await GET(getReq(token, "finance-q3"), ctx(token, "finance-q3"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("finance-q3.md");
    expect(await res.text()).toBe("# Q3 body");
  });

  it("404 for a slug OUTSIDE the prefix (marketing)", async () => {
    const { token } = await dirShare("finance");
    const res = await GET(getReq(token, "marketing"), ctx(token, "marketing"));
    expect(res.status).toBe(404);
  });

  it("404 for the financial/ boundary decoy", async () => {
    const { token } = await dirShare("finance");
    const res = await GET(getReq(token, "financial-decoy"), ctx(token, "financial-decoy"));
    expect(res.status).toBe(404);
  });

  it("404 after the dir token is revoked", async () => {
    const { id, token } = await dirShare("finance");
    await revokeShare(id);
    const res = await GET(getReq(token, "finance-q3"), ctx(token, "finance-q3"));
    expect(res.status).toBe(404);
  });

  it("404 for an unknown token", async () => {
    const res = await GET(getReq("A".repeat(43), "finance-q3"), ctx("A".repeat(43), "finance-q3"));
    expect(res.status).toBe(404);
  });
});
