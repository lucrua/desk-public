import { describe, it, expect, beforeEach } from "vitest";
import {
  resetDb,
  publishDocOk,
  seedDevMemberInDefaultSpace,
  seedSpace,
  seedUser,
} from "@/test/db";
import { SNIPPET_START, SNIPPET_STOP } from "@/lib/docs";
import { GET } from "./route";

function getReq(url: string, role: string | null = "admin") {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (role !== null) h["x-dev-role"] = role;
  return new Request(`http://test${url}`, { method: "GET", headers: h });
}

describe("GET /api/docs?q= — full-text search", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("q present → FTS results with a snippet field (same list shape)", async () => {
    await publishDocOk({
      slug: "fts-a",
      title: "Neptune Notes",
      sourcePath: "a.md",
      format: "md",
      content: "the neptune passage is here in the body",
      by: "lucas",
    });
    const res = await GET(getReq("/api/docs?q=neptune"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.docs)).toBe(true);
    const row = json.docs.find((d: { slug: string }) => d.slug === "fts-a");
    expect(row).toBeTruthy();
    // List shape preserved.
    expect(row.title).toBe("Neptune Notes");
    expect(typeof row.versionCount).toBe("number");
    // Plus the delimiter-encoded snippet.
    expect(typeof row.snippet).toBe("string");
    expect(row.snippet).toContain(SNIPPET_START);
    expect(row.snippet).toContain(SNIPPET_STOP);
    expect(row.snippet).not.toContain("<b>");
  });

  it("no q → plain list (no snippet, all docs)", async () => {
    await publishDocOk({
      slug: "plain",
      title: "Plain",
      sourcePath: "p.md",
      format: "md",
      content: "body",
      by: "lucas",
    });
    const res = await GET(getReq("/api/docs"));
    const json = await res.json();
    const row = json.docs.find((d: { slug: string }) => d.slug === "plain");
    expect(row).toBeTruthy();
    expect(row.snippet).toBeUndefined();
  });

  it("member q is space-scoped — a match in another space is absent", async () => {
    // Hidden: a doc in a separate private space the dev member is not in.
    const ownerId = await seedUser({ email: "owner@test.local", displayName: "Owner", role: "admin" });
    const privateSpace = await seedSpace({ slug: "private-space", ownerId, visibility: "private" });
    await publishDocOk({
      slug: "hidden",
      title: "Hidden Saturn",
      sourcePath: "h.md",
      format: "md",
      content: "saturn",
      by: "lucas",
      spaceId: privateSpace,
    });
    // Visible: a doc in the default workspace the dev member reads.
    await seedDevMemberInDefaultSpace();
    await publishDocOk({
      slug: "visible",
      title: "Visible Saturn",
      sourcePath: "v.md",
      format: "md",
      content: "saturn",
      by: "lucas",
    });
    const res = await GET(getReq("/api/docs?q=saturn", "member"));
    const json = await res.json();
    const slugs = json.docs.map((d: { slug: string }) => d.slug);
    expect(slugs).toContain("visible");
    expect(slugs).not.toContain("hidden");
  });

  it("anonymous / non-staff is forbidden (403)", async () => {
    const res = await GET(getReq("/api/docs?q=x", null));
    expect(res.status).toBe(403);
  });
});
