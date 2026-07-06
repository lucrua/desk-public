import { describe, it, expect, beforeEach } from "vitest";
import { resetDb, seedSpace, seedUser, publishDocOk } from "@/test/db";
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

  // ── wait_seconds long-poll (Slice 5) ───────────────────────────────────────

  it("wait_seconds returns IMMEDIATELY when events already match (no park)", async () => {
    const t0 = Date.now();
    const res = await GET(req("/api/events?wait_seconds=5", "admin"));
    const elapsed = Date.now() - t0;
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.events.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(1000); // pending events short-circuit the wait
  });

  it("wait_seconds parks then returns empty after ~the timeout when nothing new", async () => {
    const all = await (await GET(req("/api/events", "admin"))).json();
    const lastId = all.events[all.events.length - 1].id;
    const t0 = Date.now();
    const res = await GET(req(`/api/events?since=${lastId}&wait_seconds=1`, "admin"));
    const elapsed = Date.now() - t0;
    const json = await res.json();
    expect(json.events).toHaveLength(0);
    expect(json.nextCursor).toBe(lastId); // same shape as the immediate empty path
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(2500);
  });

  it("wait_seconds out of range is clamped (not rejected); non-integer → 400", async () => {
    // >55 clamps to 55, but pending events → returns immediately, so it's fast.
    const over = await GET(req("/api/events?wait_seconds=100", "admin"));
    expect(over.status).toBe(200);
    // negative clamps to 0 (immediate).
    const neg = await GET(req("/api/events?wait_seconds=-5", "admin"));
    expect(neg.status).toBe(200);
    // a non-integer is a 400 (like since/limit validation).
    expect((await GET(req("/api/events?wait_seconds=1.5", "admin"))).status).toBe(400);
    expect((await GET(req("/api/events?wait_seconds=abc", "admin"))).status).toBe(400);
  });

  it("a parked request ends promptly when the client aborts", async () => {
    const all = await (await GET(req("/api/events", "admin"))).json();
    const lastId = all.events[all.events.length - 1].id;
    const ac = new AbortController();
    const request = new Request(
      `http://test/api/events?since=${lastId}&wait_seconds=30`,
      { method: "GET", headers: headers("admin"), signal: ac.signal },
    );
    setTimeout(() => ac.abort(), 100);
    const t0 = Date.now();
    const res = await GET(request);
    const elapsed = Date.now() - t0;
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.events).toHaveLength(0);
    expect(elapsed).toBeLessThan(1500); // aborted — did NOT wait 30s
  });
});
