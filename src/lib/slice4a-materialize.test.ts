/**
 * Convergence fix-pass, Slice 4a — materialization backfill for legacy DB-only
 * docs.
 *
 * Before Slice 2 a doc could be created by a DB-direct `publishDoc` that wrote
 * Postgres rows WITHOUT committing a file to git. Such a doc renders fine (from
 * the projection) but has NO blob at `main` in its space repo — so it is absent
 * from a fresh `git clone` and would be silently omitted by the Slice-4 GitHub
 * mirror. `materializeDbOnlyDocs()` is the one-time boot backfill that commits
 * every such doc's CURRENT content into its space repo.
 *
 * Proves:
 *   - a DB-only doc's content lands at `main:<sourcePath>` in a FRESH clone AND
 *     the doc still renders/projects (slug + content preserved);
 *   - idempotency: a second run makes ZERO new commits (main tip unchanged);
 *   - tombstoned/unpublished docs are SKIPPED (never committed);
 *   - a doc that already has a matching blob at main is left UNTOUCHED (no commit);
 *   - the `workspace` default space is treated uniformly;
 *   - a `(space, sourcePath)` collision logs and does not throw.
 *
 * Skipped when the host has no usable `git` (mirrors the Slice-2/3 e2e suites).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  resetDb,
  seedUser,
  seedDefaultSpace,
  publishDocOk,
} from "@/test/db";
import {
  HAVE_GIT,
  useTempDataDir,
  clearSpaceRepos,
  readFileFromClone,
} from "@/test/git";
import {
  createSpace,
  ownerSlugForUser,
  getSpaceBySlug,
  ownerSlugForSpace,
} from "@/lib/spaces";
import { bareRepoPath, refTip, DEFAULT_BRANCH } from "@/lib/git/repo";
import {
  getDocBySlug,
  listVersions,
  unpublishDoc,
  deleteDoc,
} from "@/lib/docs";
import { materializeDbOnlyDocs } from "@/lib/materialize";
import type { Principal } from "@/lib/auth";
import { TOOLS, type ToolDef } from "@/lib/mcp/tools";

const admin: Principal = { kind: "admin", name: "Admin" };
const SPACE = "proof";

function tool(name: string): ToolDef {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}
async function runTool(name: string, principal: Principal, args: Record<string, unknown> = {}) {
  return tool(name).handler(principal, args as never);
}

describe.skipIf(!HAVE_GIT)("Slice 4a — materialize DB-only docs into git", () => {
  let restore: () => Promise<void>;
  let ownerUserId: number;
  let ownerSlug: string;
  let spaceId: number;

  beforeAll(async () => {
    ({ restore } = await useTempDataDir());
  });
  afterAll(async () => {
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
  const mainTip = () => refTip(repoPath(), DEFAULT_BRANCH);

  /** Resolve the on-disk repo path for any space slug (its owner's segment). */
  async function repoPathForSpaceSlug(spaceSlug: string): Promise<string> {
    const space = (await getSpaceBySlug(spaceSlug))!;
    const owner = await ownerSlugForSpace(space);
    return bareRepoPath(owner, spaceSlug);
  }

  /** Seed a legacy DB-only doc (a `docs` row + version, NO git blob). */
  async function seedDbOnlyDoc(
    slug: string,
    sourcePath: string,
    content: string,
    targetSpaceId = spaceId,
  ): Promise<string> {
    const out = await publishDocOk({
      slug,
      title: slug,
      sourcePath,
      format: "md",
      content,
      by: "seed",
      spaceId: targetSpaceId,
    });
    return out.slug;
  }

  it("commits a DB-only doc into git; clone shows the content and the doc still projects", async () => {
    const body = "# Legacy One\n\noriginal body\n";
    const slug = await seedDbOnlyDoc("legacy-one", "reports/legacy.md", body);

    // Precondition: no blob (the repo doesn't even exist yet).
    expect(await readFileFromClone(repoPath(), "reports/legacy.md")).toBeNull();

    const r = await materializeDbOnlyDocs();
    expect(r.docsMaterialized).toBe(1);
    expect(r.spacesCommitted).toBe(1);

    // Truth = git: a fresh clone retrieves the committed content, byte-exact.
    expect(await readFileFromClone(repoPath(), "reports/legacy.md")).toBe(body);

    // The doc still projects (slug + content preserved — reindex dedups the version).
    const doc = await getDocBySlug(slug, { includeUnpublished: true });
    expect(doc).not.toBeNull();
    expect(doc!.doc.spaceId).toBe(spaceId);
    expect(doc!.version!.content).toBe(body);
  });

  it("is idempotent — a second run makes zero new commits", async () => {
    await seedDbOnlyDoc("idem", "a/idem.md", "# Idem\n\nbody\n");

    const r1 = await materializeDbOnlyDocs();
    expect(r1.docsMaterialized).toBe(1);
    const tip1 = await mainTip();
    expect(tip1).not.toBeNull();

    const r2 = await materializeDbOnlyDocs();
    expect(r2.docsMaterialized).toBe(0);
    expect(r2.spacesCommitted).toBe(0);
    // main did NOT move — zero new commits on a fully-materialized instance.
    expect(await mainTip()).toBe(tip1);
  });

  it("skips unpublished and tombstoned docs (never commits them)", async () => {
    await seedDbOnlyDoc("live-a", "a.md", "# A\n\nlive\n");
    await seedDbOnlyDoc("unpub-b", "b.md", "# B\n\nunpub\n");
    await unpublishDoc("unpub-b");
    await seedDbOnlyDoc("del-c", "c.md", "# C\n\ndel\n");
    await deleteDoc("del-c", "admin");

    const r = await materializeDbOnlyDocs();
    // Only the LIVE doc materialized.
    expect(r.docsMaterialized).toBe(1);

    expect(await readFileFromClone(repoPath(), "a.md")).toBe("# A\n\nlive\n");
    // Unpublished + tombstoned are absent from git — they were skipped.
    expect(await readFileFromClone(repoPath(), "b.md")).toBeNull();
    expect(await readFileFromClone(repoPath(), "c.md")).toBeNull();
  });

  it("leaves a doc that already has a matching blob at main UNTOUCHED (no needless commit)", async () => {
    // publish_doc (MCP) commits to git AND projects — the doc's sourcePath now
    // has a real blob at main, so it is NOT a DB-only doc.
    const res = await runTool("publish_doc", admin, {
      space: SPACE,
      path: "reports/live.md",
      content: "# Live\n\nbody\n",
    });
    expect(res.isError).toBeFalsy();

    const before = await mainTip();
    expect(before).not.toBeNull();

    const r = await materializeDbOnlyDocs();
    expect(r.docsMaterialized).toBe(0);
    expect(r.spacesCommitted).toBe(0);
    // No commit was made — git remains the source of truth for this doc.
    expect(await mainTip()).toBe(before);
  });

  it("treats the `workspace` default space uniformly", async () => {
    const wsId = await seedDefaultSpace();
    const body = "# WS\n\nworkspace body\n";
    const slug = await seedDbOnlyDoc("ws-doc", "ws/notes.md", body, wsId);

    const r = await materializeDbOnlyDocs();
    expect(r.docsMaterialized).toBe(1);

    const wsRepo = await repoPathForSpaceSlug("workspace");
    expect(await readFileFromClone(wsRepo, "ws/notes.md")).toBe(body);

    const doc = await getDocBySlug(slug, { includeUnpublished: true });
    expect(doc!.version!.content).toBe(body);
  });

  it("handles a (space, sourcePath) collision — commits one, logs, does not throw", async () => {
    await seedDbOnlyDoc("col-1", "dup.md", "# Dup\n\nfirst\n");
    await seedDbOnlyDoc("col-2", "dup.md", "# Dup\n\nsecond\n");

    const r = await materializeDbOnlyDocs();
    // One path committed; the collision is counted, not thrown.
    expect(r.docsMaterialized).toBe(1);
    expect(r.collisions).toBe(1);

    const got = await readFileFromClone(repoPath(), "dup.md");
    expect(got === "# Dup\n\nfirst\n" || got === "# Dup\n\nsecond\n").toBe(true);
    // Both DB rows still project (the projection key allows two; git holds one).
    expect((await listVersions("col-1")).length).toBeGreaterThanOrEqual(1);
    expect((await listVersions("col-2")).length).toBeGreaterThanOrEqual(1);
  });
});
