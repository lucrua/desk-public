/**
 * Projection indexer (document-host Phase 1, §14).
 *
 * Truth = files in a space's bare git repo. This module REBUILDS the Postgres
 * projection (`docs` + thin `doc_versions` rows) from the repo at a commit:
 *
 *   - full reindex  (reindexSpaceFull)    — index every file at the current tip;
 *                                            the import path + a recovery command.
 *   - incremental   (reindexSpaceByDisk)  — index only the paths that changed
 *                                            between two commits (the post-receive
 *                                            / web-commit hot path).
 *
 * Each renderable file (`.md` / `.html`) projects to one `docs` row keyed by a
 * deterministic slug derived from its repo path. We parse frontmatter into
 * `parsedFrontmatter`, cache the rendered body in `renderedCache`, advance
 * `currentCommit`, and keep a thin `doc_versions` row per (doc, contentHash) so
 * the existing version UI keeps working — sourced from git, not from a DB write
 * path. Non-renderable files (registries, configs, assets) live in git but are
 * NOT projected as docs in Phase 1.
 *
 * IDEMPOTENT: indexing the same content twice changes nothing (contentHash
 * dedups the version row; the doc row is upserted). A deleted path tombstones
 * its doc (unpublish) without destroying git history.
 */
import { createHash } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { docs, docVersions, spaces } from "@/db/schema";
import { emitEvent } from "@/lib/events";
import { titleFromContent } from "@/lib/slug";
import { normalizePath } from "@/lib/path";
import { parseFrontmatter } from "./frontmatter";
import { listTree, readBlob, changedPaths, refTip, bareRepoPath } from "./repo";

/** File extensions that project to a doc, mapped to the doc format. */
const DOC_FORMATS: Record<string, "md" | "html"> = {
  ".md": "md",
  ".markdown": "md",
  ".html": "html",
  ".htm": "html",
};

function sha256(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

function extOf(p: string): string {
  const slash = p.lastIndexOf("/");
  const name = slash >= 0 ? p.slice(slash + 1) : p;
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

/** True iff a repo path projects to a doc (renderable extension). */
export function isDocPath(p: string): boolean {
  return extOf(p) in DOC_FORMATS;
}

/**
 * Deterministic slug for a repo path. The full path (minus extension), with
 * every non-slug run collapsed to '-', lowercased. So `os/canon/CONTEXT.md` →
 * `os-canon-context`. Stable + collision-resistant (distinct paths → distinct
 * slugs), and idempotent (same path → same slug every reindex).
 */
export function slugForPath(repoPath: string): string {
  const noExt = repoPath.replace(/\.[^./]+$/, "");
  const slug = noExt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "doc";
}

/** Derive the doc's folder `path` from its repo path (the directory portion,
 * normalized to the slug-segment alphabet). Returns '' (root) for a top-level
 * file or when the directory can't be normalized. */
function folderPathForRepoPath(repoPath: string): string {
  const slash = repoPath.lastIndexOf("/");
  if (slash < 0) return "";
  const dir = repoPath.slice(0, slash);
  // Slugify each segment so an arbitrary repo dir maps into the path alphabet.
  const segs = dir
    .split("/")
    .map((s) =>
      s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-+|-+$/g, ""),
    )
    .filter((s) => s.length > 0);
  const candidate = segs.join("/");
  return normalizePath(candidate) ?? "";
}

export type ReindexResult = {
  indexed: number; // docs upserted (created or updated)
  tombstoned: number; // docs unpublished due to a deleted path
  skipped: number; // non-doc paths skipped
  commit: string | null;
};

/**
 * Index ONE renderable file's content into a `docs` projection row at `space`.
 * Idempotent: same content → no new version, doc row refreshed. Returns the
 * doc id, or null when the content is empty.
 */
async function indexFile(
  spaceId: number,
  repoPath: string,
  content: Buffer,
  commit: string,
  actorName: string,
): Promise<number | null> {
  const text = content.toString("utf8");
  const format = DOC_FORMATS[extOf(repoPath)] ?? "md";
  const slug = slugForPath(repoPath);
  const folder = folderPathForRepoPath(repoPath);
  const { frontmatter, body } = parseFrontmatter(text);
  const title =
    (typeof frontmatter.title === "string" && frontmatter.title.trim()) ||
    titleFromContent(format === "md" ? body : text, slug);
  const contentHash = sha256(text);
  // Render cache = the body (frontmatter stripped) for md; the raw html for html.
  const renderedCache = format === "md" ? body : text;

  return db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(docs)
      .where(and(eq(docs.slug, slug), isNull(docs.deletedAt)))
      .limit(1);

    let docId: number;
    let currentVersionId: number | null;

    if (existing.length === 0) {
      const [inserted] = await tx
        .insert(docs)
        .values({
          slug,
          title,
          sourcePath: repoPath,
          audience: "private", // imported docs default to private (owner-only)
          format,
          path: folder,
          spaceId,
          currentCommit: commit,
          renderedCache,
          parsedFrontmatter: frontmatter,
        })
        .returning({ id: docs.id });
      docId = inserted.id;
      currentVersionId = null;
    } else {
      docId = existing[0].id;
      currentVersionId = existing[0].currentVersionId;
      // Refresh the projection fields (title/format/path/commit/cache/fm).
      await tx
        .update(docs)
        .set({
          title,
          format,
          sourcePath: repoPath,
          path: folder,
          currentCommit: commit,
          renderedCache,
          parsedFrontmatter: frontmatter,
          unpublishedAt: null, // re-appearing path republishes
        })
        .where(eq(docs.id, docId));
    }

    // Version row: only insert when the content actually changed (dedup by hash).
    let versionId = currentVersionId;
    let isNewVersion = false;
    if (currentVersionId !== null) {
      const [cur] = await tx
        .select({ hash: docVersions.contentHash })
        .from(docVersions)
        .where(eq(docVersions.id, currentVersionId))
        .limit(1);
      if (!cur || cur.hash !== contentHash) {
        const [v] = await tx
          .insert(docVersions)
          .values({ docId, content: text, contentHash, publishedBy: actorName })
          .returning({ id: docVersions.id });
        versionId = v.id;
        isNewVersion = true;
      }
    } else {
      const [v] = await tx
        .insert(docVersions)
        .values({ docId, content: text, contentHash, publishedBy: actorName })
        .returning({ id: docVersions.id });
      versionId = v.id;
      isNewVersion = true;
    }

    await tx.update(docs).set({ currentVersionId: versionId }).where(eq(docs.id, docId));

    // Maintain the FTS vector for the new current content (mirrors publishDoc).
    // Bound params so to_tsvector parses them as data, never SQL.
    await tx.execute(sql`
      update ${docs}
      set search_tsv =
        setweight(to_tsvector('english', ${title}), 'A') ||
        setweight(to_tsvector('english', ${text}), 'B')
      where ${docs.id} = ${docId}
    `);

    if (isNewVersion) {
      await emitEvent(tx, {
        kind: "doc.published",
        docId,
        payload: { slug, versionId, contentHash, audience: "private", format, source: "git" },
        actorName,
      });
    }
    return docId;
  });
}

