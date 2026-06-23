import { describe, it, expect, beforeEach } from "vitest";
import { resetDb, createShareOk, publishDocOk } from "@/test/db";
import { resolveShare, recordView } from "@/lib/shares";
import { GET } from "./route";

function makeHeaders(role: string | null): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (role !== null) h["x-dev-role"] = role;
  return h;
}

type Role = "admin" | "member" | "anonymous";

function viewsReq(id: string, role: Role = "admin") {
  return new Request(`http://test/api/shares/${id}/views`, {
    method: "GET",
    headers: makeHeaders(role === "anonymous" ? null : role),
  });
}

const DOC = {
  slug: "test-doc",
  title: "Test Doc",
  sourcePath: "os/test.md",
  audience: "external:pedro",
  format: "md" as const,
  content: "# Hello",
  by: "lucas",
};

describe("GET /api/shares/[id]/views", () => {
  beforeEach(async () => {
    await resetDb();
    await publishDocOk(DOC);
  });

  it("admin → 200 with views (uaLabel applied, raw ip preserved)", async () => {
    const share = await createShareOk("test-doc", "Pedro", "lucas");
    const resolved = await resolveShare(share!.token);
    const versionId = resolved!.version!.id;
    await recordView(
      share!.id,
      versionId,
      "1.2.3.4",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 WhatsApp/2.24.1",
    );

    const res = await GET(viewsReq(String(share!.id), "admin"), {
      params: Promise.resolve({ id: String(share!.id) }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.views).toHaveLength(1);
    expect(json.views[0].ip).toBe("1.2.3.4");
    expect(json.views[0].uaLabel).toBe("WhatsApp · iOS");
    expect(json.views[0].docVersionId).toBe(versionId);
    expect(typeof json.views[0].rawUa).toBe("string");
  });

  it("member → 403", async () => {
    const share = await createShareOk("test-doc", "Pedro", "lucas");
    const res = await GET(viewsReq(String(share!.id), "member"), {
      params: Promise.resolve({ id: String(share!.id) }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toHaveProperty("error");
  });

  it("anonymous → 403", async () => {
    const share = await createShareOk("test-doc", "Pedro", "lucas");
    const res = await GET(viewsReq(String(share!.id), "anonymous"), {
      params: Promise.resolve({ id: String(share!.id) }),
    });
    expect(res.status).toBe(403);
  });

  it("unknown share id → 200 with empty list (no existence signal)", async () => {
    const res = await GET(viewsReq("99999", "admin"), {
      params: Promise.resolve({ id: "99999" }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.views).toEqual([]);
  });

  it("non-numeric id → 400", async () => {
    const res = await GET(viewsReq("abc", "admin"), {
      params: Promise.resolve({ id: "abc" }),
    });
    expect(res.status).toBe(400);
  });

  it("rawUa truncated to 80 chars; hostile UA stays inert text", async () => {
    const share = await createShareOk("test-doc", "Pedro", "lucas");
    const resolved = await resolveShare(share!.token);
    const versionId = resolved!.version!.id;
    const hostile = '<img src=x onerror=alert(1)>' + "A".repeat(200);
    await recordView(share!.id, versionId, "9.9.9.9", hostile);

    const res = await GET(viewsReq(String(share!.id), "admin"), {
      params: Promise.resolve({ id: String(share!.id) }),
    });
    const json = await res.json();
    expect(json.views[0].rawUa).toHaveLength(80);
    // uaLabel falls through to inert truncated fallback (not executed).
    expect(json.views[0].uaLabel.startsWith("<img src=x")).toBe(true);
  });
});
