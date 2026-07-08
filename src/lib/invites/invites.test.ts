import { describe, it, expect, beforeEach } from "vitest";
import { resetDb } from "@/test/db";
import { db, schema } from "@/db";
import { and, eq } from "drizzle-orm";
import {
  createInvite,
  resolveInvite,
  acceptInvite,
} from "./invites";
import { createSpace, resolveSpaceRole, ownerSlugForSpace } from "@/lib/spaces";

async function seedUser(
  displayName: string,
  opts: { email?: string; tokenName?: string; role?: "admin" | "member" } = {},
): Promise<number> {
  const [u] = await db
    .insert(schema.users)
    .values({
      email: opts.email ?? null,
      tokenName: opts.tokenName ?? null,
      displayName,
      role: opts.role ?? "member",
      active: 1,
    })
    .returning({ id: schema.users.id });
  return u.id;
}

/** Create a space owned by `ownerId` and return its id (Owner-namespace S5:
 * createInvite is keyed by spaceId, not a bare slug). */
async function seedSpace(slug: string, ownerId: number): Promise<number> {
  const out = await createSpace(slug, ownerId, "private", "test");
  if (!out.ok) throw new Error(out.error);
  return out.space.id;
}

describe("invites service", () => {
  let ownerId: number;
  let projId: number;
  beforeEach(async () => {
    await resetDb();
    ownerId = await seedUser("Owner", { email: "owner@desk.test", role: "admin" });
    projId = await seedSpace("proj", ownerId);
  });

  describe("createInvite", () => {
    it("mints a writer invite with a one-time URL + token, default 1 use / 7d", async () => {
      const out = await createInvite({
        spaceId: projId,
        role: "writer",
        createdByUserId: ownerId,
        actorName: "owner@desk.test",
      });
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(out.role).toBe("writer");
      expect(out.maxUses).toBe(1);
      expect(out.token.length).toBeGreaterThan(20);
      expect(out.inviteUrl).toContain(`/invite/${out.token}`);
      // The raw token is never stored — only its hash.
      const row = await db.query.spaceInvites.findFirst({
        where: eq(schema.spaceInvites.id, out.id),
      });
      expect(row?.tokenHash).toBeTruthy();
      expect(row?.tokenHash).not.toBe(out.token);
      // Expiry ~7 days out (default).
      expect(out.expiresAt).not.toBeNull();
    });

    it("honours maxUses, never-expire (null), and a target email", async () => {
      const out = await createInvite({
        spaceId: projId,
        role: "reader",
        createdByUserId: ownerId,
        email: "Partner@Co.COM",
        expiresInDays: null,
        maxUses: 5,
        actorName: "owner@desk.test",
      });
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(out.maxUses).toBe(5);
      expect(out.expiresAt).toBeNull();
      const row = await db.query.spaceInvites.findFirst({
        where: eq(schema.spaceInvites.id, out.id),
      });
      expect(row?.email).toBe("partner@co.com"); // normalized
    });

    it("rejects an unknown space + an invalid maxUses", async () => {
      expect((await createInvite({ spaceId: -1, role: "writer", createdByUserId: ownerId, actorName: "x" })).ok).toBe(false);
      const bad = await createInvite({ spaceId: projId, role: "writer", createdByUserId: ownerId, maxUses: 0, actorName: "x" });
      expect(bad.ok).toBe(false);
    });

    it("emits space.invite_created", async () => {
      await createInvite({ spaceId: projId, role: "writer", createdByUserId: ownerId, actorName: "owner@desk.test" });
      const ev = await db.query.events.findFirst({
        where: eq(schema.events.kind, "space.invite_created"),
      });
      expect(ev).toBeTruthy();
      expect((ev!.payload as { slug: string }).slug).toBe("proj");
    });
  });

  describe("resolveInvite — uniform null on every failure", () => {
    it("resolves a live invite to its space + role", async () => {
      const out = await createInvite({ spaceId: projId, role: "reader", createdByUserId: ownerId, actorName: "x" });
      if (!out.ok) throw new Error("mint failed");
      const r = await resolveInvite(out.token);
      expect(r).not.toBeNull();
      expect(r!.spaceSlug).toBe("proj");
      expect(r!.role).toBe("reader");
    });

    it("null for unknown / blank / bad token", async () => {
      expect(await resolveInvite("totally-unknown")).toBeNull();
      expect(await resolveInvite("")).toBeNull();
      expect(await resolveInvite(null)).toBeNull();
    });

    it("null for an expired invite", async () => {
      const out = await createInvite({ spaceId: projId, role: "writer", createdByUserId: ownerId, actorName: "x" });
      if (!out.ok) throw new Error("mint failed");
      // Force-expire it.
      await db
        .update(schema.spaceInvites)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(schema.spaceInvites.id, out.id));
      expect(await resolveInvite(out.token)).toBeNull();
    });

    it("null for an over-maxUses invite", async () => {
      const out = await createInvite({ spaceId: projId, role: "writer", createdByUserId: ownerId, maxUses: 1, actorName: "x" });
      if (!out.ok) throw new Error("mint failed");
      await db.update(schema.spaceInvites).set({ uses: 1 }).where(eq(schema.spaceInvites.id, out.id));
      expect(await resolveInvite(out.token)).toBeNull();
    });

    it("null for a revoked invite", async () => {
      const out = await createInvite({ spaceId: projId, role: "writer", createdByUserId: ownerId, actorName: "x" });
      if (!out.ok) throw new Error("mint failed");
      await db.update(schema.spaceInvites).set({ revokedAt: new Date() }).where(eq(schema.spaceInvites.id, out.id));
      expect(await resolveInvite(out.token)).toBeNull();
    });
  });

  describe("acceptInvite — NEW email", () => {
    it("creates the user + member + principal token, consumes one use", async () => {
      const out = await createInvite({ spaceId: projId, role: "writer", createdByUserId: ownerId, actorName: "x" });
      if (!out.ok) throw new Error("mint failed");

      const acc = await acceptInvite(out.token, "new@partner.test");
      expect(acc.ok).toBe(true);
      if (!acc.ok) return;
      expect(acc.role).toBe("writer");
      expect(acc.spaceSlug).toBe("proj");
      expect(acc.token.length).toBeGreaterThan(20);

      // A user row exists, scoped member role, and a principal token labelled invite:proj
      const user = await db.query.users.findFirst({ where: eq(schema.users.email, "new@partner.test") });
      expect(user).toBeTruthy();
      expect(user!.role).toBe("member");
      expect(user!.active).toBe(1);

      const space = await db.query.spaces.findFirst({ where: eq(schema.spaces.slug, "proj") });
      const member = await db.query.spaceMembers.findFirst({
        where: and(eq(schema.spaceMembers.spaceId, space!.id), eq(schema.spaceMembers.userId, user!.id)),
      });
      expect(member?.role).toBe("writer");

      const tok = await db.query.principalTokens.findFirst({
        where: eq(schema.principalTokens.userId, user!.id),
      });
      expect(tok?.label).toBe("invite:proj");

      // The use was consumed.
      const invite = await db.query.spaceInvites.findFirst({ where: eq(schema.spaceInvites.id, out.id) });
      expect(invite?.uses).toBe(1);
    });
  });

  describe("acceptInvite — EXISTING email (no dup user, no leak)", () => {
    it("adds membership to the existing user without creating a duplicate", async () => {
      // An existing user with a verified email.
      const existingId = await seedUser("Existing", { email: "exists@partner.test" });
      await db.insert(schema.userEmails).values({ userId: existingId, email: "exists@partner.test" });

      const out = await createInvite({ spaceId: projId, role: "reader", createdByUserId: ownerId, actorName: "x" });
      if (!out.ok) throw new Error("mint failed");

      const acc = await acceptInvite(out.token, "exists@partner.test");
      expect(acc.ok).toBe(true);
      if (!acc.ok) return;
      expect(acc.userId).toBe(existingId);

      // Still exactly one user row for that email.
      const all = await db.select().from(schema.users).where(eq(schema.users.email, "exists@partner.test"));
      expect(all).toHaveLength(1);

      // Membership was added at the invite's role.
      const space = await db.query.spaces.findFirst({ where: eq(schema.spaces.slug, "proj") });
      const member = await db.query.spaceMembers.findFirst({
        where: and(eq(schema.spaceMembers.spaceId, space!.id), eq(schema.spaceMembers.userId, existingId)),
      });
      expect(member?.role).toBe("reader");
    });

    it("returns the SAME outcome shape whether the email existed or not (no existence leak)", async () => {
      const existingId = await seedUser("Existing2", { email: "known@partner.test" });
      await db.insert(schema.userEmails).values({ userId: existingId, email: "known@partner.test" });

      const i1 = await createInvite({ spaceId: projId, role: "writer", createdByUserId: ownerId, actorName: "x" });
      const i2 = await createInvite({ spaceId: projId, role: "writer", createdByUserId: ownerId, actorName: "x" });
      if (!i1.ok || !i2.ok) throw new Error("mint failed");

      const accExisting = await acceptInvite(i1.token, "known@partner.test");
      const accNew = await acceptInvite(i2.token, "brand-new@partner.test");
      // Both succeed; both carry the same keys (token/role/space/handle) — the
      // caller can't tell which email pre-existed.
      expect(accExisting.ok).toBe(true);
      expect(accNew.ok).toBe(true);
      if (!accExisting.ok || !accNew.ok) return;
      expect(Object.keys(accExisting).sort()).toEqual(Object.keys(accNew).sort());
    });

    it("never downgrades an existing OWNER membership", async () => {
      // The space owner accepts their own space's reader invite — must stay owner.
      const out = await createInvite({ spaceId: projId, role: "reader", createdByUserId: ownerId, actorName: "x" });
      if (!out.ok) throw new Error("mint failed");
      // owner@desk.test is the space owner; ensure a user_emails row to resolve them.
      await db.insert(schema.userEmails).values({ userId: ownerId, email: "owner@desk.test" }).onConflictDoNothing();
      const acc = await acceptInvite(out.token, "owner@desk.test");
      expect(acc.ok).toBe(true);
      const space = await db.query.spaces.findFirst({ where: eq(schema.spaces.slug, "proj") });
      const member = await db.query.spaceMembers.findFirst({
        where: and(eq(schema.spaceMembers.spaceId, space!.id), eq(schema.spaceMembers.userId, ownerId)),
      });
      expect(member?.role).toBe("owner"); // not downgraded to reader
    });
  });

  describe("acceptInvite — fail-closed", () => {
    it("unknown / bad token → not-found (no user created)", async () => {
      const before = (await db.select().from(schema.users)).length;
      const acc = await acceptInvite("unknown-token", "x@y.test");
      expect(acc.ok).toBe(false);
      const after = (await db.select().from(schema.users)).length;
      expect(after).toBe(before);
    });

    it("missing/blank email → invalid-email (no use consumed)", async () => {
      const out = await createInvite({ spaceId: projId, role: "writer", createdByUserId: ownerId, actorName: "x" });
      if (!out.ok) throw new Error("mint failed");
      const acc = await acceptInvite(out.token, "   ");
      expect(acc.ok).toBe(false);
      if (acc.ok) return;
      expect(acc.error).toBe("invalid-email");
      const invite = await db.query.spaceInvites.findFirst({ where: eq(schema.spaceInvites.id, out.id) });
      expect(invite?.uses).toBe(0);
    });

    it("expired invite → not-found", async () => {
      const out = await createInvite({ spaceId: projId, role: "writer", createdByUserId: ownerId, actorName: "x" });
      if (!out.ok) throw new Error("mint failed");
      await db.update(schema.spaceInvites).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.spaceInvites.id, out.id));
      expect((await acceptInvite(out.token, "x@y.test")).ok).toBe(false);
    });

    it("over-maxUses → not-found, and the cap is honoured across accepts", async () => {
      const out = await createInvite({ spaceId: projId, role: "reader", createdByUserId: ownerId, maxUses: 1, actorName: "x" });
      if (!out.ok) throw new Error("mint failed");
      const first = await acceptInvite(out.token, "first@p.test");
      expect(first.ok).toBe(true);
      const second = await acceptInvite(out.token, "second@p.test");
      expect(second.ok).toBe(false); // cap reached
    });

    it("revoked invite → not-found", async () => {
      const out = await createInvite({ spaceId: projId, role: "writer", createdByUserId: ownerId, actorName: "x" });
      if (!out.ok) throw new Error("mint failed");
      await db.update(schema.spaceInvites).set({ revokedAt: new Date() }).where(eq(schema.spaceInvites.id, out.id));
      expect((await acceptInvite(out.token, "x@y.test")).ok).toBe(false);
    });
  });

  describe("the minted token AUTHORIZES a git op at the invited role", () => {
    it("a writer invite's token resolves to writer on the space (resolveSpaceRole)", async () => {
      const out = await createInvite({ spaceId: projId, role: "writer", createdByUserId: ownerId, actorName: "x" });
      if (!out.ok) throw new Error("mint failed");
      const acc = await acceptInvite(out.token, "writer@partner.test");
      expect(acc.ok).toBe(true);
      if (!acc.ok) return;

      const space = await db.query.spaces.findFirst({ where: eq(schema.spaces.slug, "proj") });
      const ownerSlug = await ownerSlugForSpace(space!);
      const resolved = await resolveSpaceRole(acc.token, ownerSlug, "proj");
      expect(resolved).not.toBeNull();
      expect(resolved!.role).toBe("writer"); // may push (git-receive-pack)
    });

    it("a reader invite's token resolves to reader (clone-only)", async () => {
      const out = await createInvite({ spaceId: projId, role: "reader", createdByUserId: ownerId, actorName: "x" });
      if (!out.ok) throw new Error("mint failed");
      const acc = await acceptInvite(out.token, "reader@partner.test");
      if (!acc.ok) throw new Error("accept failed");

      const space = await db.query.spaces.findFirst({ where: eq(schema.spaces.slug, "proj") });
      const ownerSlug = await ownerSlugForSpace(space!);
      const resolved = await resolveSpaceRole(acc.token, ownerSlug, "proj");
      expect(resolved!.role).toBe("reader");
    });
  });
});
