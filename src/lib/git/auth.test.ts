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
