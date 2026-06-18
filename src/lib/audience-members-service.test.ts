import { describe, it, expect, beforeEach } from "vitest";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
import { resetDb, seedAudiences, seedUser } from "@/test/db";
import {
  addAudienceMember,
  removeAudienceMember,
  listAudienceMembers,
  listAllMemberships,
} from "./audiences";
import { setDocAudience, publishDoc } from "./docs";
import { listEvents } from "./events";

/**
 * Audiences v2 — membership SERVICE (addAudienceMember / removeAudienceMember /
 * listAudienceMembers). Pins the idempotency, typed misses, and event emission
 * the REST + MCP layers depend on.
 */

async function audienceId(key: string): Promise<number> {
  const a = await db.query.audiences.findFirst({
    where: eq(schema.audiences.key, key),
  });
  if (!a) throw new Error(`no audience ${key}`);
  return a.id;
}

describe("audience membership service", () => {
  beforeEach(async () => {
    await resetDb();
    await seedAudiences(); // team / alice / bob
  });

  it("add → list shows the member; add again is idempotent (no second row, no second event)", async () => {
    const bobAud = await audienceId("bob");
    const u = await seedUser({ email: "d@x.com", displayName: "Bob" });

    const first = await addAudienceMember(bobAud, u, "admin");
    expect(first.ok && first.added).toBe(true);

    const second = await addAudienceMember(bobAud, u, "admin");
    expect(second.ok && second.added).toBe(false);

    const members = await listAudienceMembers(bobAud);
    expect(members).not.toBeNull();
    expect(members!).toHaveLength(1);
    expect(members![0].userId).toBe(u);
    expect(members![0].displayName).toBe("Bob");

    const added = (await listEvents({ viewer: "admin" })).filter(
      (e) => e.kind === "audience.member_added",
    );
    expect(added).toHaveLength(1);
    expect((added[0].payload as { audience: string }).audience).toBe("bob");
    expect((added[0].payload as { userId: number }).userId).toBe(u);
  });

  it("add returns typed miss for unknown audience / unknown user", async () => {
    const bobAud = await audienceId("bob");
    const u = await seedUser({ email: "d@x.com", displayName: "Bob" });

    const badAud = await addAudienceMember(999999, u, "admin");
    expect(badAud.ok).toBe(false);
    if (!badAud.ok) expect(badAud.reason).toBe("audience-not-found");

    const badUser = await addAudienceMember(bobAud, 999999, "admin");
    expect(badUser.ok).toBe(false);
    if (!badUser.ok) expect(badUser.reason).toBe("user-not-found");
  });

  it("remove deletes the row + emits member_removed; removing a non-member → not-a-member (no event)", async () => {
    const bobAud = await audienceId("bob");
    const u = await seedUser({ email: "d@x.com", displayName: "Bob" });
    await addAudienceMember(bobAud, u, "admin");

    const removed = await removeAudienceMember(bobAud, u, "admin");
    expect(removed).toBe("ok");
    expect(await listAudienceMembers(bobAud)).toHaveLength(0);

    const again = await removeAudienceMember(bobAud, u, "admin");
    expect(again).toBe("not-a-member");

    const rmEvents = (await listEvents({ viewer: "admin" })).filter(
      (e) => e.kind === "audience.member_removed",
    );
    expect(rmEvents).toHaveLength(1);
  });

  it("remove on an unknown audience → audience-not-found", async () => {
    const u = await seedUser({ email: "d@x.com", displayName: "Bob" });
    expect(await removeAudienceMember(999999, u, "admin")).toBe("audience-not-found");
  });

  it("listAudienceMembers returns null for an unknown audience id", async () => {
    expect(await listAudienceMembers(999999)).toBeNull();
  });

  it("listAllMemberships returns one row per (audience, user), joined to names", async () => {
    const bobAud = await audienceId("bob");
    const u1 = await seedUser({ email: "a@x.com", displayName: "Alice" });
    const u2 = await seedUser({ email: "b@x.com", displayName: "Bob" });
    await addAudienceMember(bobAud, u1, "admin");
    await addAudienceMember(bobAud, u2, "admin");
    const all = await listAllMemberships();
    expect(all).toHaveLength(2);
    expect(all.every((m) => m.audienceKey === "bob")).toBe(true);
    expect(all.map((m) => m.displayName).sort()).toEqual(["Alice", "Bob"]);
  });

  it("setDocAudience changes/ no-ops/ 404s the doc's audience", async () => {
    await publishDoc({
      slug: "d", title: "D", sourcePath: "os/d.md",
      audience: "private", format: "md", content: "# d", by: "admin",
    });
    expect(await setDocAudience("d", "team", "admin")).toBe("ok");
    expect(await setDocAudience("d", "team", "admin")).toBe("noop");
    expect(await setDocAudience("missing", "team", "admin")).toBe("not-found");
  });

  it("deleting an audience with no docs clears its memberships (no orphan rows)", async () => {
    // seed an ad-hoc empty audience, add a member, then delete it.
    await db.insert(schema.audiences).values({ key: "grp", label: "Group", memberVisible: 0 });
    const grp = await audienceId("grp");
    const u = await seedUser({ email: "g@x.com", displayName: "G" });
    await addAudienceMember(grp, u, "admin");
    const { deleteAudience } = await import("./audiences");
    expect(await deleteAudience(grp)).toBe("ok");
    // membership rows for that audience are gone.
    const left = await db
      .select()
      .from(schema.audienceMembers)
      .where(eq(schema.audienceMembers.audienceId, grp));
    expect(left).toHaveLength(0);
  });
});
