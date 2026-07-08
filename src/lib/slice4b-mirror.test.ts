/**
 * Convergence fix-pass, Slice 4b — source modes + one-way GitHub mirror-out
 * (durability; finding 5). DATA-EGRESS + WRITE-BOUNDARY sensitive → fail-closed,
 * exhaustive.
 *
 * The fake "GitHub" is a LOCAL BARE REPO in a temp dir, set as `mirror_remote_url`
 * with a plain path — no real PAT/network. Proves:
 *   - `source_mode` defaults to 'hosted' (mirror columns null);
 *   - a hosted space with a mirror URL mirrors `main` OUT after webAuthorCommit +
 *     proposal-accept, and mirror_state.lastMirroredSha tracks the pushed tip;
 *   - a mirror push FAILURE (bad URL) records lastError and does NOT throw / block
 *     the triggering write;
 *   - the PAT + per-space deploy key are stored ENCRYPTED and no service returns
 *     the plaintext (write-only);
 *   - mirrored-mode refusal matrix: webAuthorCommit / publish_doc / acceptRevision
 *     / proposal-accept all REFUSE on a mirrored space;
 *   - credentials never land in the repo's .git/config, and the URL never carries
 *     the token (only the non-secret `x-access-token` username);
 *   - the deploy-key temp keyfile is cleaned up (no /tmp leak).
 *
 * The git-transport half of the matrix (a push to a mirrored space's `main` still
 * SUCCEEDS; a hosted push mirrors out) lives in
 * `src/app/api/git/[...path]/mirror-transport-e2e.test.ts` (needs the live route).
 *
 * Skipped when the host has no usable `git` (mirrors the e2e suites).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { resetDb, seedUser, seedSpaceMember } from "@/test/db";
import { HAVE_GIT, useTempDataDir, clearSpaceRepos, readFileFromClone } from "@/test/git";
import { createSpace, getSpaceBySlug, ownerSlugForUser } from "@/lib/spaces";
import { webAuthorCommit, liveMainTip } from "@/lib/web-author";
import { createRevision, acceptRevision } from "@/lib/revisions";
import { acceptProposalForSpace } from "@/lib/proposals-service";
import {
  mirrorPush,
  mirrorNow,
  enqueueMirror,
  settleMirror,
  setMirrorConfig,
  setSpaceDeployKey,
  hasSpaceDeployKey,
  clearSpaceDeployKey,
  classifyRemote,
  injectHttpsUsername,
  __setMirrorRetryForTests,
} from "@/lib/mirror";
import {
  setInstanceGithubPat,
  hasInstanceGithubPat,
  getInstanceGithubPat,
  clearInstanceGithubPat,
  INSTANCE_GITHUB_PAT_KEY,
} from "@/lib/instance-settings";
import { decryptToken } from "@/lib/crypto";
import { bareRepoPath, refTip, DEFAULT_BRANCH } from "@/lib/git/repo";
import { TOOLS, type ToolDef } from "@/lib/mcp/tools";
import type { Principal } from "@/lib/auth";

const run = promisify(execFile);
const TEST_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="; // 32-byte base64
const admin: Principal = { kind: "admin", name: "Admin" };
const SPACE = "proof";

/** Owner-namespace S5: the space-scoped service helpers now take a spaceId (a
 * slug is no longer unique). This single-owner test resolves the id from the slug
 * via the still-exported transitional `getSpaceBySlug`; an unknown slug → -1 so
 * the fail-closed paths still exercise. */
async function sid(slug: string = SPACE): Promise<number> {
  return (await getSpaceBySlug(slug))?.id ?? -1;
}

