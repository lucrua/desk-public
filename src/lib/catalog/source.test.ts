import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resetDb, seedUser } from "@/test/db";
import { createSpace, ownerSlugForSpace, getSpaceBySlug } from "@/lib/spaces";
import { initBareRepo, bareRepoPath, runGit } from "@/lib/git/repo";
import { reindexSpaceFull } from "@/lib/git/indexer";
import type { ViewerScope } from "@/lib/docs";
import {
  catalogSpaces,
  directoriesInSpace,
  catalogDocs,
  readCollectionConfig,
} from "./source";
import { projectCatalog } from "./projection";

const GIT_ENV = {
  GIT_AUTHOR_NAME: "T",
  GIT_AUTHOR_EMAIL: "t@x",
  GIT_COMMITTER_NAME: "T",
  GIT_COMMITTER_EMAIL: "t@x",
};

const ADMIN: ViewerScope = { viewer: "admin" };

let dataDir: string;
let prevDataDir: string | undefined;

/** Commit a set of files into a bare repo (via a throwaway working clone). */
async function commitFiles(bareRepo: string, files: Record<string, string>): Promise<void> {
  const work = await mkdtemp(path.join(tmpdir(), "desk-cat-work-"));
  try {
    const clone = await runGit(["clone", bareRepo, work]);
    if (clone.code !== 0) {
      await runGit(["init", "--initial-branch=main", work]);
      await runGit(["remote", "add", "origin", bareRepo], { cwd: work });
    }
    for (const [rel, content] of Object.entries(files)) {
      const dst = path.join(work, rel);
      await mkdir(path.dirname(dst), { recursive: true });
      await writeFile(dst, content);
    }
    await runGit(["add", "-A"], { cwd: work });
    await runGit(["commit", "-m", "seed"], { cwd: work, env: GIT_ENV });
    const push = await runGit(["push", "origin", "HEAD:main"], { cwd: work, env: GIT_ENV });
    if (push.code !== 0) throw new Error("push failed: " + push.stderr);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** Create a space + its bare repo at the canonical DESK_DATA_DIR path, commit
 * `files`, and reindex so the projection (docs + parsedFrontmatter) exists. */
async function seedSpaceWithFiles(
  slug: string,
  ownerId: number,
  files: Record<string, string>,
): Promise<number> {
  const res = await createSpace(slug, ownerId, "private", "test");
  if (!res.ok) throw new Error(res.error);
  const space = await getSpaceBySlug(slug);
  if (!space) throw new Error("space missing");
  const ownerSlug = await ownerSlugForSpace(space);
  const repoPath = bareRepoPath(ownerSlug, slug);
  await initBareRepo(repoPath);
  await commitFiles(repoPath, files);
  await reindexSpaceFull(slug, repoPath, "test", { spaceId: space.id });
  // Owner-namespace S5: the catalog source fns are id-based — return the id.
  return space.id;
}

beforeEach(async () => {
  await resetDb();
  prevDataDir = process.env.DESK_DATA_DIR;
  dataDir = await mkdtemp(path.join(tmpdir(), "desk-cat-data-"));
  process.env.DESK_DATA_DIR = dataDir;
});

afterEach(async () => {
  if (prevDataDir === undefined) delete process.env.DESK_DATA_DIR;
  else process.env.DESK_DATA_DIR = prevDataDir;
  await rm(dataDir, { recursive: true, force: true });
});

const FINDING = (status: string, severity: string, extra = "") =>
  `---\nstatus: ${status}\nseverity: ${severity}\n${extra}---\n\n# A finding\n\nbody text.\n`;

const COLLECTION_YML = `
fields:
  status:
    type: enum
    values: [open, shipped, superseded]
    required: true
  severity:
    type: enum
    values: [low, medium, high]
views:
  - type: board
    group_by: status
  - type: table
    columns: [status, severity]
  - { type: list }
default_view: board
`;

describe("catalog source — auto mode", () => {
  it("lists visible spaces, directories, and projects frontmatter", async () => {
    const owner = await seedUser({ email: "o@x.com", displayName: "Owner", role: "admin" });
    const wsId = await seedSpaceWithFiles("workspace", owner, {
      "findings/f-001.md": FINDING("open", "high", "owner: lucas\n"),
      "findings/f-002.md": FINDING("shipped", "low"),
      "README.md": "# root doc, no frontmatter\n",
    });

    const spaces = await catalogSpaces(ADMIN);
    expect(spaces.map((s) => s.slug)).toContain("workspace");

    const dirs = await directoriesInSpace(wsId, ADMIN);
    expect(dirs).not.toBeNull();
    expect(dirs!.map((d) => d.path)).toEqual(expect.arrayContaining(["", "findings"]));
    const findingsDir = dirs!.find((d) => d.path === "findings")!;
    expect(findingsDir.count).toBe(2);

    const docs = (await catalogDocs(wsId, "findings", ADMIN))!;
    expect(docs).toHaveLength(2);
    const p = projectCatalog(docs, null);
    expect(p.mode).toBe("auto");
    expect(p.fields).toEqual(expect.arrayContaining(["status", "severity", "owner"]));
    expect(p.driftCount).toBe(0);
  });

  it("a directory with no docs → empty projection; a doc with no frontmatter is handled", async () => {
    const owner = await seedUser({ email: "o2@x.com", displayName: "Owner2", role: "admin" });
    const ws2Id = await seedSpaceWithFiles("ws2", owner, {
      "notes/plain.md": "# just a heading, no frontmatter\n",
    });
    // The whole space root projects the one plain doc.
    const rootDocs = (await catalogDocs(ws2Id, "", ADMIN))!;
    const p = projectCatalog(rootDocs, null);
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0].values).toEqual({});
    expect(p.fields).toEqual([]);

    // A non-existent prefix yields nothing.
    const none = (await catalogDocs(ws2Id, "does-not-exist", ADMIN))!;
    expect(none).toEqual([]);
  });
});

