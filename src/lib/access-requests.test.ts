import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { resetDb } from "@/test/db";
import { createUser, listUsers, listUserEmails } from "./users";
import {
  listAccessRequests,
  approveAccessRequest,
  dismissAccessRequest,
} from "./access-requests";

/** Insert an access_requests row directly (the auth layer's upsert is tested elsewhere). */
async function seedRequest(email: string, hits = 1) {
  const [row] = await db
    .insert(schema.accessRequests)
    .values({ email, hits })
    .returning();
  return row;
}

describe("access-requests service", () => {
  beforeEach(async () => {
    await resetDb();
  });

  // ── listAccessRequests ─────────────────────────────────────────────────────

  describe("listAccessRequests", () => {
    it("returns [] when none", async () => {
      expect(await listAccessRequests()).toEqual([]);
    });

    it("returns rows with all fields", async () => {
      await seedRequest("visitor@example.com", 3);
      const list = await listAccessRequests();
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ email: "visitor@example.com", hits: 3 });
      expect(list[0].firstSeenAt).toBeInstanceOf(Date);
      expect(list[0].lastSeenAt).toBeInstanceOf(Date);
      expect(typeof list[0].id).toBe("number");
    });
  });

  // ── approveAccessRequest ────────────────────────────────────────────────────

  describe("approveAccessRequest", () => {
    it("creates a member user + deletes the request → ok", async () => {
      const req = await seedRequest("dani@example.com");
      const result = await approveAccessRequest(req.id);
      expect(result.status).toBe("ok");

      const users = await listUsers();
      expect(users).toHaveLength(1);
      expect(users[0]).toMatchObject({
        email: "dani@example.com",
        role: "member",
        active: 1,
      });
      // request gone
      expect(await listAccessRequests()).toHaveLength(0);
    });

    it("defaults displayName to the capitalized email local-part", async () => {
      const req = await seedRequest("pedro.silva@example.com");
      await approveAccessRequest(req.id);
      expect((await listUsers())[0].displayName).toBe("Pedro.silva");
    });

    it("uses an explicit displayName when supplied (trimmed)", async () => {
      const req = await seedRequest("x@example.com");
      await approveAccessRequest(req.id, { displayName: "  Custom Name  " });
      expect((await listUsers())[0].displayName).toBe("Custom Name");
    });

    it("blank/whitespace displayName falls back to the default", async () => {
      const req = await seedRequest("y@example.com");
      await approveAccessRequest(req.id, { displayName: "   " });
      expect((await listUsers())[0].displayName).toBe("Y");
    });

    it("not-found for unknown id (and no user created)", async () => {
      const result = await approveAccessRequest(99999);
      expect(result.status).toBe("not-found");
      expect(await listUsers()).toHaveLength(0);
    });

    it("duplicate when a users row with that email appeared meanwhile → also deletes the request", async () => {
      const req = await seedRequest("dup@example.com");
      // A users row with the same email shows up before approval lands.
      await createUser({ email: "dup@example.com", displayName: "Already Here" });

      const result = await approveAccessRequest(req.id);
      expect(result.status).toBe("duplicate");
      // The request is satisfied → removed.
      expect(await listAccessRequests()).toHaveLength(0);
      // The pre-existing user is untouched (no second row).
      const users = await listUsers();
      expect(users).toHaveLength(1);
      expect(users[0].displayName).toBe("Already Here");
    });
  });

  // ── approveAccessRequest — alias mode ────────────────────────────────────────

  describe("approveAccessRequest (alias of existing user)", () => {
    it("adds the email to the target user, creates NO new user, deletes the request", async () => {
      const target = await createUser({ email: "lucas@example.org", displayName: "Lucas" });
      const req = await seedRequest("lucas@example.net");

      const result = await approveAccessRequest(req.id, { aliasOfUserId: target!.id });
      expect(result).toEqual({ status: "ok", userId: target!.id });

      // No new user row.
      expect(await listUsers()).toHaveLength(1);
      // The email is now on the target.
      const emails = await listUserEmails(target!.id);
      expect(emails!.map((e) => e.email).sort()).toEqual([
        "lucas@example.net",
        "lucas@example.org",
      ]);
      // The primary is unchanged.
      expect(emails!.find((e) => e.primary)!.email).toBe("lucas@example.org");
      // The request is cleared.
      expect(await listAccessRequests()).toHaveLength(0);
      // user.email_added emitted (admin audit), not user.approved.
      const evts = await db.select().from(schema.events);
      expect(evts.map((e) => e.kind)).toContain("user.email_added");
      expect(evts.map((e) => e.kind)).not.toContain("user.approved");
    });

    it("alias-not-found when the target user doesn't exist (request preserved)", async () => {
      const req = await seedRequest("orphan@example.com");
      const result = await approveAccessRequest(req.id, { aliasOfUserId: 99999 });
      expect(result).toEqual({ status: "alias-not-found" });
      // Request preserved so the admin can retry.
      expect(await listAccessRequests()).toHaveLength(1);
    });

    it("duplicate when the email already belongs to a user (request cleared, no steal)", async () => {
      const a = await createUser({ email: "a@example.com", displayName: "A" });
      const b = await createUser({ email: "b@example.com", displayName: "B" });
      // Request for an address that's already a's primary.
      const req = await seedRequest("a@example.com");
      const result = await approveAccessRequest(req.id, { aliasOfUserId: b!.id });
      expect(result.status).toBe("duplicate");
      // b did NOT gain a's email.
      expect((await listUserEmails(b!.id))!.map((e) => e.email)).toEqual(["b@example.com"]);
      expect((await listUserEmails(a!.id))!).toHaveLength(1);
      // Request cleared (satisfied — the person already has a row).
      expect(await listAccessRequests()).toHaveLength(0);
    });

    it("aliasing onto an admin's account makes the new email an admin login (any-email-is-admin)", async () => {
      // The auth derivation is covered in auth.test; here we just confirm the
      // alias email lands on the admin's row so the derivation can see it.
      const admin = await createUser({ email: "admin@example.com", displayName: "Admin" });
      const req = await seedRequest("admin-alt@example.com");
      await approveAccessRequest(req.id, { aliasOfUserId: admin!.id });
      const emails = await listUserEmails(admin!.id);
      expect(emails!.map((e) => e.email)).toContain("admin-alt@example.com");
    });
  });

  // ── dismissAccessRequest ────────────────────────────────────────────────────

  describe("dismissAccessRequest", () => {
    it("deletes the request without creating a user → ok", async () => {
      const req = await seedRequest("nope@example.com");
      const result = await dismissAccessRequest(req.id);
      expect(result).toBe("ok");
      expect(await listAccessRequests()).toHaveLength(0);
      expect(await listUsers()).toHaveLength(0);
    });

    it("not-found for unknown id", async () => {
      expect(await dismissAccessRequest(99999)).toBe("not-found");
    });

    it("dismissing one leaves others intact", async () => {
      const a = await seedRequest("a@example.com");
      await seedRequest("b@example.com");
      await dismissAccessRequest(a.id);
      const remaining = await listAccessRequests();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].email).toBe("b@example.com");
      // the dismissed row is really gone
      const gone = await db.query.accessRequests.findFirst({
        where: eq(schema.accessRequests.id, a.id),
      });
      expect(gone).toBeUndefined();
    });
  });
});
