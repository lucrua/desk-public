import { describe, it, expect, beforeEach } from "vitest";
import {
  resetDb,
  seedAudiences,
  seedUser,
  seedMembership,
  publishDocOk,
} from "@/test/db";
import {
  listDocs,
  searchDocs,
  getDocBySlug,
  canSeeAudience,
  scopeForPrincipal,
  type ViewerScope,
} from "./docs";
import { listEvents } from "./events";
import type { Principal } from "@/lib/auth";

/**
 * Audiences v2 — the visibility matrix. An audience is now a GROUP: a member
 * sees a doc iff the audience is flag-visible (member_visible=1) OR the member
 * belongs to that audience. These tests pin every cell of the matrix per read
 * surface (listDocs / searchDocs / getDocBySlug / canSeeAudience / events), for:
 *
 *   - member IN the group           → sees the group's docs
 *   - member NOT in the group       → doesn't
 *   - flag-visible audience         → every member sees it (membership or not)
 *   - admin                         → sees everything regardless
 *   - no users row (fail-closed)    → flag-only, never a targeted doc
 */

// The Bob scenario fixtures: a flag-visible `team` audience, hidden `bob` and
// `alice` audiences (members only via membership), one doc tagged each.
async function seedScenario() {
  await seedAudiences(); // team (visible), alice (hidden), bob (hidden)
  await publishDocOk({
    slug: "team-doc",
    title: "Team Doc",
    sourcePath: "os/team.md",
    audience: "team",
    format: "md",
    content: "# Team\nshared with everyone signed in",
    by: "admin",
  });
  await publishDocOk({
    slug: "bob-doc",
    title: "Bob Doc",
    sourcePath: "os/bob.md",
    audience: "bob",
    format: "md",
    content: "# Bob\ntargeted to the bob group",
    by: "admin",
  });
  await publishDocOk({
    slug: "alice-doc",
    title: "Alice Doc",
    sourcePath: "os/alice.md",
    audience: "alice",
    format: "md",
    content: "# Alice\ntargeted to the alice group",
    by: "admin",
  });
}

const adminScope: ViewerScope = { viewer: "admin" };
const flagOnlyScope: ViewerScope = { viewer: "member", userId: null };
function memberScope(userId: number): ViewerScope {
  return { viewer: "member", userId };
}

