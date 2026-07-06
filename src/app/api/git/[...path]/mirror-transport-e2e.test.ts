/**
 * Convergence fix-pass, Slice 4b — the GIT-TRANSPORT half of the mirror matrix,
 * driven by the real route handlers over a live HTTP socket + the system `git`
 * client (same harness as clone-push-e2e). Proves the SUBTLE boundary:
 *
 *   - a push that advances `main` on a HOSTED space mirrors OUT to the fake
 *     GitHub remote (the transport hook fires enqueueMirror);
 *   - a push to a MIRRORED space's `main` still SUCCEEDS (that is exactly how
 *     GitHub's canon arrives) AND does NOT mirror back out (no loop).
 *
 * Skipped automatically when the host has no usable `git`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resetDb } from "@/test/db";
import { db, schema } from "@/db";
import { createSpace, mintPrincipalToken, ownerSlugForUser, getSpaceBySlug } from "@/lib/spaces";
import { setMirrorConfig, settleMirror } from "@/lib/mirror";
import { HAVE_GIT, readFileFromClone } from "@/test/git";
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

describe.skipIf(!HAVE_GIT)("Slice 4b — git-transport mirror hook (live)", () => {
  let server: Server;
  let port: number;
  let dataDir: string;
  let prevDataDir: string | undefined;
  let ownerSlug: string;
  let ownerTok: string;
  let spaceId: number;

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "desk-mirror-e2e-"));
    prevDataDir = process.env.DESK_DATA_DIR;
    process.env.DESK_DATA_DIR = dataDir;

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

  beforeEach(async () => {
    await resetDb();
    const [owner] = await db
      .insert(schema.users)
      .values({ tokenName: "lucas", displayName: "Lucas", role: "admin", active: 1 })
      .returning({ id: schema.users.id });
    const created = await createSpace("e2e", owner.id, "private", "t");
    if (!created.ok) throw new Error(created.error);
    spaceId = created.space.id;
    ownerSlug = ownerSlugForUser({ tokenName: "lucas", email: null }, owner.id);
    ownerTok = (await mintPrincipalToken(owner.id, "t")).token;
  });

  function repoUrl(tok: string): string {
    return `http://git:${tok}@127.0.0.1:${port}/api/git/${ownerSlug}/e2e.git`;
  }

  async function initFakeRemote(): Promise<{ path: string; cleanup: () => Promise<void> }> {
    const dir = await mkdtemp(path.join(tmpdir(), "desk-fake-gh-"));
    const bare = path.join(dir, "gh.git");
    await run("git", ["init", "--bare", "--initial-branch=main", bare]);
    return { path: bare, cleanup: () => rm(dir, { recursive: true, force: true }) };
  }

  it("a push to a HOSTED space's main mirrors OUT to the fake GitHub remote", async () => {
    const remote = await initFakeRemote();
    const work = await mkdtemp(path.join(tmpdir(), "desk-mirror-work-"));
    try {
      await setMirrorConfig("e2e", { mirrorRemoteUrl: remote.path }); // hosted (default)

      const o = path.join(work, "o");
      await run("git", ["clone", repoUrl(ownerTok), o], { env: GIT_ENV });
      await writeFile(path.join(o, "hello.md"), "# Hello\nworld");
      await run("git", ["add", "-A"], { cwd: o, env: GIT_ENV });
      await run("git", ["commit", "-m", "first"], { cwd: o, env: GIT_ENV });
      await run("git", ["push", "origin", "HEAD:main"], { cwd: o, env: GIT_ENV });

      // The transport hook enqueued a mirror push; let it settle.
      await settleMirror(spaceId);

      expect(await readFileFromClone(remote.path, "hello.md")).toContain("world");
      const space = await getSpaceBySlug("e2e");
      expect(space!.mirrorState!.lastError).toBeNull();
      expect(space!.mirrorState!.lastMirroredSha).toBeTruthy();
    } finally {
      await rm(work, { recursive: true, force: true });
      await remote.cleanup();
    }
  }, 30000);

  it("a push to a MIRRORED space's main SUCCEEDS but does NOT mirror out", async () => {
    const remote = await initFakeRemote();
    const work = await mkdtemp(path.join(tmpdir(), "desk-mirror-work2-"));
    try {
      // Mirrored: GitHub is canon; the transport push is how content ARRIVES.
      await setMirrorConfig("e2e", { sourceMode: "mirrored", mirrorRemoteUrl: remote.path });

      const o = path.join(work, "o");
      await run("git", ["clone", repoUrl(ownerTok), o], { env: GIT_ENV });
      await writeFile(path.join(o, "incoming.md"), "# Incoming\nfrom github");
      await run("git", ["add", "-A"], { cwd: o, env: GIT_ENV });
      await run("git", ["commit", "-m", "from-gh"], { cwd: o, env: GIT_ENV });
      // The push MUST succeed (canon arriving over the transport).
      await run("git", ["push", "origin", "HEAD:main"], { cwd: o, env: GIT_ENV });
      await settleMirror(spaceId);

      // Desk projected the incoming content (the push reindexed).
      const docs = await db.select().from(schema.docs);
      expect(docs.some((d) => d.sourcePath === "incoming.md")).toBe(true);

      // But the fake remote received NOTHING — a mirrored space never pushes out.
      expect(await readFileFromClone(remote.path, "incoming.md")).toBeNull();
      const space = await getSpaceBySlug("e2e");
      // mirror_state stays untouched (enqueueMirror no-oped on the mirrored space).
      expect(space!.mirrorState).toBeNull();
    } finally {
      await rm(work, { recursive: true, force: true });
      await remote.cleanup();
    }
  }, 30000);
});