function tool(name: string): ToolDef {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

/** Init a throwaway bare repo to act as the fake GitHub mirror remote. */
async function initFakeRemote(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "desk-fake-github-"));
  const bare = path.join(dir, "gh.git");
  await run("git", ["init", "--bare", "--initial-branch=main", bare]);
  return { path: bare, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

// ── source_mode default + mirror config (no git needed, but grouped for setup) ──
describe("Slice 4b — source_mode default + config", () => {
  let ownerUserId: number;

  beforeEach(async () => {
    await resetDb();
    ownerUserId = await seedUser({ tokenName: "lucas", displayName: "Lucas", role: "admin" });
  });

  it("source_mode defaults to 'hosted' and mirror columns start null", async () => {
    const created = await createSpace(SPACE, ownerUserId, "private", "t");
    expect(created.ok).toBe(true);
    const space = await getSpaceBySlug(SPACE);
    expect(space!.sourceMode).toBe("hosted");
    expect(space!.mirrorRemoteUrl).toBeNull();
    expect(space!.mirrorState).toBeNull();
    expect(space!.mirrorDeployKeyEnc).toBeNull();
  });

  it("setMirrorConfig sets mode + url, and clears url with null", async () => {
    await createSpace(SPACE, ownerUserId, "private", "t");
    const r = await setMirrorConfig(await sid(), { sourceMode: "mirrored", mirrorRemoteUrl: "https://github.com/o/r.git" });
    expect(r.ok).toBe(true);
    let space = await getSpaceBySlug(SPACE);
    expect(space!.sourceMode).toBe("mirrored");
    expect(space!.mirrorRemoteUrl).toBe("https://github.com/o/r.git");

    await setMirrorConfig(await sid(), { mirrorRemoteUrl: null });
    space = await getSpaceBySlug(SPACE);
    expect(space!.mirrorRemoteUrl).toBeNull();
    expect(space!.sourceMode).toBe("mirrored"); // unchanged
  });

  it("setMirrorConfig on an unknown space fails closed", async () => {
    const r = await setMirrorConfig(await sid("no-such"), { sourceMode: "mirrored" });
    expect(r.ok).toBe(false);
  });
});

// ── credential encryption (write-only) ─────────────────────────────────────────
describe("Slice 4b — credentials stored encrypted (write-only)", () => {
  let ownerUserId: number;
  let prevKey: string | undefined;

  beforeAll(() => {
    prevKey = process.env.DESK_TOKEN_KEY;
    process.env.DESK_TOKEN_KEY = TEST_KEY;
  });
  afterAll(() => {
    if (prevKey === undefined) delete process.env.DESK_TOKEN_KEY;
    else process.env.DESK_TOKEN_KEY = prevKey;
  });

  beforeEach(async () => {
    await resetDb();
    ownerUserId = await seedUser({ tokenName: "lucas", displayName: "Lucas", role: "admin" });
    await createSpace(SPACE, ownerUserId, "private", "t");
  });

  it("the instance PAT is stored ENCRYPTED at rest and never returned in cleartext by any list/has path", async () => {
    const PAT = "github_pat_super_secret_value_123";
    expect(await setInstanceGithubPat(PAT)).toBe(true);

    // The raw stored ciphertext is NOT the plaintext.
    const [row] = await db
      .select()
      .from(schema.instanceSettings)
      .where(eq(schema.instanceSettings.key, INSTANCE_GITHUB_PAT_KEY));
    expect(row).toBeTruthy();
    expect(row.valueEnc).not.toContain(PAT);
    expect(row.valueEnc).not.toBe(PAT);
    // It IS a real AES-GCM ciphertext (iv.ct.tag) that decrypts back.
    expect(row.valueEnc.split(".").length).toBe(3);
    expect(decryptToken(row.valueEnc)).toBe(PAT);

    // has → boolean only (no reveal); the ONLY decrypt path is the internal getter
    // (mirror push), which is never wired to any API/route.
    expect(await hasInstanceGithubPat()).toBe(true);
    expect(await getInstanceGithubPat()).toBe(PAT);

    await clearInstanceGithubPat();
    expect(await hasInstanceGithubPat()).toBe(false);
    expect(await getInstanceGithubPat()).toBeNull();
  });

  it("a per-space deploy key is stored ENCRYPTED and never returned in cleartext", async () => {
    const PEM = "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAsecretkeymaterial\n-----END OPENSSH PRIVATE KEY-----";
    expect(await setSpaceDeployKey(await sid(), PEM)).toBe(true);
    expect(await hasSpaceDeployKey(await sid())).toBe(true);

    const space = await getSpaceBySlug(SPACE);
    expect(space!.mirrorDeployKeyEnc).toBeTruthy();
    expect(space!.mirrorDeployKeyEnc).not.toContain("secretkeymaterial");
    expect(decryptToken(space!.mirrorDeployKeyEnc!)).toBe(PEM);

    await clearSpaceDeployKey(await sid());
    expect(await hasSpaceDeployKey(await sid())).toBe(false);
  });

  it("without DESK_TOKEN_KEY, setInstanceGithubPat REFUSES to store plaintext", async () => {
    const saved = process.env.DESK_TOKEN_KEY;
    delete process.env.DESK_TOKEN_KEY;
    try {
      expect(await setInstanceGithubPat("plain")).toBe(false);
      expect(await hasInstanceGithubPat()).toBe(false);
    } finally {
      process.env.DESK_TOKEN_KEY = saved;
    }
  });
});

// ── egress-proof pure helpers (no token in URL) ────────────────────────────────
describe("Slice 4b — URL classification never embeds the token", () => {
  it("classifies remotes by scheme", () => {
    expect(classifyRemote("https://github.com/o/r.git")).toBe("https");
    expect(classifyRemote("http://example.com/o/r.git")).toBe("https");
    expect(classifyRemote("git@github.com:o/r.git")).toBe("ssh");
    expect(classifyRemote("ssh://git@github.com/o/r.git")).toBe("ssh");
    expect(classifyRemote("file:///tmp/x.git")).toBe("local");
    expect(classifyRemote("/tmp/x.git")).toBe("local");
  });

  it("injectHttpsUsername adds only the non-secret x-access-token username", () => {
    expect(injectHttpsUsername("https://github.com/o/r.git")).toBe(
      "https://x-access-token@github.com/o/r.git",
    );
    // Already has userinfo → untouched.
    expect(injectHttpsUsername("https://user@github.com/o/r.git")).toBe(
      "https://user@github.com/o/r.git",
    );
  });
});

// ── mirror-out + refusal (git-gated) ───────────────────────────────────────────
describe.skipIf(!HAVE_GIT)("Slice 4b — mirror-out + refusal (git)", () => {
  let restore: () => Promise<void>;
  let ownerUserId: number;
  let ownerSlug: string;
  let spaceId: number;
  let prevKey: string | undefined;

  beforeAll(async () => {
    ({ restore } = await useTempDataDir());
    prevKey = process.env.DESK_TOKEN_KEY;
    process.env.DESK_TOKEN_KEY = TEST_KEY;
  });
  afterAll(async () => {
    if (prevKey === undefined) delete process.env.DESK_TOKEN_KEY;
    else process.env.DESK_TOKEN_KEY = prevKey;
    await restore();
  });

  beforeEach(async () => {
    await resetDb();
    await clearSpaceRepos();
    ownerUserId = await seedUser({ tokenName: "lucas", displayName: "Lucas", role: "admin" });
    const created = await createSpace(SPACE, ownerUserId, "private", "t");
    if (!created.ok) throw new Error(created.error);
    spaceId = created.space.id;
    ownerSlug = ownerSlugForUser({ tokenName: "lucas", email: null }, ownerUserId);
  });

  const repoPath = () => bareRepoPath(ownerSlug, SPACE);
  const ownerIdentity = { name: "Lucas", email: "lucas@desk.localhost", handle: "lucas" };

  /** Commit a file to main via the owner path, returning the new main tip.
   * Uses liveMainTip (null when the bare repo doesn't exist yet — the first
   * commit) so we never spawn git in a non-existent cwd. */
  async function commitMain(p: string, content: string): Promise<string> {
    const baseMainTip = await liveMainTip(await sid());
    const r = await webAuthorCommit(await sid(), {
      role: "owner",
      identity: ownerIdentity,
      writes: [{ path: p, bytes: Buffer.from(content, "utf8") }],
      baseMainTip,
      message: `commit ${p}`,
    });
    if (!r.ok) throw new Error(`commit failed: ${r.reason}`);
    return r.newSha;
  }

  it("webAuthorCommit on a hosted space mirrors main OUT to the fake remote", async () => {
    const remote = await initFakeRemote();
    try {
      // Establish main + point the mirror at the fake remote.
      await commitMain("readme.md", "# Readme\n");
      await setMirrorConfig(await sid(), { mirrorRemoteUrl: remote.path });

      // A main-advancing commit → the hook enqueues a mirror push.
      await commitMain("reports/q1.md", "# Q1\n\nrevenue up\n");
      await settleMirror(spaceId);

      // The fake remote's main now carries the committed file.
      expect(await readFileFromClone(remote.path, "reports/q1.md")).toContain("revenue up");
      // mirror_state tracks the pushed tip, no error.
      const tip = await refTip(repoPath(), DEFAULT_BRANCH);
      const space = await getSpaceBySlug(SPACE);
      expect(space!.mirrorState!.lastMirroredSha).toBe(tip);
      expect(space!.mirrorState!.lastError).toBeNull();
      expect(space!.mirrorState!.lastAttemptAt).toBeTruthy();
    } finally {
      await remote.cleanup();
    }
  });

  it("proposal-accept on a hosted space mirrors the merged main OUT", async () => {
    const remote = await initFakeRemote();
    try {
      // main + a writer-authored proposal ref (proposal policy).
      await commitMain("readme.md", "hello\n");
      await setMirrorConfig(await sid(), { mirrorRemoteUrl: remote.path });
      const { setSpacePushPolicy } = await import("@/lib/spaces");
      await setSpacePushPolicy(await sid(), "proposal", "t");

      const writerId = await seedUser({ tokenName: "alex", displayName: "Alex", role: "member" });
      await seedSpaceMember(spaceId, writerId, "writer");
      const prop = await webAuthorCommit(await sid(), {
        role: "writer",
        identity: { name: "Alex", email: "alex@desk.localhost", handle: "alex" },
        writes: [{ path: "reports/draft.md", bytes: Buffer.from("# Draft\n\nwip\n", "utf8") }],
        baseMainTip: await refTip(repoPath(), DEFAULT_BRANCH),
        message: "propose draft",
      });
      expect(prop.ok).toBe(true);
      if (!prop.ok) return;
      const name = prop.proposalName!;

      const acc = await acceptProposalForSpace(await sid(), name, { name: "Lucas", email: "l@x" });
      expect(acc.ok).toBe(true);
      await settleMirror(spaceId);

      // The merged content reached the fake remote's main.
      expect(await readFileFromClone(remote.path, "reports/draft.md")).toContain("wip");
      const tip = await refTip(repoPath(), DEFAULT_BRANCH);
      const space = await getSpaceBySlug(SPACE);
      expect(space!.mirrorState!.lastMirroredSha).toBe(tip);
      expect(space!.mirrorState!.lastError).toBeNull();
    } finally {
      await remote.cleanup();
    }
  });

  it("a FAILING mirror push (bad URL) records lastError and does NOT fail the write", async () => {
    const restoreRetry = __setMirrorRetryForTests({ maxAttempts: 2, baseMs: 5, maxMs: 10 });
    try {
      await commitMain("readme.md", "hi\n");
      await setMirrorConfig(await sid(), { mirrorRemoteUrl: "/nonexistent/definitely-not-a-repo.git" });

      // The triggering write SUCCEEDS despite the mirror being doomed.
      const before = await refTip(repoPath(), DEFAULT_BRANCH);
      const sha = await commitMain("more.md", "more\n");
      expect(sha).not.toBe(before);
      await settleMirror(spaceId);

      // main advanced on Desk (canon intact) but the mirror recorded an error.
      expect(await readFileFromClone(repoPath(), "more.md")).toBe("more\n");
      const space = await getSpaceBySlug(SPACE);
      expect(space!.mirrorState!.lastError).toBeTruthy();
    } finally {
      restoreRetry();
    }
  });

  it("mirrorNow gates: unknown / not-hosted / no-remote", async () => {
    expect((await mirrorNow(await sid("no-such"))).ok).toBe(false);
    await createSpace("hosted-no-remote", ownerUserId, "private", "t");
    const noRemote = await mirrorNow(await sid("hosted-no-remote"));
    expect(noRemote.ok).toBe(false);
    if (!noRemote.ok) expect(noRemote.reason).toBe("no-remote");

    await setMirrorConfig(await sid(), { sourceMode: "mirrored", mirrorRemoteUrl: "/x.git" });
    const mirrored = await mirrorNow(await sid());
    expect(mirrored.ok).toBe(false);
    if (!mirrored.ok) expect(mirrored.reason).toBe("not-hosted");
  });

  it("mirror push NEVER writes the remote/credential into the repo's .git/config", async () => {
    const remote = await initFakeRemote();
    try {
      await commitMain("readme.md", "hi\n");
      await setMirrorConfig(await sid(), { mirrorRemoteUrl: remote.path });
      // Also set a PAT — it must never be persisted anywhere on disk.
      await setInstanceGithubPat("github_pat_should_never_touch_config");

      const space = await getSpaceBySlug(SPACE);
      await mirrorPush(space!);

      // The bare repo's config carries NO mirror remote + NO token.
      const config = await readFile(path.join(repoPath(), "config"), "utf8");
      expect(config).not.toContain(remote.path);
      expect(config).not.toContain("github_pat_should_never_touch_config");
      expect(config).not.toContain("x-access-token");
      expect(config).not.toMatch(/\[remote /);
    } finally {
      await clearInstanceGithubPat();
      await remote.cleanup();
    }
  });

  it("a deploy-key push cleans up its temp keyfile (no /tmp leak)", async () => {
    await commitMain("readme.md", "hi\n");
    // An ssh remote that will fail to connect — we only assert cleanup + no throw.
    await setMirrorConfig(await sid(), { mirrorRemoteUrl: "git@github.invalid:o/r.git" });
    await setSpaceDeployKey(await sid(), "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----");

    const before = (await readdir(tmpdir())).filter((d) => d.startsWith("desk-mirror-key-")).length;
    const space = await getSpaceBySlug(SPACE);
    const state = await mirrorPush(space!); // won't throw; records an error
    expect(state.lastError).toBeTruthy();
    const after = (await readdir(tmpdir())).filter((d) => d.startsWith("desk-mirror-key-")).length;
    expect(after).toBe(before); // temp keyfile dir was removed in finally
  });

  // ── mirrored-mode write-refusal matrix ───────────────────────────────────────
  describe("mirrored-mode refusal matrix", () => {
    beforeEach(async () => {
      // Establish a real doc while hosted, THEN flip to mirrored.
      await commitMain("os/guide.md", "# Guide\n\nbody\n");
      await setMirrorConfig(await sid(), { sourceMode: "mirrored", mirrorRemoteUrl: "/gh.git" });
    });

    it("webAuthorCommit is refused", async () => {
      const r = await webAuthorCommit(await sid(), {
        role: "owner",
        identity: ownerIdentity,
        writes: [{ path: "os/guide.md", bytes: Buffer.from("# Guide\n\nEDIT\n", "utf8") }],
        baseMainTip: await refTip(repoPath(), DEFAULT_BRANCH),
        message: "edit",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("mirrored");
      // The doc was NOT changed.
      expect(await readFileFromClone(repoPath(), "os/guide.md")).toBe("# Guide\n\nbody\n");
    });

    it("MCP publish_doc is refused with a clear mirror error", async () => {
      const res = await tool("publish_doc").handler(admin, {
        space: SPACE,
        path: "os/new.md",
        content: "x",
      } as never);
      expect(res.isError).toBe(true);
      const text = JSON.stringify(res.content ?? res.structuredContent ?? "");
      expect(text.toLowerCase()).toContain("mirror");
    });

    it("acceptRevision is refused", async () => {
      // Find the guide doc's slug via its projection.
      const [doc] = await db
        .select({ slug: schema.docs.slug })
        .from(schema.docs)
        .where(eq(schema.docs.sourcePath, "os/guide.md"));
      const rev = await createRevision({
        slug: doc.slug,
        authorName: "Alex",
        authorKind: "member",
        scope: { viewer: "admin" },
        content: "# Guide\n\nSUGGESTED\n",
      });
      expect(rev).not.toBeNull();
      const acc = await acceptRevision(rev!.id, { by: "Owner" });
      expect(acc.ok).toBe(false);
      if (!acc.ok) expect(acc.reason).toBe("mirrored");
    });

    it("proposal-accept is refused (before the proposal is even resolved)", async () => {
      const acc = await acceptProposalForSpace(await sid(), "anything", { name: "Lucas", email: "l@x" });
      expect(acc.ok).toBe(false);
      if (!acc.ok) expect(acc.reason).toBe("mirrored");
    });

    it("enqueueMirror is a no-op on a mirrored space (never mirrors out)", async () => {
      const remote = await initFakeRemote();
      try {
        await setMirrorConfig(await sid(), { sourceMode: "mirrored", mirrorRemoteUrl: remote.path });
        enqueueMirror(spaceId);
        await settleMirror(spaceId);
        // The fake remote received nothing — a mirrored space never pushes out.
        expect(await readFileFromClone(remote.path, "os/guide.md")).toBeNull();
      } finally {
        await remote.cleanup();
      }
    });
  });
});
