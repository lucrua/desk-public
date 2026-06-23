import { describe, it, expect, beforeEach } from "vitest";
import { resetDb, createShareOk, publishDocOk } from "@/test/db";
import { revokeShare } from "@/lib/shares";
import { GET } from "./route";

const MD_DOC = {
  slug: "shared-doc",
  title: "Shared Doc",
  sourcePath: "os/s.md",
  audience: "external:pedro",
  format: "md" as const,
  content: "# Hello\n\nbody",
  by: "lucas",
};

const HTML_DOC = {
  slug: "artifact",
  title: "Artifact",
  sourcePath: "os/a.html",
  audience: "external:pedro",
  format: "html" as const,
  content: "<h1>Hi</h1>",
  by: "lucas",
};

const ctx = (token: string) => ({ params: Promise.resolve({ token }) });
const getReq = (token: string) =>
  new Request(`http://test/api/s/${token}/raw`, { method: "GET" });

async function freshShare(slug: string, label = "Microsoft", pinnedVersionId?: number | null) {
  const share = await createShareOk(slug, label, "lucas", undefined, pinnedVersionId);
  const token = share.shareUrl.split("/").pop()!;
  return { id: share.id, token };
}

describe("GET /api/s/[token]/raw — public download", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("md doc → 200 with content + text/markdown + attachment headers", async () => {
    await publishDocOk(MD_DOC);
    const { token } = await freshShare("shared-doc");
    const res = await GET(getReq(token), ctx(token));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="shared-doc.md"',
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe(MD_DOC.content);
  });

  it("html doc → 200 with text/html + .html filename", async () => {
    await publishDocOk(HTML_DOC);
    const { token } = await freshShare("artifact");
    const res = await GET(getReq(token), ctx(token));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="artifact.html"',
    );
    expect(await res.text()).toBe(HTML_DOC.content);
  });

  it("unknown token → uniform 404", async () => {
    await publishDocOk(MD_DOC);
    const res = await GET(getReq("not-a-real-token"), ctx("not-a-real-token"));
    expect(res.status).toBe(404);
  });

  it("revoked token → uniform 404 (same body as unknown)", async () => {
    await publishDocOk(MD_DOC);
    const { id, token } = await freshShare("shared-doc");
    await revokeShare(id);
    const revoked = await GET(getReq(token), ctx(token));
    const unknown = await GET(getReq("nope"), ctx("nope"));
    expect(revoked.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await revoked.text()).toBe(await unknown.text());
  });

  it("expired token → uniform 404", async () => {
    await publishDocOk(MD_DOC);
    // Create a share that expired in the past by minting with 0-day expiry then
    // forcing the row's expiresAt into the past via a fresh share with negative
    // window — createShare uses days, so use a share + manual expiry below.
    const share = await createShareOk("shared-doc", "X", "lucas", -1);
    const token = share.shareUrl.split("/").pop()!;
    const res = await GET(getReq(token), ctx(token));
    expect(res.status).toBe(404);
  });

  it("unpublished doc → uniform 404", async () => {
    const { versionId } = await publishDocOk(MD_DOC);
    void versionId;
    const { token } = await freshShare("shared-doc");
    // Unpublish the doc — every share (even live) must now 404.
    const { unpublishDoc } = await import("@/lib/docs");
    await unpublishDoc("shared-doc");
    const res = await GET(getReq(token), ctx(token));
    expect(res.status).toBe(404);
  });

  it("pinned share serves the pinned version's content (not the latest)", async () => {
    const first = await publishDocOk(MD_DOC);
    // Pin a share to v1.
    const { token } = await freshShare("shared-doc", "Pinned", first.versionId);
    // Publish a newer version of the same slug.
    await publishDocOk({ ...MD_DOC, content: "# Hello\n\nVERSION TWO" });
    const res = await GET(getReq(token), ctx(token));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(MD_DOC.content); // v1, not v2
  });
});
