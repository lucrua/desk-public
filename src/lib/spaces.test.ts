import { describe, it, expect, beforeEach } from "vitest";
import { resetDb } from "@/test/db";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
import {
  ensureDefaultSpace,
  createSpace,
  getSpace,
  getSpaceByOwner,
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

    it("rejects a duplicate slug FOR THE SAME OWNER (slug already in use)", async () => {
      const owner = await seedUser("Owner", { email: "o@x.com", role: "admin" });
      await createSpace("dup", owner, "private", "tester");
      const out = await createSpace("dup", owner, "private", "tester");
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.error).toBe("slug already in use");
    });

    // ── S3 (D2): the composite key lets TWO owners share a slug ────────────────
    it("two DIFFERENT owners may each own the same slug — both creates succeed", async () => {
      const alice = await seedUser("Alice", { tokenName: "alice", role: "admin" });
      const bob = await seedUser("Bob", { tokenName: "bob", role: "admin" });
      const a = await createSpace("reports", alice, "private", "tester");
      const b = await createSpace("reports", bob, "private", "tester");
      expect(a.ok).toBe(true);
      expect(b.ok).toBe(true);
      if (!a.ok || !b.ok) return;
      // Two DISTINCT rows, each owned by the right user.
      expect(a.space.id).not.toBe(b.space.id);
      expect(a.space.ownerUserId).toBe(alice);
      expect(b.space.ownerUserId).toBe(bob);
      // A third `reports` for alice still collides (per-owner uniqueness holds).
      const dupA = await createSpace("reports", alice, "private", "tester");
      expect(dupA.ok).toBe(false);
    });

    it("assigns the owner a handle so the new space is namespace-reachable", async () => {
      const owner = await seedUser("Owner", { tokenName: "owner-x", role: "admin" });
      const out = await createSpace("thing", owner, "private", "tester");
      expect(out.ok).toBe(true);
      const row = await db.query.users.findFirst({ where: eq(schema.users.id, owner) });
      expect(row?.handle).toBe("owner-x"); // derived from tokenName, matches ownerSlugForUser
    });
  });

  // ── THE canonical resolver + two-owner isolation (S3, D2/D4) ────────────────
  describe("getSpace(handle, slug) — composite resolution + two-owner isolation", () => {
    let alice: number;
    let bob: number;
    let aliceReports: number;
    let bobReports: number;

    beforeEach(async () => {
      alice = await seedUser("Alice", { tokenName: "alice", role: "admin" });
      bob = await seedUser("Bob", { tokenName: "bob", role: "admin" });
      const a = await createSpace("reports", alice, "private", "tester");
      const b = await createSpace("reports", bob, "private", "tester");
      if (!a.ok || !b.ok) throw new Error("setup failed");
      aliceReports = a.space.id;
      bobReports = b.space.id;
    });

    it("resolves each owner's same-slug space to a DIFFERENT space", async () => {
      const a = await getSpace("alice", "reports");
      const b = await getSpace("bob", "reports");
      expect(a?.id).toBe(aliceReports);
      expect(b?.id).toBe(bobReports);
      expect(a!.id).not.toBe(b!.id);
      expect(a!.ownerUserId).toBe(alice);
      expect(b!.ownerUserId).toBe(bob);
    });

    it("is case-insensitive on the handle (handles are stored lowercased)", async () => {
      const a = await getSpace("ALICE", "reports");
      expect(a?.id).toBe(aliceReports);
    });

    it("unknown handle → null (no existence leak)", async () => {
      expect(await getSpace("carol", "reports")).toBeNull();
      expect(await getSpace("", "reports")).toBeNull();
    });

    it("known handle but that owner has no such slug → null", async () => {
      expect(await getSpace("alice", "ghost")).toBeNull();
      // bob has `reports` but NOT `budget`; alice does not have `budget` either.
      expect(await getSpace("bob", "budget")).toBeNull();
    });

    it("getSpaceByOwner isolates by (ownerUserId, slug)", async () => {
      expect((await getSpaceByOwner(alice, "reports"))?.id).toBe(aliceReports);
      expect((await getSpaceByOwner(bob, "reports"))?.id).toBe(bobReports);
      expect(await getSpaceByOwner(alice, "nope")).toBeNull();
    });

    it("getSpaceBySlug is AMBIGUITY-GUARDED: two same-slug spaces → null (transitional)", async () => {
      // Two owners hold `reports` → a bare slug is ambiguous → null (fail-closed,
      // never an arbitrary winner). It resolves again once only one remains.
      expect(await getSpaceBySlug("reports")).toBeNull();
      // Remove bob's space → now unique → resolves to alice's.
      await db.delete(schema.spaceMembers).where(eq(schema.spaceMembers.spaceId, bobReports));
      await db.delete(schema.spaces).where(eq(schema.spaces.id, bobReports));
      expect((await getSpaceBySlug("reports"))?.id).toBe(aliceReports);
    });
  });

  // ── Two owners, same slug, ISOLATED across the git write boundary ───────────
  describe("resolveSpaceRole — two same-slug owners are isolated (S3)", () => {
    let alice: number;
    let bob: number;
    let aliceWriter: number;
    let aliceReports: number;
    let bobReports: number;
    let aliceWriterTok: string;
    let bobOwnerTok: string;

    beforeEach(async () => {
      alice = await seedUser("Alice", { tokenName: "alice", role: "admin" });
      bob = await seedUser("Bob", { tokenName: "bob", role: "admin" });
      aliceWriter = await seedUser("AliceWriter", { tokenName: "awr", role: "member" });
      const a = await createSpace("reports", alice, "private", "tester");
      const b = await createSpace("reports", bob, "private", "tester");
      if (!a.ok || !b.ok) throw new Error("setup failed");
      aliceReports = a.space.id;
      bobReports = b.space.id;
      // NB: `reports` is now an ambiguous slug (two owners), so the slug-based
      // setSpaceMemberRole is a no-op here — memberships are seeded by space id.
    });

    it("owner tokens resolve to the RIGHT (owner-specific) space", async () => {
      bobOwnerTok = (await mintPrincipalToken(bob, "t")).token;
      const aliceOwnerTok = (await mintPrincipalToken(alice, "t")).token;
      const ra = await resolveSpaceRole(aliceOwnerTok, "alice", "reports");
      const rb = await resolveSpaceRole(bobOwnerTok, "bob", "reports");
      expect(ra?.space.id).toBe(aliceReports);
      expect(rb?.space.id).toBe(bobReports);
      expect(ra?.role).toBe("owner");
      expect(rb?.role).toBe("owner");
    });

    it("a writer on ALICE's reports is DENIED on BOB's same-slug reports (404)", async () => {
      // alice's writer needs a membership on alice's space — add it directly by id
      // (setSpaceMemberRole resolves by ambiguous slug now, so seed the row).
      await db
        .insert(schema.spaceMembers)
        .values({ spaceId: aliceReports, userId: aliceWriter, role: "writer" })
        .onConflictDoNothing();
      aliceWriterTok = (await mintPrincipalToken(aliceWriter, "t")).token;
      // Resolves on alice/reports (has membership there)...
      const onAlice = await resolveSpaceRole(aliceWriterTok, "alice", "reports");
      expect(onAlice?.space.id).toBe(aliceReports);
      expect(onAlice?.role).toBe("writer");
      // ...but is fail-closed on bob/reports (no membership on bob's space).
      expect(await resolveSpaceRole(aliceWriterTok, "bob", "reports")).toBeNull();
    });

    it("bob's owner token is DENIED on alice/reports (cross-owner, no membership)", async () => {
      bobOwnerTok = (await mintPrincipalToken(bob, "t")).token;
      expect(await resolveSpaceRole(bobOwnerTok, "alice", "reports")).toBeNull();
    });

    it("unknown handle segment → null even with a valid token", async () => {
      const aliceOwnerTok = (await mintPrincipalToken(alice, "t")).token;
      expect(await resolveSpaceRole(aliceOwnerTok, "carol", "reports")).toBeNull();
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
