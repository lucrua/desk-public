import { describe, it, expect, beforeEach } from "vitest";
import { resetDb } from "@/test/db";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
import {
  createSpace,
  setSpaceMemberRole,
  mintPrincipalToken,
  revokePrincipalToken,
  ownerSlugForUser,
} from "@/lib/spaces";
import { authorizeGit, tokenFromBasicAuth, requiredRoleFor } from "./auth";

function basic(user: string, pass: string): string {
  return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
}

async function seedUser(
  displayName: string,
  tokenName: string,
  role: "admin" | "member" = "member",
): Promise<number> {
  const [u] = await db
    .insert(schema.users)
    .values({ tokenName, displayName, role, active: 1 })
    .returning({ id: schema.users.id });
  return u.id;
}

describe("git auth — tokenFromBasicAuth", () => {
  it("extracts the password (token) half, ignores the username", () => {
    expect(tokenFromBasicAuth(basic("git", "TOK123"))).toBe("TOK123");
    expect(tokenFromBasicAuth(basic("anything", "TOK123"))).toBe("TOK123");
  });
  it("returns null for absent / non-Basic / malformed headers", () => {
    expect(tokenFromBasicAuth(null)).toBeNull();
    expect(tokenFromBasicAuth("Bearer xyz")).toBeNull();
    expect(tokenFromBasicAuth("Basic !!!notbase64")).not.toBe("TOK123");
    expect(tokenFromBasicAuth(basic("only-user", ""))).toBeNull(); // empty pass
  });
});

describe("git auth — requiredRoleFor", () => {
  it("upload-pack needs reader, receive-pack needs writer", () => {
    expect(requiredRoleFor("git-upload-pack")).toBe("reader");
    expect(requiredRoleFor("git-receive-pack")).toBe("writer");
  });
});

describe("git auth — authorizeGit (THE matrix)", () => {
  let ownerId: number, writerId: number, readerId: number, strangerId: number;
  let ownerSlug: string;
  let ownerTok: string, writerTok: string, readerTok: string, strangerTok: string;

  beforeEach(async () => {
    await resetDb();
    ownerId = await seedUser("Owner", "owner", "admin");
    writerId = await seedUser("Writer", "writer");
    readerId = await seedUser("Reader", "reader");
    strangerId = await seedUser("Stranger", "stranger");
    const created = await createSpace("acme", ownerId, "private", "tester");
    if (!created.ok) throw new Error("setup");
    ownerSlug = ownerSlugForUser({ tokenName: "owner", email: null }, ownerId);
    await setSpaceMemberRole("acme", writerId, "writer", "tester");
    await setSpaceMemberRole("acme", readerId, "reader", "tester");
    ownerTok = (await mintPrincipalToken(ownerId, "t")).token;
    writerTok = (await mintPrincipalToken(writerId, "t")).token;
    readerTok = (await mintPrincipalToken(readerId, "t")).token;
    strangerTok = (await mintPrincipalToken(strangerId, "t")).token;
  });

  // — CLONE / FETCH (upload-pack) needs reader+ —
  it("reader CAN clone (upload-pack ok)", async () => {
    const d = await authorizeGit(basic("git", readerTok), ownerSlug, "acme", "git-upload-pack");
    expect(d.kind).toBe("ok");
  });
  it("writer CAN clone", async () => {
    const d = await authorizeGit(basic("git", writerTok), ownerSlug, "acme", "git-upload-pack");
    expect(d.kind).toBe("ok");
  });
  it("owner CAN clone", async () => {
    const d = await authorizeGit(basic("git", ownerTok), ownerSlug, "acme", "git-upload-pack");
    expect(d.kind).toBe("ok");
  });

  // — PUSH (receive-pack) needs writer+ —
  it("reader CANNOT push (denied → uniform 404)", async () => {
    const d = await authorizeGit(basic("git", readerTok), ownerSlug, "acme", "git-receive-pack");
    expect(d.kind).toBe("denied");
  });
  it("writer CAN push", async () => {
    const d = await authorizeGit(basic("git", writerTok), ownerSlug, "acme", "git-receive-pack");
    expect(d.kind).toBe("ok");
  });
  it("owner CAN push", async () => {
    const d = await authorizeGit(basic("git", ownerTok), ownerSlug, "acme", "git-receive-pack");
    expect(d.kind).toBe("ok");
  });

  // — anonymous / unknown / revoked / wrong-space — all fail-closed —
  it("no credentials → unauthenticated (prompt 401)", async () => {
    const d = await authorizeGit(null, ownerSlug, "acme", "git-upload-pack");
    expect(d.kind).toBe("unauthenticated");
  });
  it("unknown token → denied (uniform 404, not a leak)", async () => {
    const d = await authorizeGit(basic("git", "bogus"), ownerSlug, "acme", "git-upload-pack");
    expect(d.kind).toBe("denied");
  });
  it("stranger (no membership) on a private space → denied (uniform 404)", async () => {
    const d = await authorizeGit(basic("git", strangerTok), ownerSlug, "acme", "git-upload-pack");
    expect(d.kind).toBe("denied");
  });
  it("revoked token → denied", async () => {
    const toks = await db.select().from(schema.principalTokens).where(eq(schema.principalTokens.userId, readerId));
    await revokePrincipalToken(toks[0].id);
    const d = await authorizeGit(basic("git", readerTok), ownerSlug, "acme", "git-upload-pack");
    expect(d.kind).toBe("denied");
  });
  it("unknown space → denied", async () => {
    const d = await authorizeGit(basic("git", ownerTok), ownerSlug, "ghost", "git-upload-pack");
    expect(d.kind).toBe("denied");
  });
  it("wrong owner segment → denied", async () => {
    const d = await authorizeGit(basic("git", ownerTok), "someone-else", "acme", "git-upload-pack");
    expect(d.kind).toBe("denied");
  });
});

