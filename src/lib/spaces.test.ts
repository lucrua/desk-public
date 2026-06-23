import { describe, it, expect, beforeEach } from "vitest";
import { resetDb } from "@/test/db";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
import {
  ensureDefaultSpace,
  createSpace,
  getSpaceBySlug,
  resolveSpaceRole,
  roleSatisfies,
  mintPrincipalToken,
  revokePrincipalToken,
  setSpaceMemberRole,
  listSpaces,
  ownerSlugForUser,
  DEFAULT_SPACE_SLUG,
} from "./spaces";

async function seedUser(
  displayName: string,
  opts: { email?: string; tokenName?: string; role?: "admin" | "member"; active?: number } = {},
): Promise<number> {
  const [u] = await db
    .insert(schema.users)
    .values({
      email: opts.email ?? null,
      tokenName: opts.tokenName ?? null,
      displayName,
      role: opts.role ?? "member",
      active: opts.active ?? 1,
    })
    .returning({ id: schema.users.id });
  return u.id;
}

describe("spaces service", () => {
  beforeEach(async () => {
    await resetDb();
  });

  describe("roleSatisfies", () => {
    it("owner ⊇ writer ⊇ reader", () => {
      expect(roleSatisfies("owner", "reader")).toBe(true);
      expect(roleSatisfies("owner", "writer")).toBe(true);
      expect(roleSatisfies("writer", "reader")).toBe(true);
      expect(roleSatisfies("writer", "writer")).toBe(true);
      expect(roleSatisfies("reader", "reader")).toBe(true);
      // and the denials
      expect(roleSatisfies("reader", "writer")).toBe(false);
      expect(roleSatisfies("reader", "owner")).toBe(false);
      expect(roleSatisfies("writer", "owner")).toBe(false);
    });
  });

  describe("ownerSlugForUser", () => {
    it("prefers tokenName, then email local-part, then u<id>", () => {
      expect(ownerSlugForUser({ tokenName: "ci-agent", email: null }, 5)).toBe("ci-agent");
      expect(ownerSlugForUser({ tokenName: null, email: "Lucas@x.com" }, 5)).toBe("lucas");
      expect(ownerSlugForUser(null, 5)).toBe("u5");
      // alphabet-safety
      expect(ownerSlugForUser({ tokenName: "My Agent!!", email: null }, 5)).toBe("my-agent");
    });
  });

  describe("ensureDefaultSpace", () => {
    it("returns null when no user exists to own it", async () => {
      expect(await ensureDefaultSpace()).toBeNull();
    });

    it("creates the workspace space owned by the lowest-id active admin + mirrors owner member", async () => {
      await seedUser("Member", { email: "m@x.com", role: "member" });
      const adminId = await seedUser("Admin", { email: "a@x.com", role: "admin" });
      const space = await ensureDefaultSpace();
      expect(space).not.toBeNull();
      expect(space!.slug).toBe(DEFAULT_SPACE_SLUG);
      expect(space!.ownerUserId).toBe(adminId);
      expect(space!.visibility).toBe("private");
      const member = await db.query.spaceMembers.findFirst({
        where: eq(schema.spaceMembers.spaceId, space!.id),
      });
      expect(member?.role).toBe("owner");
      expect(member?.userId).toBe(adminId);
    });

    it("is idempotent (second call returns the same row, no duplicate)", async () => {
      await seedUser("Admin", { email: "a@x.com", role: "admin" });
      const a = await ensureDefaultSpace();
      const b = await ensureDefaultSpace();
      expect(a!.id).toBe(b!.id);
      const all = await db.select().from(schema.spaces);
      expect(all).toHaveLength(1);
    });
  });

  describe("createSpace", () => {
    it("rejects an invalid slug", async () => {
      const owner = await seedUser("Owner", { email: "o@x.com", role: "admin" });
      const out = await createSpace("Bad Slug", owner, "private", "tester");
      expect(out.ok).toBe(false);
    });

    it("creates a space + owner member + emits space.created", async () => {
      const owner = await seedUser("Owner", { email: "o@x.com", role: "admin" });
      const out = await createSpace("proj", owner, "unlisted", "tester");
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(out.space.slug).toBe("proj");
      expect(out.space.visibility).toBe("unlisted");
      const member = await db.query.spaceMembers.findFirst({
        where: eq(schema.spaceMembers.spaceId, out.space.id),
      });
      expect(member?.role).toBe("owner");
      const evs = await db.select().from(schema.events).where(eq(schema.events.kind, "space.created"));
      expect(evs.length).toBe(1);
    });

    it("rejects a duplicate slug", async () => {
      const owner = await seedUser("Owner", { email: "o@x.com", role: "admin" });
      await createSpace("dup", owner, "private", "tester");
      const out = await createSpace("dup", owner, "private", "tester");
      expect(out.ok).toBe(false);
    });
  });

  // ── THE git-transport authz matrix (fail-closed) ────────────────────────────
  describe("resolveSpaceRole — the git auth boundary", () => {
    let ownerId: number;
    let writerId: number;
    let readerId: number;
    let strangerId: number;
    let ownerSlug: string;
    let ownerToken: string;
    let writerToken: string;
    let readerToken: string;
    let strangerToken: string;

    beforeEach(async () => {
      ownerId = await seedUser("Owner", { tokenName: "owner", role: "admin" });
      writerId = await seedUser("Writer", { tokenName: "writer", role: "member" });
      readerId = await seedUser("Reader", { tokenName: "reader", role: "member" });
      strangerId = await seedUser("Stranger", { tokenName: "stranger", role: "member" });

      const created = await createSpace("acme", ownerId, "private", "tester");
      if (!created.ok) throw new Error("setup failed");
      // owner-segment = the owner's tokenName-derived slug.
      ownerSlug = ownerSlugForUser({ tokenName: "owner", email: null }, ownerId);

      await setSpaceMemberRole("acme", writerId, "writer", "tester");
      await setSpaceMemberRole("acme", readerId, "reader", "tester");
      // stranger gets NO membership.

      ownerToken = (await mintPrincipalToken(ownerId, "owner-tok")).token;
      writerToken = (await mintPrincipalToken(writerId, "writer-tok")).token;
      readerToken = (await mintPrincipalToken(readerId, "reader-tok")).token;
      strangerToken = (await mintPrincipalToken(strangerId, "stranger-tok")).token;
    });

    it("owner token → owner role", async () => {
      const r = await resolveSpaceRole(ownerToken, ownerSlug, "acme");
      expect(r?.role).toBe("owner");
    });

    it("writer token → writer role (push-capable)", async () => {
      const r = await resolveSpaceRole(writerToken, ownerSlug, "acme");
      expect(r?.role).toBe("writer");
      expect(roleSatisfies(r!.role, "writer")).toBe(true);
    });

    it("reader token → reader role (clone-only)", async () => {
      const r = await resolveSpaceRole(readerToken, ownerSlug, "acme");
      expect(r?.role).toBe("reader");
      expect(roleSatisfies(r!.role, "writer")).toBe(false); // cannot push
      expect(roleSatisfies(r!.role, "reader")).toBe(true);
    });

    it("stranger token (no membership) → null (fail-closed)", async () => {
      expect(await resolveSpaceRole(strangerToken, ownerSlug, "acme")).toBeNull();
    });

    it("no token → null", async () => {
      expect(await resolveSpaceRole(null, ownerSlug, "acme")).toBeNull();
      expect(await resolveSpaceRole("", ownerSlug, "acme")).toBeNull();
    });

    it("unknown token → null", async () => {
      expect(await resolveSpaceRole("not-a-real-token", ownerSlug, "acme")).toBeNull();
    });

    it("revoked token → null", async () => {
      // Find + revoke the reader's token id.
      const tokRows = await db.select().from(schema.principalTokens).where(eq(schema.principalTokens.userId, readerId));
      await revokePrincipalToken(tokRows[0].id);
      expect(await resolveSpaceRole(readerToken, ownerSlug, "acme")).toBeNull();
    });

    it("inactive user → null even with a valid token", async () => {
      await db.update(schema.users).set({ active: 0 }).where(eq(schema.users.id, readerId));
      expect(await resolveSpaceRole(readerToken, ownerSlug, "acme")).toBeNull();
    });

    it("unknown space slug → null", async () => {
      expect(await resolveSpaceRole(ownerToken, ownerSlug, "does-not-exist")).toBeNull();
    });

    it("wrong owner segment → null (no cross-owner resolution)", async () => {
      expect(await resolveSpaceRole(ownerToken, "someone-else", "acme")).toBeNull();
    });

    it("bumps lastUsedAt on success", async () => {
      const before = await db.select().from(schema.principalTokens).where(eq(schema.principalTokens.userId, ownerId));
      expect(before[0].lastUsedAt).toBeNull();
      await resolveSpaceRole(ownerToken, ownerSlug, "acme");
      const after = await db.select().from(schema.principalTokens).where(eq(schema.principalTokens.userId, ownerId));
      expect(after[0].lastUsedAt).not.toBeNull();
    });
  });

  describe("setSpaceMemberRole", () => {
    it("guards the owner (cannot demote/remove the space owner)", async () => {
      const owner = await seedUser("Owner", { email: "o@x.com", role: "admin" });
      await createSpace("g", owner, "private", "tester");
      const out = await setSpaceMemberRole("g", owner, "reader", "tester");
      expect(out.ok).toBe(false);
    });

    it("adds, updates, then removes a member role + emits events", async () => {
      const owner = await seedUser("Owner", { email: "o@x.com", role: "admin" });
      const u = await seedUser("U", { email: "u@x.com" });
      await createSpace("g", owner, "private", "tester");

      const add = await setSpaceMemberRole("g", u, "reader", "tester");
      expect(add.ok && add.role).toBe("reader");
      const up = await setSpaceMemberRole("g", u, "writer", "tester");
      expect(up.ok && up.role).toBe("writer");
      const rm = await setSpaceMemberRole("g", u, null, "tester");
      expect(rm.ok && rm.role).toBe(null);
      const member = await db.query.spaceMembers.findFirst({
        where: eq(schema.spaceMembers.userId, u),
      });
      expect(member).toBeUndefined();
    });
  });

  describe("listSpaces", () => {
    it("admins see all; non-members see none; members see theirs", async () => {
      const owner = await seedUser("Owner", { email: "o@x.com", role: "admin" });
      const member = await seedUser("M", { email: "m@x.com" });
      const stranger = await seedUser("S", { email: "s@x.com" });
      const sp = await createSpace("only", owner, "private", "tester");
      if (!sp.ok) throw new Error("setup");
      await setSpaceMemberRole("only", member, "reader", "tester");

      expect((await listSpaces({ isAdmin: true })).length).toBe(1);
      expect((await listSpaces({ isAdmin: false, userId: member })).length).toBe(1);
      expect((await listSpaces({ isAdmin: false, userId: stranger })).length).toBe(0);
      expect((await listSpaces({ isAdmin: false, userId: null })).length).toBe(0);
    });
  });

  describe("getSpaceBySlug", () => {
    it("returns null for an unknown slug", async () => {
      expect(await getSpaceBySlug("nope")).toBeNull();
    });
  });
});
