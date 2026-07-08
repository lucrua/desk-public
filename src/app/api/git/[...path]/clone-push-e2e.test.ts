/**
 * TRUE end-to-end git clone/push round-trip through the real route handlers over
 * a live HTTP socket, driven by the system `git` CLIENT (not just the
 * advertisement bytes). This is §15 smoke tests #1 (token clone) and #4 (role
 * enforcement) exercised headlessly.
 *
 * Skipped automatically when the host has no usable `git` (CI without git) — the
 * unit-level route.test.ts already covers the auth matrix; this adds the real
 * protocol negotiation on top.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { resetDb } from "@/test/db";
import { db, schema } from "@/db";
import {
  createSpace,
  setSpaceMemberRole,
  mintPrincipalToken,
  ownerSlugForUser,
} from "@/lib/spaces";
import { GET, POST } from "./route";

const run = promisify(execFile);

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "T",
  GIT_AUTHOR_EMAIL: "t@x",
  GIT_COMMITTER_NAME: "T",
  GIT_COMMITTER_EMAIL: "t@x",
};

describe("git transport — live clone/push round-trip", () => {
  let server: Server;
  let port: number;
  let dataDir: string;
  let prevDataDir: string | undefined;
  let ownerSlug: string;
  let ownerTok: string;
  let readerTok: string;
  // A SECOND owner (bob) with a SAME-SLUG `e2e` space, for the S3 isolation test.
  let bobSlug: string;
  let bobTok: string;

  beforeAll(async () => {
    await resetDb();
    dataDir = await mkdtemp(path.join(tmpdir(), "desk-git-e2e-"));
    prevDataDir = process.env.DESK_DATA_DIR;
    process.env.DESK_DATA_DIR = dataDir;

    const [owner] = await db
      .insert(schema.users)
      .values({ tokenName: "lucas", displayName: "Lucas", role: "admin", active: 1 })
      .returning({ id: schema.users.id });
    const [reader] = await db
      .insert(schema.users)
      .values({ tokenName: "cow", displayName: "Cow", role: "member", active: 1 })
      .returning({ id: schema.users.id });
    const [bob] = await db
      .insert(schema.users)
      .values({ tokenName: "bob", displayName: "Bob", role: "admin", active: 1 })
      .returning({ id: schema.users.id });
    const lucasE2e = await createSpace("e2e", owner.id, "private", "t");
    if (!lucasE2e.ok) throw new Error("setup");
    // Owner-namespace S5: membership is set by the RESOLVED space id, so it targets
    // lucas's `e2e` exactly even once bob owns a same-slug `e2e` below.
    await setSpaceMemberRole(lucasE2e.space.id, reader.id, "reader", "t");
    // NOW add a SECOND owner's same-slug `e2e` space (the S3 isolation fixture).
    await createSpace("e2e", bob.id, "private", "t");
    ownerSlug = ownerSlugForUser({ tokenName: "lucas", email: null }, owner.id);
    bobSlug = ownerSlugForUser({ tokenName: "bob", email: null }, bob.id);
    ownerTok = (await mintPrincipalToken(owner.id, "t")).token;
    readerTok = (await mintPrincipalToken(reader.id, "t")).token;
    bobTok = (await mintPrincipalToken(bob.id, "t")).token;

    server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = Buffer.concat(chunks);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
      const webReq = new Request(`http://127.0.0.1:${port}${req.url}`, {
        method: req.method,
        headers,
        body: body.length ? new Uint8Array(body) : undefined,
      });
      const out = req.method === "GET" ? await GET(webReq) : await POST(webReq);
      res.statusCode = out.status;
      out.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(Buffer.from(await out.arrayBuffer()));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    if (prevDataDir === undefined) delete process.env.DESK_DATA_DIR;
    else process.env.DESK_DATA_DIR = prevDataDir;
    await rm(dataDir, { recursive: true, force: true });
  });

  function repoUrl(tok: string): string {
    return `http://git:${tok}@127.0.0.1:${port}/api/git/${ownerSlug}/e2e.git`;
  }
  function repoUrlFor(ownerSeg: string, tok: string): string {
    return `http://git:${tok}@127.0.0.1:${port}/api/git/${ownerSeg}/e2e.git`;
  }

  it("owner clones (empty), pushes; reader clones and sees it; reader push is rejected", async () => {
    const work = await mkdtemp(path.join(tmpdir(), "desk-git-e2e-work-"));
    try {
      // 1. Owner clones the empty repo + pushes the first commit.
      const o = path.join(work, "owner");
      await run("git", ["clone", repoUrl(ownerTok), o], { env: GIT_ENV });
      await writeFile(path.join(o, "hello.md"), "# Hello\nworld");
      await run("git", ["add", "-A"], { cwd: o, env: GIT_ENV });
      await run("git", ["commit", "-m", "first"], { cwd: o, env: GIT_ENV });
      await run("git", ["push", "origin", "HEAD:main"], { cwd: o, env: GIT_ENV });

      // 2. Reader clones with their token and SEES the pushed content.
      const r = path.join(work, "reader");
      await run("git", ["clone", repoUrl(readerTok), r], { env: GIT_ENV });
      const content = await readFile(path.join(r, "hello.md"), "utf8");
      expect(content).toContain("world");

      // 3. Reader attempts a push → MUST be rejected (role enforcement).
      await writeFile(path.join(r, "sneaky.md"), "# nope");
      await run("git", ["add", "-A"], { cwd: r, env: GIT_ENV });
      await run("git", ["commit", "-m", "sneak"], { cwd: r, env: GIT_ENV });
      let pushRejected = false;
      try {
        await run("git", ["push", "origin", "HEAD:main"], { cwd: r, env: GIT_ENV });
      } catch {
        pushRejected = true;
      }
      expect(pushRejected).toBe(true);

      // 4. The projection re-indexed on the owner's push into the OWNER-CORRECT
      // space (S3): the doc lands in lucas's e2e; bob's same-slug e2e stays empty.
      const docs = await db.select().from(schema.docs).where(eq(schema.docs.sourcePath, "hello.md"));
      expect(docs.length).toBe(1);
      expect(docs[0].title).toBe("Hello");
      // Two `e2e` spaces exist; the doc belongs to exactly one, the OTHER is empty.
      const e2eSpaces = await db.select().from(schema.spaces).where(eq(schema.spaces.slug, "e2e"));
      expect(e2eSpaces.length).toBe(2);
      const otherE2e = e2eSpaces.find((s) => s.id !== docs[0].spaceId);
      expect(otherE2e).toBeTruthy();
      const otherDocs = await db.select().from(schema.docs).where(eq(schema.docs.spaceId, otherE2e!.id));
      expect(otherDocs.length).toBe(0); // bob's same-slug space never received the push
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }, 30000);

  // ── S3: two owners share the slug `e2e`; the URL owner segment is a HANDLE, so
  // one owner's token cannot reach the other owner's same-slug repo. ────────────
  it("cross-owner: lucas's token is REJECTED on bob/e2e; bob's token can clone bob/e2e", async () => {
    const work = await mkdtemp(path.join(tmpdir(), "desk-git-e2e-x-"));
    try {
      // lucas (owner of lucas/e2e) has NO membership on bob/e2e → clone rejected.
      let lucasRejected = false;
      try {
        await run("git", ["clone", repoUrlFor(bobSlug, ownerTok), path.join(work, "x1")], { env: GIT_ENV });
      } catch {
        lucasRejected = true;
      }
      expect(lucasRejected).toBe(true);

      // bob (owner of bob/e2e) CAN clone bob/e2e (empty repo, exit 0).
      await run("git", ["clone", repoUrlFor(bobSlug, bobTok), path.join(work, "x2")], { env: GIT_ENV });

      // ...and bob is rejected on lucas/e2e (the mirror-image denial).
      let bobRejected = false;
      try {
        await run("git", ["clone", repoUrlFor(ownerSlug, bobTok), path.join(work, "x3")], { env: GIT_ENV });
      } catch {
        bobRejected = true;
      }
      expect(bobRejected).toBe(true);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }, 30000);
});
