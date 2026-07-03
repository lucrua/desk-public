/**
 * TRUE end-to-end test of the E2 write boundary + proposals review, over the
 * real git transport (system `git` CLIENT + the actual route handlers on a live
 * socket). This is the security-critical slice — the ref-authz matrix in
 * `proposal` mode + a full clone → push-to-proposal → accept round-trip.
 *
 * Covers (spec E2):
 *   - proposal mode: a non-owner WRITER's push to `main` is REJECTED; to
 *     `proposals/<name>` it SUCCEEDS.
 *   - proposal mode: the OWNER pushes `main` directly (unrestricted).
 *   - direct mode: a writer pushes `main` (UNCHANGED behaviour).
 *   - Accept merges the proposal into `main`, the content PROJECTS (reindex ran),
 *     and the proposal ref is DELETED — both a fast-forward and a non-ff
 *     (merge-commit) path.
 *   - Reject deletes the ref, main untouched.
 *
 * Skipped automatically when the host has no usable `git`. The pure ref-authz
 * matrix (push-policy.test.ts) + the service-level proposals tests
 * (proposals.test.ts) cover the logic without the socket; this adds the real
 * protocol + hook execution on top.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile, readFile, access } from "node:fs/promises";
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
  setSpacePushPolicy,
  mintPrincipalToken,
  ownerSlugForUser,
} from "@/lib/spaces";
import { bareRepoPath, refTip } from "@/lib/git/repo";
import { listProposalsForSpace, acceptProposalForSpace, rejectProposalForSpace } from "@/lib/proposals-service";
import { GET, POST } from "./route";

const run = promisify(execFile);

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Writer",
  GIT_AUTHOR_EMAIL: "w@x",
  GIT_COMMITTER_NAME: "Writer",
  GIT_COMMITTER_EMAIL: "w@x",
};

// Detect a usable git client once; skip the suite when absent.
let HAVE_GIT = true;
try {
  await run("git", ["--version"]);
} catch {
  HAVE_GIT = false;
}

describe.skipIf(!HAVE_GIT)("git transport — E2 push-policy + proposals e2e", () => {
  let server: Server;
  let port: number;
  let dataDir: string;
  let prevDataDir: string | undefined;
  let ownerSlug: string;
  let ownerTok: string;
  let writerTok: string;

  beforeAll(async () => {
    await resetDb();
    dataDir = await mkdtemp(path.join(tmpdir(), "desk-e2-e2e-"));
    prevDataDir = process.env.DESK_DATA_DIR;
    process.env.DESK_DATA_DIR = dataDir;

    const [owner] = await db
      .insert(schema.users)
      .values({ tokenName: "owner", displayName: "Owner", role: "admin", active: 1 })
      .returning({ id: schema.users.id });
    const [writer] = await db
      .insert(schema.users)
      .values({ tokenName: "writer", displayName: "Writer", role: "member", active: 1 })
      .returning({ id: schema.users.id });
    await createSpace("collab", owner.id, "private", "t");
    await setSpaceMemberRole("collab", writer.id, "writer", "t");
    ownerSlug = ownerSlugForUser({ tokenName: "owner", email: null }, owner.id);
    ownerTok = (await mintPrincipalToken(owner.id, "t")).token;
    writerTok = (await mintPrincipalToken(writer.id, "t")).token;

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

    // Seed main: owner pushes the initial commit (in direct mode — default).
    const seed = await mkdtemp(path.join(tmpdir(), "desk-e2-seed-"));
    try {
      await run("git", ["clone", repoUrl(ownerTok), seed], { env: GIT_ENV });
      await writeFile(path.join(seed, "README.md"), "# Collab\nbase line\n");
      await run("git", ["add", "-A"], { cwd: seed, env: GIT_ENV });
      await run("git", ["commit", "-m", "seed"], { cwd: seed, env: GIT_ENV });
      await run("git", ["push", "origin", "HEAD:main"], { cwd: seed, env: GIT_ENV });
    } finally {
      await rm(seed, { recursive: true, force: true });
    }
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    if (prevDataDir === undefined) delete process.env.DESK_DATA_DIR;
    else process.env.DESK_DATA_DIR = prevDataDir;
    await rm(dataDir, { recursive: true, force: true });
  });

  function repoUrl(tok: string): string {
    return `http://git:${tok}@127.0.0.1:${port}/api/git/${ownerSlug}/collab.git`;
  }

  async function pushSucceeds(tok: string, refspec: string, file: string, content: string): Promise<boolean> {
    const work = await mkdtemp(path.join(tmpdir(), "desk-e2-work-"));
    try {
      await run("git", ["clone", repoUrl(tok), work], { env: GIT_ENV });
      await writeFile(path.join(work, file), content);
      await run("git", ["add", "-A"], { cwd: work, env: GIT_ENV });
      await run("git", ["commit", "-m", `change ${file}`], { cwd: work, env: GIT_ENV });
      try {
        await run("git", ["push", "origin", `HEAD:${refspec}`], { cwd: work, env: GIT_ENV });
        return true;
      } catch {
        return false;
      }
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  describe("direct mode (unchanged behaviour)", () => {
    beforeEach(async () => {
      await setSpacePushPolicy("collab", "direct", "t");
    });
    it("a non-owner WRITER pushes main (allowed — exactly today's behaviour)", async () => {
      const ok = await pushSucceeds(writerTok, "main", "direct-writer.md", "# direct writer\n");
      expect(ok).toBe(true);
    });
  });

  describe("proposal mode — the E2 write boundary", () => {
    beforeEach(async () => {
      await setSpacePushPolicy("collab", "proposal", "t");
    });

    it("a non-owner WRITER's push to main is REJECTED", async () => {
      const ok = await pushSucceeds(writerTok, "main", "blocked.md", "# should not land\n");
      expect(ok).toBe(false);
      // main must NOT contain the blocked file.
      const repoPath = bareRepoPath(ownerSlug, "collab");
      const ls = await run("git", ["ls-tree", "--name-only", "main"], { cwd: repoPath, env: GIT_ENV });
      expect(ls.stdout).not.toContain("blocked.md");
    });

    it("a non-owner WRITER's push to proposals/<name> SUCCEEDS", async () => {
      const ok = await pushSucceeds(writerTok, "proposals/feat-a", "feat-a.md", "# feature a\n");
      expect(ok).toBe(true);
      const list = await listProposalsForSpace("collab");
      expect(list.ok).toBe(true);
      if (list.ok) expect(list.proposals.some((p) => p.name === "feat-a")).toBe(true);
    });

    it("the OWNER still pushes main directly in proposal mode", async () => {
      const ok = await pushSucceeds(ownerTok, "main", "owner-direct.md", "# owner direct\n");
      expect(ok).toBe(true);
    });

    it("a non-owner WRITER's push to a NON-proposals branch is REJECTED (default-deny)", async () => {
      const ok = await pushSucceeds(writerTok, "sneaky", "sneaky.md", "# sneaky\n");
      expect(ok).toBe(false);
    });
  });

  describe("Accept / Reject round-trip", () => {
    beforeEach(async () => {
      await setSpacePushPolicy("collab", "proposal", "t");
    });

    it("ACCEPT (fast-forward): writer proposes off current main → merges, projects, ref deleted", async () => {
      // Writer clones (gets current main), adds a file, pushes a FF proposal.
      const ok = await pushSucceeds(writerTok, "proposals/ff", "ff-doc.md", "# FF Doc\nff body\n");
      expect(ok).toBe(true);

      const accepted = await acceptProposalForSpace("collab", "ff", { name: "Owner", email: "o@x" });
      expect(accepted.ok).toBe(true);
      if (accepted.ok) {
        // ff-doc projected into the index.
        const docs = await db.select().from(schema.docs).where(eq(schema.docs.sourcePath, "ff-doc.md"));
        expect(docs.length).toBe(1);
        expect(docs[0].title).toBe("FF Doc");
      }
      // The proposal ref is gone.
      const list = await listProposalsForSpace("collab");
      if (list.ok) expect(list.proposals.some((p) => p.name === "ff")).toBe(false);
      // main contains the file.
      const repoPath = bareRepoPath(ownerSlug, "collab");
      const ls = await run("git", ["ls-tree", "--name-only", "main"], { cwd: repoPath, env: GIT_ENV });
      expect(ls.stdout).toContain("ff-doc.md");
    });

    it("ACCEPT (non-ff merge commit): proposal diverged from main → merge commit, both lines land", async () => {
      // Writer makes a proposal off the current main.
      const okProp = await pushSucceeds(writerTok, "proposals/diverge", "from-proposal.md", "# From Proposal\n");
      expect(okProp).toBe(true);
      // Owner moves main independently (so the proposal is no longer a FF).
      const okMain = await pushSucceeds(ownerTok, "main", "from-owner.md", "# From Owner\n");
      expect(okMain).toBe(true);

      const accepted = await acceptProposalForSpace("collab", "diverge", { name: "Owner", email: "o@x" });
      expect(accepted.ok).toBe(true);
      if (accepted.ok) expect(accepted.merged).toBe("merge-commit");

      // Both files exist on main after the merge.
      const repoPath = bareRepoPath(ownerSlug, "collab");
      const ls = await run("git", ["ls-tree", "--name-only", "main"], { cwd: repoPath, env: GIT_ENV });
      expect(ls.stdout).toContain("from-proposal.md");
      expect(ls.stdout).toContain("from-owner.md");
      // Both projected.
      const fp = await db.select().from(schema.docs).where(eq(schema.docs.sourcePath, "from-proposal.md"));
      const fo = await db.select().from(schema.docs).where(eq(schema.docs.sourcePath, "from-owner.md"));
      expect(fp.length).toBe(1);
      expect(fo.length).toBe(1);
    });

    it("REJECT: ref deleted, main untouched", async () => {
      const ok = await pushSucceeds(writerTok, "proposals/nope", "nope.md", "# nope\n");
      expect(ok).toBe(true);
      const repoPath = bareRepoPath(ownerSlug, "collab");
      const mainBefore = await refTip(repoPath, "main");

      const rejected = await rejectProposalForSpace("collab", "nope", "Owner");
      expect(rejected.ok).toBe(true);

      const list = await listProposalsForSpace("collab");
      if (list.ok) expect(list.proposals.some((p) => p.name === "nope")).toBe(false);
      const mainAfter = await refTip(repoPath, "main");
      expect(mainAfter).toBe(mainBefore); // main untouched
      // nope.md never reached main.
      const ls = await run("git", ["ls-tree", "--name-only", "main"], { cwd: repoPath, env: GIT_ENV });
      expect(ls.stdout).not.toContain("nope.md");
    });
  });

  it("the policy pre-receive hook is installed on the bare repo", async () => {
    const repoPath = bareRepoPath(ownerSlug, "collab");
    const hookPath = path.join(repoPath, "hooks", "pre-receive");
    await expect(access(hookPath)).resolves.toBeUndefined();
    const body = await readFile(hookPath, "utf8");
    expect(body).toContain("DESK_PUSH_POLICY");
    expect(body).toContain("refs/heads/proposals/");
  });
}, 60000);
