import { describe, it, expect, beforeEach } from "vitest";
import { resetDb, seedUser } from "@/test/db";
import { db, schema } from "@/db";
import { eq, sql } from "drizzle-orm";
import {
  listUsers,
  createUser,
  setUserActive,
  setUserRole,
  setUserTokenName,
  setUserDisplayName,
  listUserEmails,
  addUserEmail,
  removeUserEmail,
  applyAdminMutation,
  countActiveAdmins,
} from "./users";

describe("users service", () => {
  beforeEach(async () => {
    await resetDb();
  });

  // ── createUser ───────────────────────────────────────────────────────────

  describe("createUser", () => {
    it("creates a human user (email only) → row with member default role", async () => {
      const u = await createUser({ email: "bob@example.com", displayName: "Bob", role: "member" });
      expect(u).not.toBeNull();
      expect(u!.email).toBe("bob@example.com");
      expect(u!.tokenName).toBeNull();
      expect(u!.displayName).toBe("Bob");
      expect(u!.role).toBe("member");
      expect(u!.active).toBe(1);
      expect(typeof u!.id).toBe("number");
    });

    it("creates an agent user (tokenName only) with default role=member", async () => {
      // Default role is member; the public API surfaces always pass member,
      // but the createUser fn accepts an explicit role (used by bootstrap path).
      const u = await createUser({ tokenName: "ci-publisher", displayName: "repo CI" });
      expect(u).not.toBeNull();
      expect(u!.email).toBeNull();
      expect(u!.tokenName).toBe("ci-publisher");
      expect(u!.role).toBe("member");
    });

    it("createUser respects an explicit role='admin' (used by bootstrap path)", async () => {
      const u = await createUser({ tokenName: "admin-agent", displayName: "Admin Agent", role: "admin" });
      expect(u).not.toBeNull();
      expect(u!.role).toBe("admin");
    });

    it("normalizes email: lowercase + trim", async () => {
      const u = await createUser({ email: "  Alice@Example.COM  ", displayName: "Alice", role: "member" });
      expect(u).not.toBeNull();
      expect(u!.email).toBe("alice@example.com");
    });

    it("returns null when NEITHER email nor tokenName provided", async () => {
      const u = await createUser({ displayName: "Nobody", role: "member" });
      expect(u).toBeNull();
    });

    it("treats empty/whitespace email + empty tokenName as neither → null", async () => {
      const u = await createUser({ email: "   ", tokenName: "  ", displayName: "Nobody", role: "member" });
      expect(u).toBeNull();
    });

    it("duplicate email → null (already exists)", async () => {
      await createUser({ email: "dup@example.com", displayName: "First", role: "member" });
      const second = await createUser({ email: "dup@example.com", displayName: "Second", role: "member" });
      expect(second).toBeNull();
    });

    it("duplicate email is case-insensitive (normalized) → null", async () => {
      await createUser({ email: "dup@example.com", displayName: "First", role: "member" });
      const second = await createUser({ email: "DUP@EXAMPLE.COM", displayName: "Second", role: "member" });
      expect(second).toBeNull();
    });

    it("duplicate tokenName → null (already exists)", async () => {
      await createUser({ tokenName: "agent-x", displayName: "First", role: "member" });
      const second = await createUser({ tokenName: "agent-x", displayName: "Second", role: "member" });
      expect(second).toBeNull();
    });
  });

  // ── listUsers ────────────────────────────────────────────────────────────

  describe("listUsers", () => {
    it("returns [] when no users", async () => {
      expect(await listUsers()).toEqual([]);
    });

    it("returns users newest-first", async () => {
      const a = await createUser({ email: "a@example.com", displayName: "A", role: "member" });
      const b = await createUser({ email: "b@example.com", displayName: "B", role: "admin" });
      const list = await listUsers();
      expect(list).toHaveLength(2);
      // newest (higher id) first
      expect(list[0].id).toBe(b!.id);
      expect(list[1].id).toBe(a!.id);
      expect(list[0]).toMatchObject({
        email: "b@example.com",
        displayName: "B",
        // createUser stores the given role (multi-admin model v2).
        role: "admin",
        active: 1,
      });
      expect(list[0].createdAt).toBeInstanceOf(Date);
    });
  });

  // ── setUserActive ──────────────────────────────────────────────────────────

  describe("setUserActive", () => {
    it("deactivate then reactivate", async () => {
      const u = await createUser({ email: "x@example.com", displayName: "X", role: "member" });
      expect(await setUserActive(u!.id, false)).toBe(true);
      let list = await listUsers();
      expect(list[0].active).toBe(0);
      expect(await setUserActive(u!.id, true)).toBe(true);
      list = await listUsers();
      expect(list[0].active).toBe(1);
    });

    it("returns false for unknown id", async () => {
      expect(await setUserActive(99999, false)).toBe(false);
    });
  });

  // ── setUserRole ────────────────────────────────────────────────────────────

  describe("setUserRole", () => {
    it("flips member → admin and back", async () => {
      const u = await createUser({ email: "r@example.com", displayName: "R", role: "member" });
      expect(await setUserRole(u!.id, "admin")).toBe(true);
      expect((await listUsers())[0].role).toBe("admin");
      expect(await setUserRole(u!.id, "member")).toBe(true);
      expect((await listUsers())[0].role).toBe("member");
    });

    it("returns false for unknown id", async () => {
      expect(await setUserRole(99999, "admin")).toBe(false);
    });
  });

  // ── setUserTokenName ───────────────────────────────────────────────────────

  describe("setUserTokenName", () => {
    it("sets a token on a user → ok + value persisted", async () => {
      const u = await createUser({ email: "tok@example.com", displayName: "Tok", role: "member" });
      const result = await setUserTokenName(u!.id, "client-id-abc");
      expect(result).toBe("ok");
      const row = (await listUsers())[0];
      expect(row.tokenName).toBe("client-id-abc");
    });

    it("trims whitespace before saving", async () => {
      const u = await createUser({ email: "trim@example.com", displayName: "Trim", role: "member" });
      await setUserTokenName(u!.id, "  padded  ");
      expect((await listUsers())[0].tokenName).toBe("padded");
    });

    it("clears token when null passed → ok + null persisted", async () => {
      const u = await createUser({ tokenName: "old-token", displayName: "Agent", role: "member" });
      const result = await setUserTokenName(u!.id, null);
      expect(result).toBe("ok");
      expect((await listUsers())[0].tokenName).toBeNull();
    });

    it("clears token when empty string passed → ok + null persisted", async () => {
      const u = await createUser({ tokenName: "old-token2", displayName: "Agent2", role: "member" });
      const result = await setUserTokenName(u!.id, "");
      expect(result).toBe("ok");
      expect((await listUsers())[0].tokenName).toBeNull();
    });

    it("duplicate tokenName → duplicate", async () => {
      const a = await createUser({ tokenName: "taken", displayName: "A", role: "member" });
      const b = await createUser({ email: "b@example.com", displayName: "B", role: "member" });
      const result = await setUserTokenName(b!.id, "taken");
      expect(result).toBe("duplicate");
      // b's tokenName unchanged
      expect((await listUsers()).find((r) => r.id === b!.id)!.tokenName).toBeNull();
      // a's tokenName untouched
      expect((await listUsers()).find((r) => r.id === a!.id)!.tokenName).toBe("taken");
    });

    it("not-found for unknown id", async () => {
      const result = await setUserTokenName(99999, "anything");
      expect(result).toBe("not-found");
    });
  });

  // ── setUserDisplayName ───────────────────────────────────────────────────────

  describe("setUserDisplayName", () => {
    it("renames a user → ok + value persisted", async () => {
      const u = await createUser({ email: "n@example.com", displayName: "Old" });
      const result = await setUserDisplayName(u!.id, "New Name");
      expect(result).toBe("ok");
      expect((await listUsers())[0].displayName).toBe("New Name");
    });

    it("trims whitespace before saving", async () => {
      const u = await createUser({ email: "n2@example.com", displayName: "Old" });
      await setUserDisplayName(u!.id, "  Padded  ");
      expect((await listUsers())[0].displayName).toBe("Padded");
    });

    it("does not touch the email (immutable)", async () => {
      const u = await createUser({ email: "keep@example.com", displayName: "Keep" });
      await setUserDisplayName(u!.id, "Renamed");
      expect((await listUsers())[0].email).toBe("keep@example.com");
    });

    it("empty/whitespace name → not-found (caller should 400 before calling)", async () => {
      const u = await createUser({ email: "e@example.com", displayName: "Stay" });
      expect(await setUserDisplayName(u!.id, "   ")).toBe("not-found");
      // name unchanged
      expect((await listUsers())[0].displayName).toBe("Stay");
    });

    it("not-found for unknown id", async () => {
      expect(await setUserDisplayName(99999, "Whoever")).toBe("not-found");
    });
  });

  // ── multiple emails per user ─────────────────────────────────────────────

  describe("email management", () => {
    async function emailEvents() {
      return db
        .select()
        .from(schema.events)
        .where(eq(schema.events.kind, "user.email_added"));
    }

    it("createUser mirrors the primary email into user_emails", async () => {
      const u = await createUser({ email: "Primary@Example.com", displayName: "P" });
      const list = await listUserEmails(u!.id);
      expect(list).not.toBeNull();
      expect(list!).toHaveLength(1);
      expect(list![0].email).toBe("primary@example.com");
      expect(list![0].primary).toBe(true);
    });

    it("token-only user has no email row", async () => {
      const u = await createUser({ tokenName: "agent", displayName: "Agent" });
      expect(await listUserEmails(u!.id)).toHaveLength(0);
    });

    it("addUserEmail adds an alias, flags only the primary, emits an event", async () => {
      const u = await createUser({ email: "p@example.com", displayName: "P" });
      expect(await addUserEmail(u!.id, "  Alias@Example.com ", "Admin")).toBe("ok");
      const list = await listUserEmails(u!.id);
      expect(list!.map((e) => e.email).sort()).toEqual([
        "alias@example.com",
        "p@example.com",
      ]);
      expect(list!.find((e) => e.email === "p@example.com")!.primary).toBe(true);
      expect(list!.find((e) => e.email === "alias@example.com")!.primary).toBe(false);
      const evts = await emailEvents();
      expect(evts).toHaveLength(1);
      expect((evts[0].payload as { email: string }).email).toBe("alias@example.com");
      expect(evts[0].actorName).toBe("Admin");
    });

    it("addUserEmail → duplicate when the email belongs to ANY user (no steal)", async () => {
      const a = await createUser({ email: "a@example.com", displayName: "A" });
      const b = await createUser({ email: "b@example.com", displayName: "B" });
      // b's own primary is taken; and a's primary is taken by a.
      expect(await addUserEmail(b!.id, "a@example.com")).toBe("duplicate");
      // a still has exactly its one primary, b still has its one primary.
      expect(await listUserEmails(a!.id)).toHaveLength(1);
      expect(await listUserEmails(b!.id)).toHaveLength(1);
      // no event written for the failed add
      expect(await emailEvents()).toHaveLength(0);
    });

    it("addUserEmail → not-found for unknown user; invalid for empty email", async () => {
      expect(await addUserEmail(99999, "x@example.com")).toBe("not-found");
      const u = await createUser({ email: "p@example.com", displayName: "P" });
      expect(await addUserEmail(u!.id, "   ")).toBe("invalid");
    });

    it("removeUserEmail → last-email blocks the last email of a token-less user", async () => {
      const u = await createUser({ email: "only@example.com", displayName: "Only" });
      expect(await removeUserEmail(u!.id, "only@example.com")).toBe("last-email");
      expect(await listUserEmails(u!.id)).toHaveLength(1);
    });

    it("removeUserEmail → ok when the user keeps another email; repoints primary", async () => {
      const u = await createUser({ email: "primary@example.com", displayName: "P" });
      await addUserEmail(u!.id, "secondary@example.com");
      // Remove the PRIMARY — users.email must repoint to the remaining one.
      expect(await removeUserEmail(u!.id, "primary@example.com")).toBe("ok");
      const list = await listUserEmails(u!.id);
      expect(list!.map((e) => e.email)).toEqual(["secondary@example.com"]);
      expect(list![0].primary).toBe(true);
      const row = await db.query.users.findFirst({ where: eq(schema.users.id, u!.id) });
      expect(row!.email).toBe("secondary@example.com");
    });

    it("removeUserEmail → ok dropping a token-ful user to zero emails (sets users.email null)", async () => {
      const u = await createUser({ email: "agent@example.com", tokenName: "agent", displayName: "Agent" });
      expect(await removeUserEmail(u!.id, "agent@example.com")).toBe("ok");
      expect(await listUserEmails(u!.id)).toHaveLength(0);
      const row = await db.query.users.findFirst({ where: eq(schema.users.id, u!.id) });
      expect(row!.email).toBeNull();
      const removed = await db
        .select()
        .from(schema.events)
        .where(eq(schema.events.kind, "user.email_removed"));
      expect(removed).toHaveLength(1);
    });

    it("removeUserEmail → not-found for unknown user or email not on this user", async () => {
      const u = await createUser({ email: "p@example.com", displayName: "P" });
      expect(await removeUserEmail(99999, "p@example.com")).toBe("not-found");
      expect(await removeUserEmail(u!.id, "nope@example.com")).toBe("not-found");
    });

    it("listUserEmails → null for unknown user", async () => {
      expect(await listUserEmails(99999)).toBeNull();
    });
  });

  // ── BUG 2: last-admin TOCTOU race (atomic guard under advisory lock) ─────────
  describe("applyAdminMutation — last-admin guard (atomic, lock-serialized)", () => {
    it("applies a demote when another active admin remains", async () => {
      await seedUser({ email: "a@x.com", displayName: "A", role: "admin" });
      const bId = await seedUser({ email: "b@x.com", displayName: "B", role: "admin" });
      expect(await applyAdminMutation(bId, { newRole: "member" })).toBe("ok");
      expect(await countActiveAdmins()).toBe(1);
    });

    it("rejects demoting the ONLY active admin (returns last-admin, writes nothing)", async () => {
      const aId = await seedUser({ email: "a@x.com", displayName: "A", role: "admin" });
      expect(await applyAdminMutation(aId, { newRole: "member" })).toBe("last-admin");
      // No write happened — still an admin.
      expect(await countActiveAdmins()).toBe(1);
      const [a] = await db.select().from(schema.users).where(eq(schema.users.id, aId));
      expect(a.role).toBe("admin");
    });

    it("rejects deactivating the ONLY active admin", async () => {
      const aId = await seedUser({ email: "a@x.com", displayName: "A", role: "admin" });
      expect(await applyAdminMutation(aId, { active: false })).toBe("last-admin");
      expect(await countActiveAdmins()).toBe(1);
    });

    it("BUG 2 — concurrent cross-demote/deactivate cannot zero out admins (lock serializes the guard)", async () => {
      // FAITHFUL race reproduction at the DB layer. Two active admins A and B.
      // Admin A demotes B; concurrently admin B deactivates A. Under the original
      // check-then-act (count admins, THEN mutate in a separate statement), BOTH
      // mutations read count=2, BOTH proceed → ZERO admins (full lockout).
      //
      // We reproduce the concurrency exactly: open one mutation, PARK it
      // mid-transaction while it holds the admin-set advisory lock + has applied
      // its write but not committed, then fire the second mutation. The second
      // must BLOCK on the lock (can't read stale count), and once the first
      // commits it must re-count INSIDE the lock, see count=1, and be REJECTED.
      const aId = await seedUser({ email: "a@x.com", displayName: "A", role: "admin" });
      const bId = await seedUser({ email: "b@x.com", displayName: "B", role: "admin" });
      const LOCK_KEY = 911_478_002; // must equal ADMIN_SET_ADVISORY_LOCK_KEY in users.ts

      // First mutation (A demotes B), hand-rolled so we can hold it mid-flight.
      let release!: () => void;
      const done = new Promise<void>((r) => (release = r));
      let ready!: () => void;
      const readyP = new Promise<void>((r) => (ready = r));

      const firstTx = db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${LOCK_KEY})`);
        // It re-counts (2 admins) inside the lock → allowed → demote B.
        const [{ cnt }] = await tx
          .select({ cnt: sql<number>`count(*)::int` })
          .from(schema.users)
          .where(sql`role = 'admin' AND active = 1`);
        expect(cnt).toBe(2);
        await tx.update(schema.users).set({ role: "member" }).where(eq(schema.users.id, bId));
        ready();
        await done; // hold the lock + uncommitted write
      });

      await readyP;

      // Second mutation (B deactivates A) via the REAL guarded path. It must
      // block on the advisory lock the first tx holds.
      const secondPromise = applyAdminMutation(aId, { active: false });

      // Prove it's genuinely blocked — it must not resolve while the lock is held.
      const sentinel = Symbol("pending");
      const raced = await Promise.race([
        secondPromise,
        new Promise((r) => setTimeout(() => r(sentinel), 300)),
      ]);
      expect(raced).toBe(sentinel);

      // Commit the first mutation (B is now a member; only A is admin) + release.
      release();
      await firstTx;

      // Second mutation acquires the lock, re-counts INSIDE it (now 1 admin: A),
      // and is rejected — A is NOT deactivated.
      expect(await secondPromise).toBe("last-admin");

      // Invariant holds: at least one active admin (exactly A).
      expect(await countActiveAdmins()).toBe(1);
      const [a] = await db.select().from(schema.users).where(eq(schema.users.id, aId));
      expect(a.role).toBe("admin");
      expect(a.active).toBe(1);
    });
  });
});
