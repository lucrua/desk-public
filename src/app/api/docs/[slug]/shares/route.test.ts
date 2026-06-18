import { describe, it, expect, beforeEach } from "vitest";
import { resetDb, seedAudiences } from "@/test/db";
import { publishDoc, unpublishDoc } from "@/lib/docs";
import { createShare } from "@/lib/shares";
import { GET } from "./route";

type Role = "admin" | "member" | "anonymous";

function headers(role: Role): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (role !== "anonymous") h["x-dev-role"] = role;
  return h;
}
function getReq(slug: string, role: Role = "admin") {
  return new Request(`http://test/api/docs/${slug}/shares`, {
    method: "GET",
    headers: headers(role),
  });
}
const ctx = (slug: string) => ({ params: Promise.resolve({ slug }) });

const DOC = {
  slug: "links-doc",
  title: "Links Doc",
  sourcePath: "os/links.md",
  audience: "team",
  format: "md" as const,
  content: "# Hi",
  by: "admin",
};

describe("GET /api/docs/[slug]/shares", () => {
  beforeEach(async () => {
    await resetDb();
    await seedAudiences();
    await publishDoc(DOC);
  });

  it("admin → 200 with only this doc's shares", async () => {
    await publishDoc({ ...DOC, slug: "other", sourcePath: "os/other.md" });
    await createShare("links-doc", "Alice", "admin");
    await createShare("links-doc", "Bob", "admin");
    await createShare("other", "Elsewhere", "admin");

    const res = await GET(getReq("links-doc"), ctx("links-doc"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.shares)).toBe(true);
    expect(json.shares).toHaveLength(2);
    expect(json.shares.every((s: { docSlug: string }) => s.docSlug === "links-doc")).toBe(true);
  });

  it("admin → 200 with empty array for a doc with no shares", async () => {
    const res = await GET(getReq("links-doc"), ctx("links-doc"));
    expect(res.status).toBe(200);
    expect((await res.json()).shares).toEqual([]);
  });

  it("unknown slug → 404 (uniform)", async () => {
    const res = await GET(getReq("nope"), ctx("nope"));
    expect(res.status).toBe(404);
    expect(await res.json()).toHaveProperty("error");
  });

  it("member → 200 read-only for a member-visible (team) doc", async () => {
    // DOC.audience is "team" (member-visible by default seed).
    await createShare("links-doc", "Alice", "admin");
    const res = await GET(getReq("links-doc", "member"), ctx("links-doc"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.shares).toHaveLength(1);
    // The member-readable payload carries no token-ish data — only the hash is
    // stored and it is never selected into ShareListItem.
    expect(json.shares[0]).not.toHaveProperty("token");
    expect(json.shares[0]).not.toHaveProperty("tokenHash");
  });

  it("member → 404 for an audience-denied doc (no existence signal)", async () => {
    // Publish a doc with a non-member-visible audience and a share on it.
    await publishDoc({ ...DOC, slug: "secret", sourcePath: "os/secret.md", audience: "alice" });
    await createShare("secret", "Eyes only", "admin");
    const res = await GET(getReq("secret", "member"), ctx("secret"));
    expect(res.status).toBe(404);
  });

  it("member → 404 for an unpublished doc (members never see deleted docs)", async () => {
    await createShare("links-doc", "Alice", "admin");
    await unpublishDoc("links-doc");
    const res = await GET(getReq("links-doc", "member"), ctx("links-doc"));
    expect(res.status).toBe(404);
  });

  it("anonymous → 403", async () => {
    const res = await GET(getReq("links-doc", "anonymous"), ctx("links-doc"));
    expect(res.status).toBe(403);
  });

  it("admin can list shares of an UNPUBLISHED (deleted) doc", async () => {
    await createShare("links-doc", "Alice", "admin");
    await unpublishDoc("links-doc");
    const res = await GET(getReq("links-doc"), ctx("links-doc"));
    expect(res.status).toBe(200);
    expect((await res.json()).shares).toHaveLength(1);
  });
});
