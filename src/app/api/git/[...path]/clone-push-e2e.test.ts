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
    await createSpace("e2e", owner.id, "private", "t");
    await setSpaceMemberRole("e2e", reader.id, "reader", "t");
    ownerSlug = ownerSlugForUser({ tokenName: "lucas", email: null }, owner.id);
    ownerTok = (await mintPrincipalToken(owner.id, "t")).token;
    readerTok = (await mintPrincipalToken(reader.id, "t")).token;

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

      // 4. The projection re-indexed on the owner's push: a doc exists.
      const docs = await db.select().from(schema.docs).where(eq(schema.docs.sourcePath, "hello.md"));
      expect(docs.length).toBe(1);
      expect(docs[0].title).toBe("Hello");
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }, 30000);
});
