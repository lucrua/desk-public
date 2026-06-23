import { describe, it, expect, beforeEach } from "vitest";
import { resetDb, seedAudiences, publishDocOk } from "@/test/db";
import { resolveShare } from "@/lib/shares";
import { POST } from "./route";

function headers(role: string | null) {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (role !== null) h["x-dev-role"] = role;
  return h;
}
function postReq(body: unknown, role: string | null = "admin") {
  return new Request("http://test/api/shares", {
    method: "POST",
    headers: headers(role),
    body: JSON.stringify(body),
  });
}

const DOC = {
  slug: "sp-doc",
  title: "SP",
  sourcePath: "os/sp.md",
  audience: "team",
  format: "md" as const,
  content: "# v1",
  by: "lucas",
};
const OTHER = { ...DOC, slug: "sp-other", content: "# o" };

describe("POST /api/shares — pinnedVersionId", () => {
  beforeEach(async () => {
    await resetDb();
    await seedAudiences();
  });

  it("creates a pinned share and the reader resolves the pinned version", async () => {
    const v1 = await publishDocOk(DOC);
    await publishDocOk({ ...DOC, content: "# v2" });

    const res = await POST(postReq({ docSlug: "sp-doc", label: "Pinned", pinnedVersionId: v1.versionId }));
    expect(res.status).toBe(200);
    const json = await res.json();
    const token = json.shareUrl.split("/s/")[1];

    const resolved = await resolveShare(token);
    expect(resolved!.pinned).toBe(true);
    expect(resolved!.version!.content).toBe("# v1");
  });

  it("pinnedVersionId from another doc → 400", async () => {
    await publishDocOk(DOC);
    const otherV = await publishDocOk(OTHER);
    const res = await POST(postReq({ docSlug: "sp-doc", label: "Bad", pinnedVersionId: otherV.versionId }));
    expect(res.status).toBe(400);
  });

  it("non-integer pinnedVersionId → 400", async () => {
    await publishDocOk(DOC);
    const res = await POST(postReq({ docSlug: "sp-doc", label: "Bad", pinnedVersionId: "x" }));
    expect(res.status).toBe(400);
  });

  it("unknown doc → 404", async () => {
    const res = await POST(postReq({ docSlug: "nope", label: "x", pinnedVersionId: 1 }));
    expect(res.status).toBe(404);
  });

  it("omitting pinnedVersionId creates a live link", async () => {
    await publishDocOk(DOC);
    const res = await POST(postReq({ docSlug: "sp-doc", label: "Live" }));
    const json = await res.json();
    const token = json.shareUrl.split("/s/")[1];
    const resolved = await resolveShare(token);
    expect(resolved!.pinned).toBe(false);
  });
});