describe("catalog source — schema mode (.desk.collection.yml from git)", () => {
  it("reads the config, renders declared views, validates, and flags drift", async () => {
    const owner = await seedUser({ email: "o3@x.com", displayName: "Owner3", role: "admin" });
    const ws3Id = await seedSpaceWithFiles("ws3", owner, {
      "findings/.desk.collection.yml": COLLECTION_YML,
      "findings/f-001.md": FINDING("open", "high"),
      "findings/f-002.md": FINDING("shipped", "low"),
      // DRIFT: severity 'critical' is not in the enum.
      "findings/f-003.md": FINDING("open", "critical"),
      // DRIFT: missing required 'status'.
      "findings/f-004.md": `---\nseverity: low\n---\n\n# no status\n`,
    });

    const cfg = await readCollectionConfig(ws3Id, "findings");
    expect(cfg).not.toBeNull();
    expect(cfg!.config.fields.map((f) => f.key)).toEqual(["status", "severity"]);
    expect(cfg!.config.views.map((v) => v.type)).toEqual(["board", "table", "list"]);
    expect(cfg!.config.defaultView).toBe("board");
    expect(cfg!.rawPath).toBe("findings/.desk.collection.yml");

    const docs = (await catalogDocs(ws3Id, "findings", ADMIN))!;
    const p = projectCatalog(docs, cfg!.config);
    expect(p.mode).toBe("schema");
    // All 4 docs are projected — drift docs are NOT hidden.
    expect(p.rows).toHaveLength(4);
    // Two drift issues: one enum-violation + one missing-required.
    expect(p.driftCount).toBe(2);
    const kinds = p.rows.flatMap((r) => r.drift.map((d) => d.kind)).sort();
    expect(kinds).toEqual(["enum-violation", "missing-required"]);
  });

  it("no .desk.collection.yml → null (auto mode)", async () => {
    const owner = await seedUser({ email: "o4@x.com", displayName: "Owner4", role: "admin" });
    const ws4Id = await seedSpaceWithFiles("ws4", owner, {
      "findings/f-001.md": FINDING("open", "high"),
    });
    const cfg = await readCollectionConfig(ws4Id, "findings");
    expect(cfg).toBeNull();
  });
});

describe("catalog source — scope filtering", () => {
  it("a member who is not in a private space sees neither the space nor its docs", async () => {
    const owner = await seedUser({ email: "o5@x.com", displayName: "Owner5", role: "admin" });
    const outsiderId = await seedUser({ email: "out@x.com", displayName: "Outsider" });
    const privId = await seedSpaceWithFiles("private-ws", owner, {
      "findings/f-001.md": FINDING("open", "high"),
    });
    const outsider: ViewerScope = { viewer: "member", userId: outsiderId };

    const spaces = await catalogSpaces(outsider);
    expect(spaces.map((s) => s.slug)).not.toContain("private-ws");
    // Direct fetch is also denied (null), no existence leak.
    expect(await directoriesInSpace(privId, outsider)).toBeNull();
    expect(await catalogDocs(privId, "findings", outsider)).toBeNull();
  });
});
