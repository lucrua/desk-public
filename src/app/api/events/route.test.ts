import { describe, it, expect, beforeEach } from "vitest";
import { resetDb, seedAudiences, seedSpace, seedUser, publishDocOk } from "@/test/db";
import { unpublishDoc } from "@/lib/docs";
import { GET } from "./route";

function headers(role: string | null) {
  const h: Record<string, string> = {};
  if (role !== null) h["x-dev-role"] = role;
  return h;
}

function req(url: string, role: string | null = "admin") {
  return new Request(`http://test${url}`, { method: "GET", headers: headers(role) });
}

// Read access is space-scoped. The dev `member` principal carries no
// email/tokenName, so the events route resolves it to no users-row → it sees
// only docs in PUBLIC/UNLISTED spaces. Place the member-visible doc in an
// UNLISTED space and the hidden one in a PRIVATE space the member isn't in.
const team = {
  slug: "team-doc",
  title: "Team",
  sourcePath: "os/t.md",
  format: "md" as const,
  content: "# t",
  by: "lucas",
};
const hidden = { ...team, slug: "hidden-doc" };

describe("GET /api/events", () => {
  beforeEach(async () => {
    await resetDb();
    await seedAudiences();
    const owner = await seedUser({ email: "owner@x.com", displayName: "Owner", role: "admin" });
    const openSpace = await seedSpace({ slug: "open", ownerId: owner, visibility: "unlisted" });
    const privSpace = await seedSpace({ slug: "private-space", ownerId: owner, visibility: "private" });
    await publishDocOk({ ...team, spaceId: openSpace });
    await publishDocOk({ ...hidden, spaceId: privSpace });
  });

  it("anonymous → 403", async () => {
    const res = await GET(req("/api/events", null));
    expect(res.status).toBe(403);
  });

  it("admin sees events for both spaces", async () => {
    const res = await GET(req("/api/events", "admin"));
    expect(res.status).toBe(200);
    const json = await res.json();
    const slugs = json.events.map((e: { payload: { slug: string } }) => e.payload.slug);
    expect(slugs).toEqual(expect.arrayContaining(["team-doc", "hidden-doc"]));
    expect(typeof json.nextCursor).toBe("number");
  });

  it("member sees only docs in member-visible spaces", async () => {
    const res = await GET(req("/api/events", "member"));
    const json = await res.json();
    const slugs = json.events.map((e: { payload: { slug: string } }) => e.payload.slug);
    expect(slugs).toContain("team-doc");
    expect(slugs).not.toContain("hidden-doc");
  });

  it("?since advances the cursor (exclusive)", async () => {
    const all = await (await GET(req("/api/events", "admin"))).json();
    const firstId = all.events[0].id;
    const res = await GET(req(`/api/events?since=${firstId}`, "admin"));
    const json = await res.json();
    expect(json.events.every((e: { id: number }) => e.id > firstId)).toBe(true);
  });

  it("?kinds filters; unknown kind → 400", async () => {
    await unpublishDoc("team-doc");
    const ok = await GET(req("/api/events?kinds=doc.unpublished", "admin"));
    const json = await ok.json();
    expect(json.events.every((e: { kind: string }) => e.kind === "doc.unpublished")).toBe(true);

    const bad = await GET(req("/api/events?kinds=bogus", "admin"));
    expect(bad.status).toBe(400);
  });

  it("negative since → 400; non-positive limit → 400", async () => {
    expect((await GET(req("/api/events?since=-1", "admin"))).status).toBe(400);
    expect((await GET(req("/api/events?limit=0", "admin"))).status).toBe(400);
  });

  it("nextCursor is the requested since when the page is empty", async () => {
    const all = await (await GET(req("/api/events", "admin"))).json();
    const lastId = all.events[all.events.length - 1].id;
    const res = await GET(req(`/api/events?since=${lastId}`, "admin"));
    const json = await res.json();
    expect(json.events).toHaveLength(0);
    expect(json.nextCursor).toBe(lastId);
  });
});
