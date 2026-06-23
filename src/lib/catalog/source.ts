/**
 * Server-side data source for the catalog-as-projection surface (D6).
 *
 * A catalog = the docs in a chosen SPACE under a chosen DIRECTORY (path prefix),
 * rendered from each doc's `parsedFrontmatter` (already populated by the
 * indexer). This module is the DB + git read layer behind that:
 *
 *   - `catalogSpaces`     — spaces the principal may see (the picker's options).
 *   - `directoriesInSpace`— the distinct doc folder paths in a space (the dir
 *                           picker), each with a doc count.
 *   - `catalogDocs`       — the docs under a (space, directory) prefix, with
 *                           their parsed frontmatter — SCOPE-FILTERED so a member
 *                           never sees a private space's docs.
 *   - `readCollectionConfig` — read `.desk.collection.yml` from the directory in
 *                           the space's BARE GIT REPO at the current tip (via the
 *                           existing repo read helpers), for schema mode.
 *
 * Read/render-only. NOTHING here writes a file or a `catalog_*` row.
 */

import { and, eq, isNull, inArray } from "drizzle-orm";
import { db } from "@/db";
import { docs, spaces, spaceMembers } from "@/db/schema";
import type { ViewerScope } from "@/lib/docs";
import { ownerSlugForSpace } from "@/lib/spaces";
import { bareRepoPath, refTip, listTree, readBlob } from "@/lib/git/repo";
import { parseCollectionConfig, COLLECTION_CONFIG_FILENAME, type CollectionConfig } from "./collection-config";
import type { CatalogDoc } from "./projection";

export type CatalogSpaceOption = {
  slug: string;
  visibility: "private" | "unlisted" | "public";
};

/** Space ids a viewer may see, mirroring the docs read scope (admin → all;
 * member → member-of ∪ public/unlisted). Returns null for "all" (admin). */
async function visibleSpaceIds(scope: ViewerScope): Promise<number[] | null> {
  if (scope.viewer === "admin") return null;
  const openRows = await db
    .select({ id: spaces.id })
    .from(spaces)
    .where(inArray(spaces.visibility, ["public", "unlisted"]));
  const memberRows =
    scope.userId != null
      ? await db
          .select({ spaceId: spaceMembers.spaceId })
          .from(spaceMembers)
          .where(eq(spaceMembers.userId, scope.userId))
      : [];
  const ids = new Set<number>();
  for (const r of openRows) ids.add(r.id);
  for (const r of memberRows) ids.add(r.spaceId);
  return [...ids];
}

/** The spaces a viewer may pick a catalog from (scope-filtered), slug-sorted. */
export async function catalogSpaces(scope: ViewerScope): Promise<CatalogSpaceOption[]> {
  const ids = await visibleSpaceIds(scope);
  const rows =
    ids === null
      ? await db.select().from(spaces)
      : ids.length === 0
        ? []
        : await db.select().from(spaces).where(inArray(spaces.id, ids));
  return rows
    .map((s) => ({ slug: s.slug, visibility: s.visibility as CatalogSpaceOption["visibility"] }))
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}

export type DirectoryOption = {
  /** Folder path prefix, e.g. "findings" or "ops/runbooks". '' = space root. */
  path: string;
  /** Live, published doc count directly + recursively under this prefix. */
  count: number;
};

/**
 * The distinct directories in a space (derived from the docs' folder paths), for
 * the directory picker. Includes the root ('') and every implied prefix. Each
 * carries the recursive doc count under it. Scope-filtered: returns [] when the
 * viewer can't see the space.
 */
export async function directoriesInSpace(
  spaceSlug: string,
  scope: ViewerScope,
): Promise<DirectoryOption[] | null> {
  const space = await db.query.spaces.findFirst({ where: eq(spaces.slug, spaceSlug) });
  if (!space) return null;
  const ids = await visibleSpaceIds(scope);
  if (ids !== null && !ids.includes(space.id)) return null;

  const rows = await db
    .select({ path: docs.path })
    .from(docs)
    .where(
      and(
        eq(docs.spaceId, space.id),
        isNull(docs.deletedAt),
        isNull(docs.unpublishedAt),
      ),
    );

  // Derive every implied prefix (root + each ancestor) and count docs under it.
  const prefixes = new Set<string>([""]);
  for (const r of rows) {
    if (!r.path) continue;
    const parts = r.path.split("/");
    for (let i = 1; i <= parts.length; i++) prefixes.add(parts.slice(0, i).join("/"));
  }
  const countUnder = (prefix: string) =>
    rows.filter((r) => prefix === "" || r.path === prefix || r.path.startsWith(prefix + "/")).length;

  return [...prefixes]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((path) => ({ path, count: countUnder(path) }));
}

