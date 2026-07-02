import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { resetDb } from "@/test/db";
import { db, schema } from "@/db";
import { runGit } from "./repo";
import { importRepoAsSpace, isExcludedFromImport, trackedImportFiles } from "./import";

const GIT_ENV = {
  GIT_AUTHOR_NAME: "T",
  GIT_AUTHOR_EMAIL: "t@x",
  GIT_COMMITTER_NAME: "T",
  GIT_COMMITTER_EMAIL: "t@x",
};

/** Build a source git repo (fixture) with tracked + gitignored + sensitive files. */
async function buildFixtureRepo(root: string): Promise<void> {
  await runGit(["init", "--initial-branch=main", root]);
  const w = async (rel: string, content: string) => {
    const dst = path.join(root, rel);
    await mkdir(path.dirname(dst), { recursive: true });
    await writeFile(dst, content);
  };
  await w(".gitignore", "ignored.md\nnode_modules/\n");
  await w("README.md", "# Readme\nintro");
  await w("docs/guide.md", "---\ntitle: Guide\n---\n# Guide\ncontent");
  await w("data/registry.yml", "x: 1");
  // Sensitive (tracked) — MUST be excluded by import.
  await w(".env", "SECRET=abc");
  await w(".env.local", "DB=...");
  await w("CLAUDE.local.md", "private agent notes");
  await w("personal/notes.md", "# private");
  // Gitignored — never tracked, so never imported.
  await w("ignored.md", "# should not appear");
  await runGit(["add", "-A"], { cwd: root });
  await runGit(["commit", "-m", "fixture"], { cwd: root, env: GIT_ENV });
}

describe("git import — exclusion predicate", () => {
  it("excludes secrets, personal, CLAUDE.local.md, .git, .desk-data", () => {
    for (const p of [".env", ".env.local", ".env.production", "personal/x.md", "personal", "CLAUDE.local.md", "sub/CLAUDE.local.md", ".git/config", ".desk-data/spaces"]) {
      expect(isExcludedFromImport(p)).toBe(true);
    }
  });
  it("keeps ordinary docs + registries", () => {
    for (const p of ["README.md", "docs/guide.md", "data/registry.yml", "env-vars.md"]) {
      expect(isExcludedFromImport(p)).toBe(false);
    }
  });
});

describe("git import — repo → space", () => {
  let src: string;
  let dataDir: string;
  let prevDataDir: string | undefined;
  let ownerId: number;

  beforeEach(async () => {
    await resetDb();
    src = await mkdtemp(path.join(tmpdir(), "desk-import-src-"));
    dataDir = await mkdtemp(path.join(tmpdir(), "desk-import-data-"));
    prevDataDir = process.env.DESK_DATA_DIR;
    process.env.DESK_DATA_DIR = dataDir; // bare repos land here
    await buildFixtureRepo(src);
    const [owner] = await db
      .insert(schema.users)
      .values({ tokenName: "lucas", displayName: "Lucas", role: "admin", active: 1 })
      .returning({ id: schema.users.id });
    ownerId = owner.id;
  });

  afterEach(async () => {
    if (prevDataDir === undefined) delete process.env.DESK_DATA_DIR;
    else process.env.DESK_DATA_DIR = prevDataDir;
    await rm(src, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  });

  it("trackedImportFiles excludes sensitive + gitignored files", async () => {
    const files = await trackedImportFiles(src);
    expect(files).toContain("README.md");
    expect(files).toContain("docs/guide.md");
    expect(files).toContain("data/registry.yml");
    // excluded
    expect(files).not.toContain(".env");
    expect(files).not.toContain(".env.local");
    expect(files).not.toContain("CLAUDE.local.md");
    expect(files).not.toContain("personal/notes.md");
    // gitignored (never tracked)
    expect(files).not.toContain("ignored.md");
  });

  it("imports a space, seeds the bare repo, and backfills the projection", async () => {
    const res = await importRepoAsSpace({
      sourceDir: src,
      slug: "workspace",
      ownerUserId: ownerId,
      actorName: "tester",
    });
    expect(res.spaceSlug).toBe("workspace");
    expect(res.committed).toBe(4); // .gitignore, README, docs/guide, data/registry (sensitive excluded)
    expect(res.excluded).toBe(4); // .env, .env.local, CLAUDE.local.md, personal/notes
    expect(res.indexed).toBe(2); // README.md + docs/guide.md (registry.yml + .gitignore are non-doc)
    expect(res.commit).not.toBeNull();

    // The space exists + owner is a member.
    const space = await db.query.spaces.findFirst({ where: eq(schema.spaces.slug, "workspace") });
    expect(space).toBeTruthy();
    const member = await db.query.spaceMembers.findFirst({
      where: eq(schema.spaceMembers.spaceId, space!.id),
    });
    expect(member?.role).toBe("owner");

    // Projection: docs from the renderable files only.
    const docs = await db.select().from(schema.docs).where(eq(schema.docs.spaceId, space!.id));
    // Identity is now an opaque id — docs are addressed by sourcePath.
    const sourcePaths = docs.map((d) => d.sourcePath).sort();
    expect(sourcePaths).toEqual(["README.md", "docs/guide.md"]);
    const guide = docs.find((d) => d.sourcePath === "docs/guide.md")!;
    expect(guide.title).toBe("Guide");
    expect(guide.spaceId).toBe(space!.id);
    expect(guide.slug).toMatch(/^[a-z0-9]{9}$/); // opaque, not path-derived

    // Secrets never entered the bare repo — verify via ls-tree of the seed commit.
    const tree = await runGit(["ls-tree", "-r", "--name-only", "HEAD"], { cwd: res.repoPath });
    const names = tree.stdout.toString();
    expect(names).toContain("README.md");
    expect(names).not.toContain(".env");
    expect(names).not.toContain("CLAUDE.local.md");
    expect(names).not.toContain("personal/");
  });

  it("refuses to re-import an existing slug", async () => {
    await importRepoAsSpace({ sourceDir: src, slug: "workspace", ownerUserId: ownerId });
    await expect(
      importRepoAsSpace({ sourceDir: src, slug: "workspace", ownerUserId: ownerId }),
    ).rejects.toThrow(/already exists/);
  });
});