describe("Audiences v2 — membership visibility matrix", () => {
  beforeEach(async () => {
    await resetDb();
  });

  describe("listDocs", () => {
    it("member IN the bob group sees team-doc + bob-doc, not alice-doc", async () => {
      await seedScenario();
      const bob = await seedUser({ email: "bob@x.com", displayName: "Bob" });
      await seedMembership("bob", bob);

      const slugs = (await listDocs({ scope: memberScope(bob) }))
        .map((d) => d.slug)
        .sort();
      expect(slugs).toEqual(["bob-doc", "team-doc"]);
    });

    it("member NOT in any group sees only the flag-visible team-doc", async () => {
      await seedScenario();
      const e = await seedUser({ email: "e@x.com", displayName: "E" });

      const slugs = (await listDocs({ scope: memberScope(e) })).map((d) => d.slug);
      expect(slugs).toEqual(["team-doc"]);
    });

    it("flag-visible audience still grants every member (no membership needed)", async () => {
      await seedScenario();
      // No userId at all (fail-closed dev principal) → flag-only.
      const slugs = (await listDocs({ scope: flagOnlyScope })).map((d) => d.slug);
      expect(slugs).toEqual(["team-doc"]);
    });

    it("admin sees all three", async () => {
      await seedScenario();
      const slugs = (await listDocs({ scope: adminScope })).map((d) => d.slug).sort();
      expect(slugs).toEqual(["alice-doc", "bob-doc", "team-doc"]);
    });

    it("a member in BOTH bob and alice sees all three (dedup, no double rows)", async () => {
      await seedScenario();
      const u = await seedUser({ email: "u@x.com", displayName: "U" });
      await seedMembership("bob", u);
      await seedMembership("alice", u);
      const slugs = (await listDocs({ scope: memberScope(u) })).map((d) => d.slug).sort();
      expect(slugs).toEqual(["alice-doc", "bob-doc", "team-doc"]);
    });
  });

  describe("searchDocs", () => {
    it("member IN the bob group finds bob-doc by content", async () => {
      await seedScenario();
      const bob = await seedUser({ email: "bob@x.com", displayName: "Bob" });
      await seedMembership("bob", bob);
      const hits = (await searchDocs("targeted", { scope: memberScope(bob) })).map(
        (d) => d.slug,
      );
      expect(hits).toContain("bob-doc");
      expect(hits).not.toContain("alice-doc");
    });

    it("member NOT in the group can't find a targeted doc", async () => {
      await seedScenario();
      const e = await seedUser({ email: "e@x.com", displayName: "E" });
      const hits = (await searchDocs("targeted", { scope: memberScope(e) })).map(
        (d) => d.slug,
      );
      expect(hits).toEqual([]);
    });

    it("admin search returns targeted docs", async () => {
      await seedScenario();
      const hits = (await searchDocs("targeted", { scope: adminScope }))
        .map((d) => d.slug)
        .sort();
      expect(hits).toEqual(["alice-doc", "bob-doc"]);
    });
  });

  describe("getDocBySlug", () => {
    it("member IN the group resolves the targeted doc; member NOT in it gets null", async () => {
      await seedScenario();
      const bob = await seedUser({ email: "bob@x.com", displayName: "Bob" });
      await seedMembership("bob", bob);
      const e = await seedUser({ email: "e@x.com", displayName: "E" });

      expect(await getDocBySlug("bob-doc", { scope: memberScope(bob) })).not.toBeNull();
      // Not-in-group is null — indistinguishable from a missing slug (no leak).
      expect(await getDocBySlug("bob-doc", { scope: memberScope(e) })).toBeNull();
      expect(await getDocBySlug("no-such-slug", { scope: memberScope(e) })).toBeNull();
    });

    it("flag-visible doc resolves for any member; admin resolves all", async () => {
      await seedScenario();
      const e = await seedUser({ email: "e@x.com", displayName: "E" });
      expect(await getDocBySlug("team-doc", { scope: memberScope(e) })).not.toBeNull();
      expect(await getDocBySlug("alice-doc", { scope: adminScope })).not.toBeNull();
    });
  });

  describe("canSeeAudience", () => {
    it("matrix: flag, membership, neither, admin", async () => {
      await seedScenario();
      const bob = await seedUser({ email: "bob@x.com", displayName: "Bob" });
      await seedMembership("bob", bob);

      // admin → always
      expect(await canSeeAudience("admin", "alice")).toBe(true);
      // flag-visible → any member
      expect(await canSeeAudience("member", "team", bob)).toBe(true);
      expect(await canSeeAudience("member", "team", null)).toBe(true);
      // membership → only that member
      expect(await canSeeAudience("member", "bob", bob)).toBe(true);
      expect(await canSeeAudience("member", "bob", null)).toBe(false);
      // neither
      expect(await canSeeAudience("member", "alice", bob)).toBe(false);
    });
  });

  describe("listEvents (feed scoping)", () => {
    it("member IN the bob group sees its doc.published event; member NOT in it doesn't", async () => {
      await seedScenario();
      const bob = await seedUser({ email: "bob@x.com", displayName: "Bob" });
      await seedMembership("bob", bob);
      const e = await seedUser({ email: "e@x.com", displayName: "E" });

      const slugOf = (rows: Awaited<ReturnType<typeof listEvents>>) =>
        rows
          .filter((r) => r.kind === "doc.published")
          .map((r) => (r.payload as { slug: string }).slug);

      const bobFeed = slugOf(await listEvents({ viewer: "member", userId: bob }));
      expect(bobFeed).toContain("bob-doc");
      expect(bobFeed).toContain("team-doc");
      expect(bobFeed).not.toContain("alice-doc");

      const eFeed = slugOf(await listEvents({ viewer: "member", userId: e }));
      expect(eFeed).toEqual(["team-doc"]);

      const adminFeed = slugOf(await listEvents({ viewer: "admin" })).sort();
      expect(adminFeed).toEqual(["alice-doc", "bob-doc", "team-doc"]);
    });

    it("fail-closed: no userId → flag-only events", async () => {
      await seedScenario();
      const slugOf = (rows: Awaited<ReturnType<typeof listEvents>>) =>
        rows
          .filter((r) => r.kind === "doc.published")
          .map((r) => (r.payload as { slug: string }).slug);
      const feed = slugOf(await listEvents({ viewer: "member" }));
      expect(feed).toEqual(["team-doc"]);
    });
  });

  describe("scopeForPrincipal", () => {
    it("admin → { viewer: 'admin' }; member with a users row → resolved userId", async () => {
      await seedScenario();
      const bobId = await seedUser({ email: "bob@x.com", displayName: "Bob" });
      await seedMembership("bob", bobId);

      const adminP: Principal = { kind: "admin", name: "Admin" };
      expect(await scopeForPrincipal(adminP)).toEqual({ viewer: "admin" });

      const memberP: Principal = { kind: "member", name: "Bob", email: "bob@x.com" };
      expect(await scopeForPrincipal(memberP)).toEqual({
        viewer: "member",
        userId: bobId,
      });

      // A member principal with no users row → fail-closed null userId.
      const ghost: Principal = { kind: "member", name: "Ghost", email: "ghost@x.com" };
      expect(await scopeForPrincipal(ghost)).toEqual({ viewer: "member", userId: null });
    });
  });
});
