/**
 * Owner-namespace, Slice S2 (decision D3) — repo path via the stable handle +
 * the one-time boot migration that re-points existing bare repos.
 *
 * Proves:
 *   - `spaceRepoPath` derives the on-disk path from the owner's stored
 *     `users.handle`, NOT the mutable email — so an email change never changes
 *     the path (the repo-orphan bug-fix), and a NULL handle is assigned on read
 *     (never a silent email fallback);
 *   - `migrateRepoPathsToHandle` MOVES a repo whose legacy (email-derived) path
 *     differs from the handle path, with content intact and readable at the new
 *     path; a re-run is a no-op; a space already at the handle path is skipped;
 *     and a pre-existing target is NEVER clobbered (a logged conflict).
 *
 * The migration cases spawn real `git`, so they skip gracefully when git is
 * absent (mirroring the other on-disk suites). Everything runs under a throwaway
 * DESK_DATA_DIR — never the working tree's .desk-data.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { resetDb, seedUser, seedSpace } from "@/test/db";
import { HAVE_GIT, useTempDataDir, clearSpaceRepos, readFileFromClone } from "@/test/git";
import { bareRepoPath, initBareRepo, repoExists, runGit } from "@/lib/git/repo";
import { ownerSlugForUser } from "@/lib/spaces";
import { spaceRepoPath, migrateRepoPathsToHandle } from "@/lib/space-repo-path";

/** Set a user's handle directly (bypassing the derive helpers) so a test can
 *  make it DIFFER from the email-derived slug. */
async function setHandle(userId: number, handle: string): Promise<void> {
  await db.update(schema.users).set({ handle }).where(eq(schema.users.id, userId));
}

/** Repoint a user's primary email (the mutation that used to orphan repos). */
async function setEmail(userId: number, email: string): Promise<void> {
  await db.update(schema.users).set({ email }).where(eq(schema.users.id, userId));
}

/** Create a real bare repo at `repoPath` with ONE commit containing `file`, so a
 *  later clone can prove the content survived a move. */