/** Tombstone (unpublish) the doc projected from a now-deleted repo path. The git
 * history is untouched; only the projection reflects the removal. */
async function tombstonePath(spaceId: number, repoPath: string, actorName: string): Promise<boolean> {
  const slug = slugForPath(repoPath);
  return db.transaction(async (tx) => {
    const [doc] = await tx
      .select()
      .from(docs)
      .where(and(eq(docs.slug, slug), eq(docs.spaceId, spaceId), isNull(docs.deletedAt)))
      .limit(1);
    if (!doc || doc.unpublishedAt !== null) return false;
    await tx.update(docs).set({ unpublishedAt: new Date() }).where(eq(docs.id, doc.id));
    await emitEvent(tx, {
      kind: "doc.unpublished",
      docId: doc.id,
      payload: { slug, audience: doc.audience, source: "git" },
      actorName,
    });
    return true;
  });
}

/**
 * Full reindex of a space from its repo's current tip. Indexes every renderable
 * file. Used by import + as the recovery command. Idempotent.
 */
export async function reindexSpaceFull(
  spaceSlug: string,
  repoPath: string,
  actorName = "system",
): Promise<ReindexResult> {
  const spaceRow = await db.query.spaces.findFirst({ where: eq(spaces.slug, spaceSlug) });
  if (!spaceRow) throw new Error(`unknown space: ${spaceSlug}`);
  const commit = await refTip(repoPath);
  if (!commit) return { indexed: 0, tombstoned: 0, skipped: 0, commit: null };

  const tree = await listTree(repoPath, commit);
  let indexed = 0;
  let skipped = 0;
  for (const entry of tree) {
    if (!isDocPath(entry.path)) {
      skipped++;
      continue;
    }
    const blob = await readBlob(repoPath, commit, entry.path);
    if (blob === null) continue;
    const id = await indexFile(spaceRow.id, entry.path, blob, commit, actorName);
    if (id !== null) indexed++;
  }
  return { indexed, tombstoned: 0, skipped, commit };
}

/**
 * Incremental reindex over the paths that changed between `fromSha` and `toSha`.
 * The post-receive / web-commit hot path. Adds/updates index modified doc paths,
 * tombstones deleted doc paths, skips non-doc paths. Idempotent.
 */
export async function reindexSpaceByDisk(
  spaceSlug: string,
  repoPath: string,
  opts: { fromSha: string | null; toSha: string; actorName?: string },
): Promise<ReindexResult> {
  const spaceRow = await db.query.spaces.findFirst({ where: eq(spaces.slug, spaceSlug) });
  if (!spaceRow) throw new Error(`unknown space: ${spaceSlug}`);
  const actorName = opts.actorName ?? "system";

  const changes = await changedPaths(repoPath, opts.fromSha, opts.toSha);
  let indexed = 0;
  let tombstoned = 0;
  let skipped = 0;
  for (const ch of changes) {
    if (!isDocPath(ch.path)) {
      skipped++;
      continue;
    }
    if (ch.status === "D") {
      if (await tombstonePath(spaceRow.id, ch.path, actorName)) tombstoned++;
      continue;
    }
    const blob = await readBlob(repoPath, opts.toSha, ch.path);
    if (blob === null) continue;
    const id = await indexFile(spaceRow.id, ch.path, blob, opts.toSha, actorName);
    if (id !== null) indexed++;
  }
  // Advance currentCommit on all of the space's docs to the new tip (cheap, and
  // keeps the projection's "built from" marker consistent even for untouched docs).
  await db.update(docs).set({ currentCommit: opts.toSha }).where(eq(docs.spaceId, spaceRow.id));
  return { indexed, tombstoned, skipped, commit: opts.toSha };
}

/** Convenience: full reindex by space slug, resolving the on-disk repo path from
 * the owner+space. Used by the recovery CLI/function. */
export async function reindexSpaceBySlug(
  ownerSlug: string,
  spaceSlug: string,
  actorName = "system",
): Promise<ReindexResult> {
  return reindexSpaceFull(spaceSlug, bareRepoPath(ownerSlug, spaceSlug), actorName);
}