// ── Two owners, SAME slug, isolated across the git write boundary (S3) ─────────
//
// alice and bob each own a `reports` space. The `<owner>` URL segment is resolved
// as a HANDLE, so /api/git/alice/reports.git and /api/git/bob/reports.git resolve
// to DIFFERENT repos. A token with a role on one owner's `reports` is fail-closed
// (uniform 404) on the other's same-slug `reports` — no membership there.
describe("git auth — two same-slug owners are isolated (S3 boundary)", () => {
  let aliceOwnerTok: string;
  let aliceWriterTok: string;
  let bobOwnerTok: string;
  let aliceReportsId: number;
  let bobReportsId: number;

  beforeEach(async () => {
    await resetDb();
    const aliceId = await seedUser("Alice", "alice", "admin");
    const bobId = await seedUser("Bob", "bob", "admin");
    const aliceWriterId = await seedUser("AliceWriter", "awr");

    const a = await createSpace("reports", aliceId, "private", "t");
    const b = await createSpace("reports", bobId, "private", "t");
    if (!a.ok || !b.ok) throw new Error("setup");
    aliceReportsId = a.space.id;
    bobReportsId = b.space.id;

    // alice's writer is a member of ALICE's reports ONLY (seed by id — the slug is
    // ambiguous now, so slug-based setSpaceMemberRole would no-op).
    await db
      .insert(schema.spaceMembers)
      .values({ spaceId: aliceReportsId, userId: aliceWriterId, role: "writer" })
      .onConflictDoNothing();

    aliceOwnerTok = (await mintPrincipalToken(aliceId, "t")).token;
    aliceWriterTok = (await mintPrincipalToken(aliceWriterId, "t")).token;
    bobOwnerTok = (await mintPrincipalToken(bobId, "t")).token;
  });

  it("each owner's token authorizes ONLY their own same-slug space (right spaceId)", async () => {
    const a = await authorizeGit(basic("git", aliceOwnerTok), "alice", "reports", "git-receive-pack");
    const b = await authorizeGit(basic("git", bobOwnerTok), "bob", "reports", "git-receive-pack");
    expect(a.kind).toBe("ok");
    expect(b.kind).toBe("ok");
    if (a.kind !== "ok" || b.kind !== "ok") return;
    expect(a.spaceId).toBe(aliceReportsId);
    expect(b.spaceId).toBe(bobReportsId);
  });

  it("alice's owner token is DENIED on bob/reports (cross-owner → uniform 404)", async () => {
    const d = await authorizeGit(basic("git", aliceOwnerTok), "bob", "reports", "git-upload-pack");
    expect(d.kind).toBe("denied");
  });

  it("bob's owner token is DENIED on alice/reports", async () => {
    const d = await authorizeGit(basic("git", bobOwnerTok), "alice", "reports", "git-upload-pack");
    expect(d.kind).toBe("denied");
  });

  it("a WRITER on alice/reports can push there but is DENIED (404) on bob/reports", async () => {
    const ok = await authorizeGit(basic("git", aliceWriterTok), "alice", "reports", "git-receive-pack");
    expect(ok.kind).toBe("ok");
    if (ok.kind === "ok") expect(ok.spaceId).toBe(aliceReportsId);
    const denied = await authorizeGit(basic("git", aliceWriterTok), "bob", "reports", "git-upload-pack");
    expect(denied.kind).toBe("denied");
  });

  it("unknown handle segment → denied even with a valid token", async () => {
    const d = await authorizeGit(basic("git", aliceOwnerTok), "carol", "reports", "git-upload-pack");
    expect(d.kind).toBe("denied");
  });
});