async function seedBareRepoWithFile(
  repoPath: string,
  file: string,
  content: string,
): Promise<void> {
  await initBareRepo(repoPath);
  const work = await mkdtemp(path.join(tmpdir(), "desk-s2-seed-"));
  const env = {
    GIT_AUTHOR_NAME: "T",
    GIT_AUTHOR_EMAIL: "t@l",
    GIT_COMMITTER_NAME: "T",
    GIT_COMMITTER_EMAIL: "t@l",
  };
  try {
    await runGit(["init", "--initial-branch=main", work]);
    await writeFile(path.join(work, file), content);
    await runGit(["add", "-A"], { cwd: work });
    await runGit(["commit", "-m", "seed"], { cwd: work, env });
    await runGit(["push", repoPath, "HEAD:main"], { cwd: work, env });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

describe("Owner-namespace S2 — repo path via handle", () => {
  let restore: () => Promise<void>;

  beforeAll(async () => {
    ({ restore } = await useTempDataDir());
  });
  afterAll(async () => {
    await restore();
  });
  beforeEach(async () => {
    await resetDb();
    await clearSpaceRepos();
  });

  describe("spaceRepoPath derives from the handle, not the email", () => {
    it("an email change does NOT change the repo path (the orphan-bug fix)", async () => {
      const ownerId = await seedUser({ email: "lucas@a.com", displayName: "Lucas" });
      await setHandle(ownerId, "stable-handle");

      const before = await spaceRepoPath({ ownerUserId: ownerId, slug: "myspace" });

      // Repoint the primary email — the mutation that used to relocate the path.
      await setEmail(ownerId, "renamed@b.com");
      const after = await spaceRepoPath({ ownerUserId: ownerId, slug: "myspace" });

      expect(after).toBe(before);
      // The path is keyed on the HANDLE segment...
      expect(after).toBe(bareRepoPath("stable-handle", "myspace"));
      // ...and NEVER on either email's local-part (which is exactly what the old
      // ownerSlugForUser derivation would have produced — and would have moved).
      expect(after).not.toBe(bareRepoPath("lucas", "myspace"));
      expect(after).not.toBe(bareRepoPath("renamed", "myspace"));
    });

    it("a NULL handle is ASSIGNED on read (never a silent email fallback)", async () => {
      const ownerId = await seedUser({ email: "ghost@a.com", displayName: "Ghost" }); // handle stays NULL
      const p = await spaceRepoPath({ ownerUserId: ownerId, slug: "s" });

      const [u] = await db
        .select({ handle: schema.users.handle })
        .from(schema.users)
        .where(eq(schema.users.id, ownerId));
      // A stable handle was persisted (assign-on-read), and the path uses it.
      expect(u.handle).toBe("ghost");
      expect(p).toBe(bareRepoPath("ghost", "s"));

      // Proof it's now decoupled: change the email, path is unchanged.
      await setEmail(ownerId, "someoneelse@x.com");
      expect(await spaceRepoPath({ ownerUserId: ownerId, slug: "s" })).toBe(p);
    });
  });

  describe.skipIf(!HAVE_GIT)("migrateRepoPathsToHandle", () => {
    it("MOVES a repo whose legacy path differs from the handle path (content intact)", async () => {
      const ownerId = await seedUser({ email: "lucas@a.com", displayName: "Lucas" });
      await setHandle(ownerId, "lucas-2"); // handle differs from email-local 'lucas'
      await seedSpace({ slug: "proj", ownerId });

      const legacyPath = bareRepoPath(
        ownerSlugForUser({ tokenName: null, email: "lucas@a.com" }, ownerId), // 'lucas'
        "proj",
      );
      const newPath = bareRepoPath("lucas-2", "proj");
      expect(legacyPath).not.toBe(newPath);

      await seedBareRepoWithFile(legacyPath, "hello.txt", "hi from legacy");

      const res = await migrateRepoPathsToHandle();
      expect(res.moved).toBe(1);
      expect(res.conflicts).toBe(0);

      // The repo is now at the handle path only, with its content intact.
      expect(await repoExists(legacyPath)).toBe(false);
      expect(await repoExists(newPath)).toBe(true);
      expect(await readFileFromClone(newPath, "hello.txt")).toBe("hi from legacy");
      // And the production resolver agrees.
      expect(await spaceRepoPath({ ownerUserId: ownerId, slug: "proj" })).toBe(newPath);
    });

    it("is idempotent — a re-run moves nothing and leaves the repo at the handle path", async () => {
      const ownerId = await seedUser({ email: "lucas@a.com", displayName: "Lucas" });
      await setHandle(ownerId, "lucas-2");
      await seedSpace({ slug: "proj", ownerId });
      const legacyPath = bareRepoPath("lucas", "proj");
      const newPath = bareRepoPath("lucas-2", "proj");
      await seedBareRepoWithFile(legacyPath, "hello.txt", "hi");

      const first = await migrateRepoPathsToHandle();
      expect(first.moved).toBe(1);

      const second = await migrateRepoPathsToHandle();
      expect(second.moved).toBe(0);
      expect(second.skipped).toBe(1); // no repo left at the legacy path
      expect(await repoExists(newPath)).toBe(true);
      expect(await readFileFromClone(newPath, "hello.txt")).toBe("hi");
    });

    it("SKIPS a space already at the handle-derived path (legacy === new)", async () => {
      const ownerId = await seedUser({ email: "lucas@a.com", displayName: "Lucas" });
      await setHandle(ownerId, "lucas"); // handle == email-local → legacy path == new path
      await seedSpace({ slug: "proj", ownerId });
      const repoPath = bareRepoPath("lucas", "proj");
      await seedBareRepoWithFile(repoPath, "hello.txt", "hi");

      const res = await migrateRepoPathsToHandle();
      expect(res.moved).toBe(0);
      expect(res.skipped).toBe(1);
      // Untouched, still readable.
      expect(await repoExists(repoPath)).toBe(true);
      expect(await readFileFromClone(repoPath, "hello.txt")).toBe("hi");
    });

    it("NEVER clobbers an existing target — logs a conflict and leaves both", async () => {
      const ownerId = await seedUser({ email: "lucas@a.com", displayName: "Lucas" });
      await setHandle(ownerId, "lucas-2");
      await seedSpace({ slug: "proj", ownerId });
      const legacyPath = bareRepoPath("lucas", "proj");
      const newPath = bareRepoPath("lucas-2", "proj");

      // Both a legacy AND a (distinct-content) target already exist.
      await seedBareRepoWithFile(legacyPath, "f.txt", "legacy-content");
      await seedBareRepoWithFile(newPath, "f.txt", "target-content");

      const res = await migrateRepoPathsToHandle();
      expect(res.moved).toBe(0);
      expect(res.conflicts).toBe(1);

      // Both survive, each with its own content (the target was NOT overwritten).
      expect(await repoExists(legacyPath)).toBe(true);
      expect(await repoExists(newPath)).toBe(true);
      expect(await readFileFromClone(legacyPath, "f.txt")).toBe("legacy-content");
      expect(await readFileFromClone(newPath, "f.txt")).toBe("target-content");
    });

    it("moves only the mismatched space, skipping ones already at the handle path", async () => {
      // Owner A: handle differs → will move.
      const a = await seedUser({ email: "lucas@a.com", displayName: "Lucas" });
      await setHandle(a, "lucas-2");
      await seedSpace({ slug: "aproj", ownerId: a });
      const aLegacy = bareRepoPath("lucas", "aproj");
      const aNew = bareRepoPath("lucas-2", "aproj");
      await seedBareRepoWithFile(aLegacy, "x", "A");

      // Owner B: handle == email-local → already correct, skipped.
      const b = await seedUser({ email: "bob@b.com", displayName: "Bob" });
      await setHandle(b, "bob");
      await seedSpace({ slug: "bproj", ownerId: b });
      const bPath = bareRepoPath("bob", "bproj");
      await seedBareRepoWithFile(bPath, "x", "B");

      const res = await migrateRepoPathsToHandle();
      expect(res.scanned).toBe(2);
      expect(res.moved).toBe(1);
      expect(res.skipped).toBe(1);

      expect(await repoExists(aLegacy)).toBe(false);
      expect(await repoExists(aNew)).toBe(true);
      expect(await repoExists(bPath)).toBe(true);
      expect(await readFileFromClone(aNew, "x")).toBe("A");
      expect(await readFileFromClone(bPath, "x")).toBe("B");
    });
  });
});
