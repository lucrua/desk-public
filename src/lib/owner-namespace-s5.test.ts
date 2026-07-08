/**
 * Owner-namespace S5 — FULL-SURFACE two-owner isolation.
 *
 * S3 proved the resolution + git-write boundary isolate two same-slug owners;
 * S4 switched the web/API/MCP routes to resolve owner-qualified. But the
 * downstream service helpers still re-resolved by the (now-ambiguous) bare slug,
 * so a two-owner slug made them no-op / fail-closed (S4's "transitional
 * carry-over"). S5 made every space-scoped helper ID-BASED — the route passes the
 * already-resolved `space.id`. This suite proves the payoff: with `alice/reports`
 * and `bob/reports` both existing, EVERY mutation keyed by a resolved id touches
 * EXACTLY that owner's space and never the other's. This is what "fully correct
 * for two same-slug owners" (not just fail-closed) means.
 *
 * DB-only (no git): the helpers exercised here (visibility, push-policy, members,
 * mirror config, invites, catalog picker) operate on rows, so no repo is needed.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { resetDb, seedUser } from "@/test/db";
import {
  createSpace,
  getSpaceById,
  setSpaceVisibility,
  setSpacePushPolicy,
  setSpaceMemberRole,
  listSpaceMembers,
  type SpaceRow,
} from "@/lib/spaces";
import { setMirrorConfig } from "@/lib/mirror";
import { createInvite } from "@/lib/invites/invites";
import { catalogSpaces } from "@/lib/catalog/source";
import type { ViewerScope } from "@/lib/docs";

const ADMIN: ViewerScope = { viewer: "admin" };
const SLUG = "reports";

describe("Owner-namespace S5 — full-surface two-owner isolation", () => {
  let aliceId: number;
  let bobId: number;
  let carolId: number;
  let alice: SpaceRow;
  let bob: SpaceRow;

  beforeEach(async () => {
    await resetDb();
    aliceId = await seedUser({ tokenName: "alice", displayName: "Alice", role: "admin" });
    bobId = await seedUser({ tokenName: "bob", displayName: "Bob", role: "admin" });
    carolId = await seedUser({ tokenName: "carol", displayName: "Carol", role: "member" });

    // Two owners each create the SAME slug — both succeed (the composite key).
    const a = await createSpace(SLUG, aliceId, "private", "t");
    const b = await createSpace(SLUG, bobId, "private", "t");
    if (!a.ok || !b.ok) throw new Error("setup: both same-slug spaces must create");
    alice = a.space;
    bob = b.space;
    // Distinct spaces, same slug, different owners — the whole point.
    expect(alice.id).not.toBe(bob.id);
    expect(alice.slug).toBe(bob.slug);
  });

  it("setSpaceVisibility(id) changes ONLY that owner's space", async () => {
    const ok = await setSpaceVisibility(alice.id, "public", "t");
    expect(ok).toBe(true);
    expect((await getSpaceById(alice.id))!.visibility).toBe("public");
    // bob/reports is untouched.
    expect((await getSpaceById(bob.id))!.visibility).toBe("private");
  });

  it("setSpacePushPolicy(id) changes ONLY that owner's space", async () => {
    const ok = await setSpacePushPolicy(bob.id, "proposal", "t");
    expect(ok).toBe(true);
    expect((await getSpaceById(bob.id))!.pushPolicy).toBe("proposal");
    // alice/reports keeps the default direct policy.
    expect((await getSpaceById(alice.id))!.pushPolicy).toBe("direct");
  });

  it("setSpaceMemberRole(id) + listSpaceMembers(id) never cross owners", async () => {
    const out = await setSpaceMemberRole(alice.id, carolId, "writer", "t");
    expect(out.ok).toBe(true);

    const aliceMembers = (await listSpaceMembers(alice.id)) ?? [];
    const bobMembers = (await listSpaceMembers(bob.id)) ?? [];
    // Carol is a writer on alice/reports…
    expect(aliceMembers.find((m) => m.userId === carolId)?.role).toBe("writer");
    // …and NOT a member of bob/reports (bob has only its owner).
    expect(bobMembers.some((m) => m.userId === carolId)).toBe(false);
    expect(bobMembers.map((m) => m.userId)).toEqual([bobId]);

    // The membership row itself is bound to alice's space id, never bob's.
    const rows = await db
      .select()
      .from(schema.spaceMembers)
      .where(eq(schema.spaceMembers.userId, carolId));
    expect(rows).toHaveLength(1);
    expect(rows[0].spaceId).toBe(alice.id);
  });

  it("setMirrorConfig(id) configures ONLY that owner's space", async () => {
    const r = await setMirrorConfig(alice.id, {
      sourceMode: "mirrored",
      mirrorRemoteUrl: "https://github.com/alice/reports.git",
    });
    expect(r.ok).toBe(true);
    expect((await getSpaceById(alice.id))!.mirrorRemoteUrl).toBe(
      "https://github.com/alice/reports.git",
    );
    expect((await getSpaceById(alice.id))!.sourceMode).toBe("mirrored");
    // bob/reports stays hosted with no remote.
    expect((await getSpaceById(bob.id))!.mirrorRemoteUrl).toBeNull();
    expect((await getSpaceById(bob.id))!.sourceMode).toBe("hosted");
  });

  it("createInvite({ spaceId }) binds the invite to the RESOLVED owner's space", async () => {
    const out = await createInvite({
      spaceId: bob.id,
      role: "writer",
      createdByUserId: bobId,
      actorName: "bob",
    });
    expect(out.ok).toBe(true);
    // The invite row is scoped to bob/reports, never alice's same-slug space.
    const invites = await db.select().from(schema.spaceInvites);
    expect(invites).toHaveLength(1);
    expect(invites[0].spaceId).toBe(bob.id);
    // No invite ever attached to alice/reports.
    const onAlice = await db
      .select()
      .from(schema.spaceInvites)
      .where(eq(schema.spaceInvites.spaceId, alice.id));
    expect(onAlice).toHaveLength(0);
  });

  it("catalogSpaces() is OWNER-QUALIFIED — two same-slug spaces are distinct picker options", async () => {
    const options = await catalogSpaces(ADMIN);
    const reports = options.filter((o) => o.slug === SLUG);
    // Both same-slug spaces appear, disambiguated by owner handle.
    expect(reports.map((o) => o.owner).sort()).toEqual(["alice", "bob"]);
    // Each option carries the exact resolved space id (the id-based catalog key).
    const byOwner = Object.fromEntries(reports.map((o) => [o.owner, o]));
    expect(byOwner.alice.id).toBe(alice.id);
    expect(byOwner.bob.id).toBe(bob.id);
    // The owner-qualified param each picker link builds is unique per space.
    const params = reports.map((o) => `${o.owner}/${o.slug}`);
    expect(new Set(params).size).toBe(2);
  });

  it("a stale slug-derived lookup can't substitute for the id — the guard is the id itself", async () => {
    // Belt-and-suspenders: mutating by alice's id and reading bob's id are wholly
    // independent — there is no shared slug path left for a cross-owner write.
    await setSpaceVisibility(alice.id, "unlisted", "t");
    await setSpacePushPolicy(bob.id, "proposal", "t");
    const a = await getSpaceById(alice.id);
    const b = await getSpaceById(bob.id);
    expect([a!.visibility, a!.pushPolicy]).toEqual(["unlisted", "direct"]);
    expect([b!.visibility, b!.pushPolicy]).toEqual(["private", "proposal"]);
    // Sanity: the two id-keyed member lists never overlap.
    const rowsA = await db
      .select({ spaceId: schema.spaceMembers.spaceId })
      .from(schema.spaceMembers)
      .where(and(eq(schema.spaceMembers.spaceId, alice.id)));
    const rowsB = await db
      .select({ spaceId: schema.spaceMembers.spaceId })
      .from(schema.spaceMembers)
      .where(and(eq(schema.spaceMembers.spaceId, bob.id)));
    expect(rowsA.every((r) => r.spaceId === alice.id)).toBe(true);
    expect(rowsB.every((r) => r.spaceId === bob.id)).toBe(true);
  });
});