/**
 * The docs under a (space, directory-prefix) for the catalog projection, with
 * their parsed frontmatter. Scope-filtered (a member never sees a private
 * space's docs). Only LIVE + PUBLISHED docs project into a catalog. `prefix` ''
 * means the whole space. Returns null when the space is invisible/unknown.
 */
export async function catalogDocs(
  spaceSlug: string,
  prefix: string,
  scope: ViewerScope,
): Promise<CatalogDoc[] | null> {
  const space = await db.query.spaces.findFirst({ where: eq(spaces.slug, spaceSlug) });
  if (!space) return null;
  const ids = await visibleSpaceIds(scope);
  if (ids !== null && !ids.includes(space.id)) return null;

  const rows = await db
    .select({
      slug: docs.slug,
      title: docs.title,
      path: docs.path,
      parsedFrontmatter: docs.parsedFrontmatter,
    })
    .from(docs)
    .where(
      and(
        eq(docs.spaceId, space.id),
        isNull(docs.deletedAt),
        isNull(docs.unpublishedAt),
      ),
    )
    .orderBy(docs.path, docs.slug);

  return rows
    .filter((r) => prefix === "" || r.path === prefix || r.path.startsWith(prefix + "/"))
    .map((r) => ({
      slug: r.slug,
      title: r.title,
      path: r.path,
      frontmatter: (r.parsedFrontmatter ?? {}) as Record<string, unknown>,
    }));
}

/**
 * Read `.desk.collection.yml` from a directory in the space's BARE GIT REPO at
 * the current tip, returning the parsed CollectionConfig (schema mode) or null
 * (no config → auto mode). Reads from git (`listTree`/`readBlob`), never from a
 * working tree — truth is the repo. `prefix` is the directory the catalog
 * projects ('' = repo root). A read error or missing file → null (auto mode);
 * never throws.
 */
export async function readCollectionConfig(
  spaceSlug: string,
  prefix: string,
): Promise<{ config: CollectionConfig; rawPath: string } | null> {
  try {
    const space = await db.query.spaces.findFirst({ where: eq(spaces.slug, spaceSlug) });
    if (!space) return null;
    const ownerSlug = await ownerSlugForSpace(space);
    const repoPath = bareRepoPath(ownerSlug, spaceSlug);
    const tip = await refTip(repoPath);
    if (!tip) return null;

    // The config file lives at <prefix>/.desk.collection.yml (or at the repo
    // root when prefix is ''). The doc `path` is a normalized/slugified mirror
    // of the repo directory; for a faithful read we match the repo tree's actual
    // directory whose normalized form equals `prefix`.
    const want = configRepoPath(prefix);
    const tree = await listTree(repoPath, tip);
    const entry =
      tree.find((e) => e.path === want) ??
      tree.find((e) => normalizeRepoDir(dirOf(e.path)) === prefix && baseName(e.path) === COLLECTION_CONFIG_FILENAME);
    if (!entry) return null;

    const blob = await readBlob(repoPath, tip, entry.path);
    if (!blob) return null;
    const config = parseCollectionConfig(blob.toString("utf8"));
    return { config, rawPath: entry.path };
  } catch {
    return null; // projection must never crash on a bad/absent config
  }
}

/** The expected repo path of the config file for a directory prefix. */
function configRepoPath(prefix: string): string {
  return prefix ? `${prefix}/${COLLECTION_CONFIG_FILENAME}` : COLLECTION_CONFIG_FILENAME;
}

function dirOf(p: string): string {
  const slash = p.lastIndexOf("/");
  return slash < 0 ? "" : p.slice(0, slash);
}

function baseName(p: string): string {
  const slash = p.lastIndexOf("/");
  return slash < 0 ? p : p.slice(slash + 1);
}

/** Normalize a repo directory to the doc-`path` alphabet (mirrors the indexer's
 * folderPathForRepoPath so a config dir matches the projected prefix). */
function normalizeRepoDir(dir: string): string {
  if (!dir) return "";
  return dir
    .split("/")
    .map((s) =>
      s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-+|-+$/g, ""),
    )
    .filter((s) => s.length > 0)
    .join("/");
}
