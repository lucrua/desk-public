/**
 * listSpaceFiles surfaces the REAL projected slug (the opaque id) for doc-type
 * files — never a path-derived one — so the space git-tree file view links to a
 * URL that actually resolves. Non-doc files carry no slug (they link to raw).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { resetDb } from "@/test/db";
import { db, schema } from "@/db";
import { runGit } from "@/lib/git/repo";
import { importRepoAsSpace } from "@/lib/git/import";
import { listSpaceFiles } from "@/lib/web-author";

const GIT_ENV = {
  GIT_AUTHOR_NAME: "T",
  GIT_AUTHOR_EMAIL: "t@x",
  GIT_COMMITTER_NAME: "T",
  GIT_COMMITTER_EMAIL: "t@x",
};

describe("listSpaceFiles — real opaque slugs", () => {
  let src: string;
  let dataDir: string;
  let prevDataDir: string | undefined;
  let ownerId: number;

  beforeEach(async () => {
    await resetDb();
    src = await mkdtemp(path.join(tmpdir(), "desk-wa-src-"));
    dataDir = await mkdtemp(path.join(tmpdir(), "desk-wa-data-"));
    prevDataDir = process.env.DESK_DATA_DIR;
    process.env.DESK_DATA_DIR = dataDir; // bare repos land here (canonical path)
    await runGit(["init", "--initial-branch=main", src]);
    await writeFile(path.join(src, "README.md"), "# Readme\nhello");
    await mkdir(path.join(src, "img"), { recursive: true });
    await writeFile(path.join(src, "img/logo.png"), "PNGDATA");
    await runGit(["add", "-A"], { cwd: src });
    await runGit(["commit", "-m", "init"], { cwd: src, env: GIT_ENV });
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

  it("gives a doc file its real projected slug, and a non-doc file none", async () => {
    await importRepoAsSpace({ sourceDir: src, slug: "workspace", ownerUserId: ownerId, actorName: "t" });
    const files = await listSpaceFiles("workspace");
    const byPath = Object.fromEntries(files.map((f) => [f.path, f]));

    const [readmeDoc] = await db
      .select()
      .from(schema.docs)
      .where(eq(schema.docs.sourcePath, "README.md"));
    expect(byPath["README.md"].isDoc).toBe(true);
    expect(byPath["README.md"].docSlug).toBe(readmeDoc.slug); // the REAL opaque id
    expect(byPath["README.md"].docSlug).toMatch(/^[a-z0-9]{9}$/);

    expect(byPath["img/logo.png"].isDoc).toBe(false);
    expect(byPath["img/logo.png"].docSlug).toBeUndefined();
  });
});
