import { describe, it, expect, beforeEach } from "vitest";
import { resetDb } from "@/test/db";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
import { createSpace, setSpacePushPolicy, getSpaceBySlug } from "@/lib/spaces";

async function seedAdmin(): Promise<number> {
  const [u] = await db
    .insert(schema.users)
    .values({ tokenName: "admin", displayName: "Admin", role: "admin", active: 1 })
    .returning({ id: schema.users.id });
  return u.id;
}

describe("space push_policy", () => {
  let ownerId: number;
  beforeEach(async () => {
    await resetDb();
    ownerId = await seedAdmin();
  });

  it("defaults to 'direct' on a new space", async () => {
    const out = await createSpace("proj", ownerId, "private", "test");
    expect(out.ok).toBe(true);
    const space = await getSpaceBySlug("proj");
    expect(space?.pushPolicy).toBe("direct");
  });

  it("setSpacePushPolicy flips it to 'proposal' (and back), emitting space.updated", async () => {
    await createSpace("proj", ownerId, "private", "test");

    const ok = await setSpacePushPolicy("proj", "proposal", "test");
    expect(ok).toBe(true);
    expect((await getSpaceBySlug("proj"))?.pushPolicy).toBe("proposal");

    await setSpacePushPolicy("proj", "direct", "test");
    expect((await getSpaceBySlug("proj"))?.pushPolicy).toBe("direct");

    const ev = await db.query.events.findFirst({
      where: eq(schema.events.kind, "space.updated"),
    });
    expect(ev).toBeTruthy();
  });

  it("returns false for an unknown space", async () => {
    expect(await setSpacePushPolicy("nope", "proposal", "test")).toBe(false);
  });
});
