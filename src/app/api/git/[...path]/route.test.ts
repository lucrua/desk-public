import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resetDb } from "@/test/db";
import { db, schema } from "@/db";
import {
  createSpace,
  setSpaceMemberRole,
  mintPrincipalToken,
  ownerSlugForUser,
} from "@/lib/spaces";
import { bareRepoPath, initBareRepo, runGit } from "@/lib/git/repo";
import { GET, POST } from "./route";

const GIT_ENV = {
  GIT_AUTHOR_NAME: "T",
  GIT_AUTHOR_EMAIL: "t@x",
  GIT_COMMITTER_NAME: "T",
  GIT_COMMITTER_EMAIL: "t@x",
};

function basic(pass: string): string {
  return "Basic " + Buffer.from(`git:${pass}`).toString("base64");
}

/** Build a Request for the git transport route. */
function gitReq(
  method: "GET" | "POST",
  urlPath: string,
  opts: { auth?: string; body?: Buffer; contentType?: string } = {},
): Request {
  const headers: Record<string, string> = {};
  if (opts.auth) headers["authorization"] = opts.auth;
  if (opts.contentType) headers["content-type"] = opts.contentType;
  return new Request(`http://desk.test${urlPath}`, {
    method,
    headers,
    body: opts.body ? new Uint8Array(opts.body) : undefined,
  });
}

describe("git transport route — auth matrix + smart-HTTP", () => {
  let dataDir: string;
  let prevDataDir: string | undefined;
  let ownerSlug: string;
  let ownerTok: string, writerTok: string, readerTok: string;

  beforeEach(async () => {
    await resetDb();
    dataDir = await mkdtemp(path.join(tmpdir(), "desk-git-route-"));
    prevDataDir = process.env.DESK_DATA_DIR;
    process.env.DESK_DATA_DIR = dataDir;

    const [owner] = await db
      .insert(schema.users)
      .values({ tokenName: "lucas", displayName: "Lucas", role: "admin", active: 1 })
      .returning({ id: schema.users.id });
    const [writer] = await db
      .insert(schema.users)
      .values({ tokenName: "agent", displayName: "Agent", role: "member", active: 1 })
      .returning({ id: schema.users.id });
    const [reader] = await db
      .insert(schema.users)
      .values({ tokenName: "coworker", displayName: "Coworker", role: "member", active: 1 })
      .returning({ id: schema.users.id });

    await createSpace("acme", owner.id, "private", "tester");
    await setSpaceMemberRole("acme", writer.id, "writer", "tester");
    await setSpaceMemberRole("acme", reader.id, "reader", "tester");
    ownerSlug = ownerSlugForUser({ tokenName: "lucas", email: null }, owner.id);

    ownerTok = (await mintPrincipalToken(owner.id, "t")).token;
    writerTok = (await mintPrincipalToken(writer.id, "t")).token;
    readerTok = (await mintPrincipalToken(reader.id, "t")).token;

    // Seed the bare repo with one commit so info/refs advertises a ref.
    const repo = bareRepoPath(ownerSlug, "acme");
    await initBareRepo(repo);
    const work = await mkdtemp(path.join(tmpdir(), "desk-git-seed-"));
    await runGit(["clone", repo, work]);
    await mkdir(path.dirname(path.join(work, "README.md")), { recursive: true });
    await writeFile(path.join(work, "README.md"), "# Acme");
    await runGit(["add", "-A"], { cwd: work });
    await runGit(["commit", "-m", "seed"], { cwd: work, env: GIT_ENV });
    await runGit(["push", "origin", "HEAD:main"], { cwd: work, env: GIT_ENV });
    await rm(work, { recursive: true, force: true });
  });

  afterEach(async () => {
    if (prevDataDir === undefined) delete process.env.DESK_DATA_DIR;
    else process.env.DESK_DATA_DIR = prevDataDir;
    await rm(dataDir, { recursive: true, force: true });
  });

  const infoRefs = (svc: string) => `/api/git/${ownerSlug}/acme.git/info/refs?service=${svc}`;

  it("anonymous info/refs → 401 with WWW-Authenticate (prompt for token)", async () => {
    const res = await GET(gitReq("GET", infoRefs("git-upload-pack")));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/Basic/);
  });

  it("unknown token → uniform 404 (no existence leak)", async () => {
    const res = await GET(gitReq("GET", infoRefs("git-upload-pack"), { auth: basic("bogus") }));
    expect(res.status).toBe(404);
  });

  it("reader CAN fetch the upload-pack advertisement (200, smart-HTTP content-type)", async () => {
    const res = await GET(gitReq("GET", infoRefs("git-upload-pack"), { auth: basic(readerTok) }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-git-upload-pack-advertisement");
    const body = await res.text();
    // Smart-HTTP advertisement begins with a service pkt-line.
    expect(body).toContain("# service=git-upload-pack");
  });

  it("reader CANNOT get the receive-pack advertisement → uniform 404 (push denied)", async () => {
    const res = await GET(gitReq("GET", infoRefs("git-receive-pack"), { auth: basic(readerTok) }));
    expect(res.status).toBe(404);
  });

  it("writer CAN get the receive-pack advertisement (200)", async () => {
    const res = await GET(gitReq("GET", infoRefs("git-receive-pack"), { auth: basic(writerTok) }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-git-receive-pack-advertisement");
  });

  it("owner CAN get both advertisements", async () => {
    const up = await GET(gitReq("GET", infoRefs("git-upload-pack"), { auth: basic(ownerTok) }));
    const rp = await GET(gitReq("GET", infoRefs("git-receive-pack"), { auth: basic(ownerTok) }));
    expect(up.status).toBe(200);
    expect(rp.status).toBe(200);
  });

  it("unparseable path (dumb-HTTP object) → uniform 404", async () => {
    const res = await GET(
      gitReq("GET", `/api/git/${ownerSlug}/acme.git/objects/info/packs`, { auth: basic(ownerTok) }),
    );
    expect(res.status).toBe(404);
  });

  it("reader POST git-receive-pack (a push RPC) → uniform 404 even though they can read", async () => {
    const res = await POST(
      gitReq("POST", `/api/git/${ownerSlug}/acme.git/git-receive-pack`, {
        auth: basic(readerTok),
        body: Buffer.from("0000"),
        contentType: "application/x-git-receive-pack-request",
      }),
    );
    expect(res.status).toBe(404);
  });

  it("wrong owner segment → uniform 404", async () => {
    const res = await GET(
      gitReq("GET", `/api/git/someone-else/acme.git/info/refs?service=git-upload-pack`, {
        auth: basic(ownerTok),
      }),
    );
    expect(res.status).toBe(404);
  });
});
