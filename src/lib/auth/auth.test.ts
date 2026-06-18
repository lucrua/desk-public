import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from "vitest";
import { generateKeyPair, SignJWT } from "jose";
import { eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { resetDb, seedUser } from "@/test/db";
import { principalFromDevHeaders } from "./dev";
import { principalFromCfJwt } from "./cloudflare";
import { getPrincipal } from "./index";
import type { Principal } from "./principal";

// ---------------------------------------------------------------------------
// Dev provider
// ---------------------------------------------------------------------------

describe("principalFromDevHeaders — dev identity provider", () => {
  it("x-dev-role: admin header → admin principal", async () => {
    const headers = new Headers({ "x-dev-role": "admin" });
    const p = await principalFromDevHeaders(headers);
    expect(p.kind).toBe("admin");
    if (p.kind !== "admin") throw new Error("expected admin");
    expect(p.name).toBe("Dev Admin");
  });

  it("x-dev-role: member header → member principal", async () => {
    const headers = new Headers({ "x-dev-role": "member" });
    const p = await principalFromDevHeaders(headers);
    expect(p.kind).toBe("member");
    if (p.kind !== "member") throw new Error("expected member");
    expect(p.name).toBe("Dev Member");
  });

  it("no header, no cookie → anonymous", async () => {
    const headers = new Headers();
    const p = await principalFromDevHeaders(headers);
    expect(p.kind).toBe("anonymous");
  });

  it("cookie hub-dev-role=admin honored when no header", async () => {
    const headers = new Headers({ cookie: "hub-dev-role=admin" });
    const p = await principalFromDevHeaders(headers);
    expect(p.kind).toBe("admin");
    if (p.kind !== "admin") throw new Error("expected admin");
    expect(p.name).toBe("Dev Admin");
  });

  it("cookie hub-dev-role=member honored when no header", async () => {
    const headers = new Headers({ cookie: "hub-dev-role=member" });
    const p = await principalFromDevHeaders(headers);
    expect(p.kind).toBe("member");
  });

  it("x-dev-role header takes priority over cookie", async () => {
    const headers = new Headers({
      "x-dev-role": "member",
      cookie: "hub-dev-role=admin",
    });
    const p = await principalFromDevHeaders(headers);
    expect(p.kind).toBe("member");
  });

  it("unknown role value in header → anonymous", async () => {
    const headers = new Headers({ "x-dev-role": "superuser" });
    const p = await principalFromDevHeaders(headers);
    expect(p.kind).toBe("anonymous");
  });

  it("unknown role value in cookie → anonymous", async () => {
    const headers = new Headers({ cookie: "hub-dev-role=god" });
    const p = await principalFromDevHeaders(headers);
    expect(p.kind).toBe("anonymous");
  });

  it("throws when NODE_ENV === production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      await expect(
        principalFromDevHeaders(new Headers()),
      ).rejects.toThrow(/production/i);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

// ---------------------------------------------------------------------------
// Cloudflare JWT provider
// ---------------------------------------------------------------------------

describe("principalFromCfJwt — Cloudflare Access JWT verification", () => {
  const issuer = "https://t.cloudflareaccess.com";
  const audience = "test-aud";

  let publicKey: CryptoKey;
  let privateKey: CryptoKey;

  // Generate a fresh key pair once for the suite
  beforeAll(async () => {
    ({ publicKey, privateKey } = await generateKeyPair("RS256"));
  });

  beforeEach(async () => {
    await resetDb();
  });

  async function signJwt(
    claims: Record<string, unknown>,
    opts?: { aud?: string; iss?: string; key?: CryptoKey; expiresIn?: string },
  ): Promise<string> {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256" })
      .setAudience(opts?.aud ?? audience)
      .setIssuer(opts?.iss ?? issuer)
      .setExpirationTime(opts?.expiresIn ?? "5m")
      .sign(opts?.key ?? privateKey);
  }

  // ── stored-role derivation (admin model v2) ──────────────────────────────

  it("row with stored role=admin → admin principal (stored column is truth)", async () => {
    await seedUser({
      email: "owner@example.com",
      displayName: "Admin",
      role: "admin",
      active: 1,
    });

    const jwt = await signJwt({ email: "owner@example.com" });
    const p = await principalFromCfJwt(jwt, { key: publicKey, audience, issuer });

    expect(p.kind).toBe("admin");
    if (p.kind !== "admin") throw new Error("expected admin");
    expect(p.name).toBe("Admin");
    expect(p.email).toBe("owner@example.com");
  });

  it("row with stored role=member → member (even if ADMIN_EMAIL matches — env ignored for live derivation)", async () => {
    vi.stubEnv("ADMIN_EMAIL", "owner@example.com");
    // Row stored as member — ADMIN_EMAIL must NOT override the stored column.
    await seedUser({
      email: "owner@example.com",
      displayName: "Admin",
      role: "member",
      active: 1,
    });

    const jwt = await signJwt({ email: "owner@example.com" });
    const p = await principalFromCfJwt(jwt, { key: publicKey, audience, issuer });

    expect(p.kind).toBe("member");
    if (p.kind !== "member") throw new Error("expected member");
    expect(p.name).toBe("Admin");
    vi.unstubAllEnvs();
  });

  it("ADMIN_EMAIL is completely ignored for live derivation — random value has no effect", async () => {
    vi.stubEnv("ADMIN_EMAIL", "ignored@random.value");
    await seedUser({
      email: "bob@example.com",
      displayName: "Bob",
      role: "member",
      active: 1,
    });

    const jwt = await signJwt({ email: "bob@example.com" });
    const p = await principalFromCfJwt(jwt, { key: publicKey, audience, issuer });

    expect(p.kind).toBe("member"); // stored role wins
    vi.unstubAllEnvs();
  });

  it("service-token row with role=admin → admin (agent gets publish rights)", async () => {
    // A pure service-token row with role='admin' must be admin — this is how
    // an agent gets publish rights (promote its user row to admin).
    await seedUser({
      tokenName: "admin-agent",
      displayName: "Admin Agent",
      role: "admin",
      active: 1,
    });

    const jwt = await signJwt({ common_name: "admin-agent" });
    const p = await principalFromCfJwt(jwt, { key: publicKey, audience, issuer });

    expect(p.kind).toBe("admin");
    if (p.kind !== "admin") throw new Error("expected admin");
    expect(p.name).toBe("Admin Agent");
    expect(p.tokenName).toBe("admin-agent");
  });

  it("service-token row with role=member → member", async () => {
    await seedUser({
      tokenName: "ci-agent",
      displayName: "CI",
      role: "member",
      active: 1,
    });

    const jwt = await signJwt({ common_name: "ci-agent" });
    const p = await principalFromCfJwt(jwt, { key: publicKey, audience, issuer });

    expect(p.kind).toBe("member");
    if (p.kind !== "member") throw new Error("expected member");
    expect(p.name).toBe("CI");
    expect(p.tokenName).toBe("ci-agent");
  });

  it("unknown email → anonymous (when table is non-empty, no bootstrap)", async () => {
    // Seed a user so the table is non-empty — bootstrap only fires on empty table.
    await seedUser({ email: "existing@example.com", displayName: "Existing", role: "member" });
    const jwt = await signJwt({ email: "unknown@example.com" });
    const p = await principalFromCfJwt(jwt, { key: publicKey, audience, issuer });
    expect(p.kind).toBe("anonymous");
  });

  // ── access requests (verified-but-unknown email) ──────────────────────────
  describe("access requests", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("unknown verified email → anonymous AND an access_requests row is created", async () => {
      // Pre-seed so the table is non-empty (bootstrap only fires on empty table).
      await seedUser({ email: "admin@example.com", displayName: "Admin", role: "admin" });
      const jwt = await signJwt({ email: "newcomer@example.com" });
      const p = await principalFromCfJwt(jwt, { key: publicKey, audience, issuer });
      expect(p.kind).toBe("anonymous");

      const reqs = await db.select().from(schema.accessRequests);
      expect(reqs).toHaveLength(1);
      expect(reqs[0].email).toBe("newcomer@example.com");
      expect(reqs[0].hits).toBe(1);
    });

    it("repeated unknown email → hits increments, lastSeenAt bumps, single row", async () => {
      // Pre-seed so the table is non-empty.
      await seedUser({ email: "admin@example.com", displayName: "Admin", role: "admin" });
      const jwt = await signJwt({ email: "repeat@example.com" });
      await principalFromCfJwt(jwt, { key: publicKey, audience, issuer });
      const first = (await db.select().from(schema.accessRequests))[0];

      const jwt2 = await signJwt({ email: "repeat@example.com" });
      await principalFromCfJwt(jwt2, { key: publicKey, audience, issuer });

      const reqs = await db.select().from(schema.accessRequests);
      expect(reqs).toHaveLength(1);
      expect(reqs[0].hits).toBe(2);
      expect(reqs[0].lastSeenAt.getTime()).toBeGreaterThanOrEqual(first.lastSeenAt.getTime());
      // firstSeenAt is preserved on the upsert
      expect(reqs[0].firstSeenAt.getTime()).toBe(first.firstSeenAt.getTime());
    });

    it("email is normalized (trim + lowercase) before recording", async () => {
      // Pre-seed so the table is non-empty.
      await seedUser({ email: "admin@example.com", displayName: "Admin", role: "admin" });
      const jwt = await signJwt({ email: "  MixedCase@Example.COM  " });
      await principalFromCfJwt(jwt, { key: publicKey, audience, issuer });
      const reqs = await db.select().from(schema.accessRequests);
      expect(reqs).toHaveLength(1);
      expect(reqs[0].email).toBe("mixedcase@example.com");
    });

    it("bad-signature JWT → NO access_requests row (verify fails before recording)", async () => {
      const { privateKey: otherPrivKey } = await generateKeyPair("RS256");
      const jwt = await signJwt({ email: "badsig@example.com" }, { key: otherPrivKey });
      const p = await principalFromCfJwt(jwt, { key: publicKey, audience, issuer });
      expect(p.kind).toBe("anonymous");
      expect(await db.select().from(schema.accessRequests)).toHaveLength(0);
    });

    it("service-token (common_name) claim → NEVER records an access request", async () => {
      const jwt = await signJwt({ common_name: "some-agent" });
      const p = await principalFromCfJwt(jwt, { key: publicKey, audience, issuer });
      expect(p.kind).toBe("anonymous");
      expect(await db.select().from(schema.accessRequests)).toHaveLength(0);
    });

    it("known active user → no access request recorded", async () => {
      await seedUser({
        email: "member@example.com",
        displayName: "Member",
        role: "member",
        active: 1,
      });
      const jwt = await signJwt({ email: "member@example.com" });
      const p = await principalFromCfJwt(jwt, { key: publicKey, audience, issuer });
      expect(p.kind).toBe("member");
      expect(await db.select().from(schema.accessRequests)).toHaveLength(0);
    });

    it("inactive existing user → anonymous, NO access request (they already have a row)", async () => {
      await seedUser({
        email: "inactive@example.com",
        displayName: "Inactive",
        role: "member",
        active: 0,
      });
      const jwt = await signJwt({ email: "inactive@example.com" });
      const p = await principalFromCfJwt(jwt, { key: publicKey, audience, issuer });
      expect(p.kind).toBe("anonymous");
      expect(await db.select().from(schema.accessRequests)).toHaveLength(0);
    });
  });

  // ── first-login bootstrap (admin model v2) ────────────────────────────────

  describe("first-login bootstrap", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("empty table + verified email → that user is seeded as admin", async () => {
      // Table is empty (resetDb in beforeEach). First email sign-in → admin.
      const jwt = await signJwt({ email: "first@example.com" });
      const p = await principalFromCfJwt(jwt, { key: publicKey, audience, issuer });

      expect(p.kind).toBe("admin");
      if (p.kind !== "admin") throw new Error("expected admin");
      expect(p.email).toBe("first@example.com");

      // Row must be persisted with role='admin'.
      const row = await db.query.users.findFirst({
        where: eq(schema.users.email, "first@example.com"),
      });
      expect(row).toBeTruthy();
      expect(row!.role).toBe("admin");
      expect(row!.active).toBe(1);
    });

    it("empty table + verified email → no access request recorded (bootstrap, not pending)", async () => {
      const jwt = await signJwt({ email: "bootstrap@example.com" });
      await principalFromCfJwt(jwt, { key: publicKey, audience, issuer });
      expect(await db.select().from(schema.accessRequests)).toHaveLength(0);
    });

    it("empty table + service token (common_name) → NOT bootstrapped, anonymous", async () => {
      // Service tokens never bootstrap — no email claim → no first-admin.
      const jwt = await signJwt({ common_name: "svc-token" });
      const p = await principalFromCfJwt(jwt, { key: publicKey, audience, issuer });
      expect(p.kind).toBe("anonymous");

      // No user row created.
      const rows = await db.select().from(schema.users);
      expect(rows).toHaveLength(0);
    });

    it("non-empty table + second email visitor → access request (member after approval), NOT admin", async () => {
      // Seed one existing user so the table is non-empty.
      await seedUser({ email: "existing@example.com", displayName: "Existing", role: "admin" });

      const jwt = await signJwt({ email: "newcomer@example.com" });
      const p = await principalFromCfJwt(jwt, { key: publicKey, audience, issuer });

      // Must NOT bootstrap as admin — table is non-empty.
      expect(p.kind).toBe("anonymous");
      const reqs = await db.select().from(schema.accessRequests);
      expect(reqs).toHaveLength(1);
      expect(reqs[0].email).toBe("newcomer@example.com");
    });

    it("first-login bootstrap is case-insensitive", async () => {
      const jwt = await signJwt({ email: "FIRST@EXAMPLE.COM" });
      const p = await principalFromCfJwt(jwt, { key: publicKey, audience, issuer });
      expect(p.kind).toBe("admin");
      if (p.kind !== "admin") throw new Error("expected admin");
      expect(p.email).toBe("first@example.com"); // stored normalized
    });

    it("concurrent race: two simultaneous first-logins → exactly one admin", async () => {
      // Two principalFromCfJwt calls in parallel. With postgres-js (pool max:5),
      // db.transaction grabs a dedicated connection per call, so these run on two
      // SEPARATE Postgres connections in genuine parallel — not just JS
      // interleaving. The bootstrap advisory lock serializes them; one becomes
      // admin, the other falls back to anonymous (access request).
      const jwt1 = await signJwt({ email: "alice@example.com" });
      const jwt2 = await signJwt({ email: "bob@example.com" });

      const [p1, p2] = await Promise.all([
        principalFromCfJwt(jwt1, { key: publicKey, audience, issuer }),
        principalFromCfJwt(jwt2, { key: publicKey, audience, issuer }),
      ]);

      const adminCount = [p1, p2].filter((p) => p.kind === "admin").length;
      const anonCount = [p1, p2].filter((p) => p.kind === "anonymous").length;

      // Exactly one winner, one loser.
      expect(adminCount).toBe(1);
      expect(anonCount).toBe(1);

      // Only one user row in the DB.
      const rows = await db.select().from(schema.users);
      expect(rows).toHaveLength(1);
      expect(rows[0].role).toBe("admin");
    });

    it("bootstrap advisory lock serializes against a concurrent holder (BUG 1 — two-different-emails race)", async () => {
      // FAITHFUL race reproduction at the DB layer. This is the exact scenario
      // the unguarded code missed: two first-logins with DIFFERENT emails on an
      // empty table. Under READ COMMITTED with no lock, BOTH would pass a
      // count==0 re-check and BOTH INSERT (different emails → no unique
      // collision) → TWO admins, one a non-owner. We prove the advisory lock
      // closes this by holding the SAME lock key on a separate connection while a
      // real bootstrap runs.
      const LOCK_KEY = 911_478_001; // must equal BOOTSTRAP_ADVISORY_LOCK_KEY in cloudflare.ts

      // Open a second connection and take + HOLD the bootstrap advisory lock
      // inside a transaction that we deliberately park mid-flight. This stands in
      // for "alice's bootstrap is in progress and hasn't committed yet".
      let releaseHolder!: () => void;
      const holderDone = new Promise<void>((r) => {
        releaseHolder = r;
      });
      let holderTxReady!: () => void;
      const holderReady = new Promise<void>((r) => {
        holderTxReady = r;
      });

      const holderTx = db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${LOCK_KEY})`);
        // Simulate alice winning the bootstrap: insert the sole admin while
        // holding the lock, but DON'T commit yet — bob's bootstrap must block.
        await tx.insert(schema.users).values({
          email: "alice@example.com",
          displayName: "Alice",
          role: "admin",
          active: 1,
        });
        holderTxReady();
        // Park here until the test releases us; the lock + uncommitted insert are
        // held the whole time.
        await holderDone;
      });

      await holderReady;

      // Now bob's first-login runs. It must BLOCK on the advisory lock (alice
      // holds it), so it can't observe the table state until alice commits.
      const jwtBob = await signJwt({ email: "bob@example.com" });
      const bobPromise = principalFromCfJwt(jwtBob, { key: publicKey, audience, issuer });

      // Prove bob is genuinely blocked: give it room to run; it must NOT have
      // resolved while the lock is held.
      const sentinel = Symbol("pending");
      const raced = await Promise.race([
        bobPromise,
        new Promise((r) => setTimeout(() => r(sentinel), 300)),
      ]);
      expect(raced).toBe(sentinel); // bob is still waiting on the lock

      // Release alice's transaction (commits the admin insert + frees the lock).
      releaseHolder();
      await holderTx;

      // Bob now acquires the lock, re-checks emptiness, sees the table is
      // non-empty (alice exists), and does NOT mint a second admin.
      const bob = await bobPromise;
      expect(bob.kind).not.toBe("admin");

      // Invariant: exactly ONE admin, and it's alice (the winner), not bob.
      const admins = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.role, "admin"));
      expect(admins).toHaveLength(1);
      expect(admins[0].email).toBe("alice@example.com");
    });
  });

  it("JWT email claim with different casing → resolves to same user (case-insensitive lookup)", async () => {
    const { createUser } = await import("@/lib/users");
    await createUser({ email: "Owner@Example.com", displayName: "Admin Mixed", role: "admin" });

    // JWT carries a differently-cased version of the same address.
    const jwt = await signJwt({ email: "OWNER@EXAMPLE.COM" });
    const p = await principalFromCfJwt(jwt, { key: publicKey, audience, issuer });

    expect(p.kind).toBe("admin");
    if (p.kind !== "admin") throw new Error("expected admin");
    expect(p.name).toBe("Admin Mixed");
    expect(p.email).toBe("owner@example.com");
  });

  // ── multiple emails per user (auth-critical matrix) ───────────────────────
  describe("multiple emails per user", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    /** Add a secondary email row to an existing user. */
    async function addEmail(userId: number, email: string): Promise<void> {
      await db
        .insert(schema.userEmails)
        .values({ userId, email: email.trim().toLowerCase() });
    }

    it("login by PRIMARY email → user + correct role", async () => {
      const id = await seedUser({ email: "primary@example.com", displayName: "Multi" });
      await addEmail(id, "secondary@example.com");

      const jwt = await signJwt({ email: "primary@example.com" });
      const p = await principalFromCfJwt(jwt, { key: publicKey, audience, issuer });
      expect(p.kind).toBe("member");
      if (p.kind !== "member") throw new Error("expected member");
      expect(p.name).toBe("Multi");
      expect(p.email).toBe("primary@example.com");
    });

    it("login by SECONDARY email → SAME user + SAME role", async () => {
      const id = await seedUser({ email: "primary@example.com", displayName: "Multi" });
      await addEmail(id, "secondary@example.com");

      const jwt = await signJwt({ email: "secondary@example.com" });
      const p = await principalFromCfJwt(jwt, { key: publicKey, audience, issuer });
      expect(p.kind).toBe("member");
      if (p.kind !== "member") throw new Error("expected member");
      // SAME user: display name + primary email come from the resolved row, not
      // the claim.
      expect(p.name).toBe("Multi");
      expect(p.email).toBe("primary@example.com");
      // The principal carries BOTH addresses (for the self-guard / ownership).
      expect(new Set(p.emails)).toEqual(
        new Set(["primary@example.com", "secondary@example.com"]),
      );
    });

    it("user with role=admin and multiple emails → admin via ANY email", async () => {
      const id = await seedUser({ email: "owner@example.com", displayName: "Admin", role: "admin" });
      await addEmail(id, "admin@example.com");

      // Login via the primary → admin.
      const viaPrimary = await principalFromCfJwt(
        await signJwt({ email: "owner@example.com" }),
        { key: publicKey, audience, issuer },
      );
      expect(viaPrimary.kind).toBe("admin");

      // Login via the secondary → admin too.
      const viaSecondary = await principalFromCfJwt(
        await signJwt({ email: "admin@example.com" }),
        { key: publicKey, audience, issuer },
      );
      expect(viaSecondary.kind).toBe("admin");
    });

    it("email uniqueness: an address belongs to exactly one user (no cross-resolution)", async () => {
      const a = await seedUser({ email: "a@example.com", displayName: "A" });
      await seedUser({ email: "b@example.com", displayName: "B" });
      await addEmail(a, "shared-alias@example.com");

      // The alias resolves to user A only.
      const p = await principalFromCfJwt(
        await signJwt({ email: "shared-alias@example.com" }),
        { key: publicKey, audience, issuer },
      );
      expect(p.kind).toBe("member");
      if (p.kind !== "member") throw new Error("expected member");
      expect(p.name).toBe("A");

      // The DB constraint forbids the same address on a second user.
      await expect(
        addEmail((await seedUser({ email: "c@example.com", displayName: "C" })), "shared-alias@example.com"),
      ).rejects.toThrow();
    });

    it("secondary-email lookup is case-insensitive", async () => {
      const id = await seedUser({ email: "primary@example.com", displayName: "Multi" });
      await addEmail(id, "Secondary@Example.COM"); // addEmail normalizes

      const p = await principalFromCfJwt(
        await signJwt({ email: "SECONDARY@EXAMPLE.COM" }),
        { key: publicKey, audience, issuer },
      );
      expect(p.kind).toBe("member");
      if (p.kind !== "member") throw new Error("expected member");
      expect(p.name).toBe("Multi");
    });

    it("unknown email not in any user_emails → anonymous (fail-closed)", async () => {
      const id = await seedUser({ email: "primary@example.com", displayName: "Multi" });
      await addEmail(id, "secondary@example.com");

      const p = await principalFromCfJwt(
        await signJwt({ email: "nobody@example.com" }),
        { key: publicKey, audience, issuer },
      );
      expect(p.kind).toBe("anonymous");
    });
  });

  it("wrong audience → anonymous", async () => {
    await seedUser({
      email: "owner@example.com",
      displayName: "Admin",
      role: "admin",
      active: 1,
    });

    const jwt = await signJwt({ email: "owner@example.com" }, { aud: "wrong-aud" });
    const p = await principalFromCfJwt(jwt, { key: publicKey, audience, issuer });
    expect(p.kind).toBe("anonymous");
  });

  it("bad signature (different key pair) → anonymous", async () => {
    await seedUser({
      email: "owner@example.com",
      displayName: "Admin",
      role: "admin",
      active: 1,
    });

    const { privateKey: otherPrivKey } = await generateKeyPair("RS256");
    const jwt = await signJwt({ email: "owner@example.com" }, { key: otherPrivKey });
    const p = await principalFromCfJwt(jwt, { key: publicKey, audience, issuer });
    expect(p.kind).toBe("anonymous");
  });

  it("inactive user (active=0) → anonymous", async () => {
    await seedUser({
      email: "owner@example.com",
      displayName: "Admin",
      role: "admin",
      active: 0,
    });

    const jwt = await signJwt({ email: "owner@example.com" });
    const p = await principalFromCfJwt(jwt, { key: publicKey, audience, issuer });
    expect(p.kind).toBe("anonymous");
  });

  it("expired JWT → anonymous", async () => {
    await seedUser({
      email: "owner@example.com",
      displayName: "Admin",
      role: "admin",
      active: 1,
    });

    // Set exp to 1 second in the past
    const jwt = await new SignJWT({ email: "owner@example.com" })
      .setProtectedHeader({ alg: "RS256" })
      .setAudience(audience)
      .setIssuer(issuer)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 1)
      .sign(privateKey);
    const p = await principalFromCfJwt(jwt, { key: publicKey, audience, issuer });
    expect(p.kind).toBe("anonymous");
  });
});

// ---------------------------------------------------------------------------
// getPrincipal dispatcher
// ---------------------------------------------------------------------------

describe("getPrincipal — dispatcher", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("AUTH_MODE unset defaults to dev mode — x-dev-role header is honoured", async () => {
    vi.stubEnv("AUTH_MODE", "");
    const headers = new Headers({ "x-dev-role": "admin" });
    const p = await getPrincipal(headers);
    expect(p.kind).toBe("admin");
  });

  it("AUTH_MODE=cloudflare with missing Cf-Access-Jwt-Assertion → anonymous", async () => {
    vi.stubEnv("AUTH_MODE", "cloudflare");
    vi.stubEnv("CF_AUD", "test-aud");
    vi.stubEnv("CF_TEAM_DOMAIN", "test.cloudflareaccess.com");
    const p = await getPrincipal(new Headers());
    expect(p.kind).toBe("anonymous");
  });

  it("AUTH_MODE=cloudflare with missing CF_AUD → anonymous", async () => {
    vi.stubEnv("AUTH_MODE", "cloudflare");
    vi.stubEnv("CF_AUD", "");
    vi.stubEnv("CF_TEAM_DOMAIN", "test.cloudflareaccess.com");
    const headers = new Headers({ "Cf-Access-Jwt-Assertion": "some.jwt.token" });
    const p = await getPrincipal(headers);
    expect(p.kind).toBe("anonymous");
  });

  it("AUTH_MODE=cloudflare with missing CF_TEAM_DOMAIN → anonymous", async () => {
    vi.stubEnv("AUTH_MODE", "cloudflare");
    vi.stubEnv("CF_AUD", "test-aud");
    vi.stubEnv("CF_TEAM_DOMAIN", "");
    const headers = new Headers({ "Cf-Access-Jwt-Assertion": "some.jwt.token" });
    const p = await getPrincipal(headers);
    expect(p.kind).toBe("anonymous");
  });
});

// ---------------------------------------------------------------------------
// ensureBootstrapAdmin — transitional backfill
// ---------------------------------------------------------------------------

describe("ensureBootstrapAdmin — transitional backfill (admin model v2 upgrade aid)", () => {
  beforeEach(async () => {
    await resetDb();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("ADMIN_EMAIL unset → no-op", async () => {
    vi.stubEnv("ADMIN_EMAIL", "");
    await seedUser({ email: "owner@example.com", displayName: "Admin", role: "member" });
    const { ensureBootstrapAdmin } = await import("./cloudflare");
    await ensureBootstrapAdmin();
    const row = await db.query.users.findFirst({ where: eq(schema.users.email, "owner@example.com") });
    expect(row!.role).toBe("member"); // unchanged
  });

  it("ADMIN_EMAIL set + user stored as member → promotes to admin", async () => {
    vi.stubEnv("ADMIN_EMAIL", "owner@example.com");
    await seedUser({ email: "owner@example.com", displayName: "Admin", role: "member" });
    const { ensureBootstrapAdmin } = await import("./cloudflare");
    await ensureBootstrapAdmin();
    const row = await db.query.users.findFirst({ where: eq(schema.users.email, "owner@example.com") });
    expect(row!.role).toBe("admin");
  });

  it("ADMIN_EMAIL set + user already admin → idempotent (no error, stays admin)", async () => {
    vi.stubEnv("ADMIN_EMAIL", "owner@example.com");
    await seedUser({ email: "owner@example.com", displayName: "Admin", role: "admin" });
    const { ensureBootstrapAdmin } = await import("./cloudflare");
    await ensureBootstrapAdmin();
    await ensureBootstrapAdmin(); // second call must be safe
    const row = await db.query.users.findFirst({ where: eq(schema.users.email, "owner@example.com") });
    expect(row!.role).toBe("admin");
  });

  it("ADMIN_EMAIL set + email not in any user → no-op", async () => {
    vi.stubEnv("ADMIN_EMAIL", "notauser@example.com");
    await seedUser({ email: "owner@example.com", displayName: "Admin", role: "member" });
    const { ensureBootstrapAdmin } = await import("./cloudflare");
    await ensureBootstrapAdmin();
    const row = await db.query.users.findFirst({ where: eq(schema.users.email, "owner@example.com") });
    expect(row!.role).toBe("member"); // untouched
  });
});
