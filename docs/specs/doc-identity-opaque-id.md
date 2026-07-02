# Spec — Doc identity: stable opaque id + collision-free projection + link previews

> **Status: APPROVED for implementation (2026-07-02).** Owner: Lucas.
> Supersedes the path-derived `slug` identity for git-projected docs.

## Problem

`docs.slug` conflates two incompatible roles:

1. **Public identity** — the key in `/docs/[slug]`, share links, and every MCP tool.
2. **Projection key** — how the git indexer maps a repo file to its `docs` row.

For git-projected docs, `slug` is *derived from the repo path minus extension*
(`slugForPath`, `src/lib/git/indexer.ts`) and is *globally unique* (partial-unique
index `docs_slug_idx` on `slug` alone, `src/db/schema.ts:268`). Because a
space-local path drives a hub-global key, distinct files collide:

- **Extension collision (the reported bug).** `docs/x.md` and `docs/x.html` both
  slug to `docs-x`. They land on one row; the lexicographically-last file
  (`.md` > `.html`) wins. The HTML silently disappears.
- **Cross-space collision (latent boundary bug).** Two spaces each with
  `README.md` both slug to `readme`. The indexer upsert lookup is *global*
  (`WHERE slug = ?`, `indexer.ts:132`) while `tombstonePath` is *space-scoped*
  (`indexer.ts:233`). A second space pushing `README.md` would `UPDATE` the first
  space's row — a cross-space write. Today only the global unique index prevents
  the two from coexisting (the second insert would throw).

Every disambiguation added so far (full path, and the proposed extension fix) is a
patch on a namespace that is structurally wrong: global + flat, but built from a
space-local path.

## Decision

Split the two roles.

| Role | Today | New |
| --- | --- | --- |
| **Public identity** (`docs.slug`) | derived from path, globally unique | **permanent random opaque id** (`randomSlug()`), minted once per file, never derived, never changed on rename |
| **Projection key** | *also* `slug` (global) | **`(spaceId, sourcePath)`** — unique per space, includes the extension |

Web-authored docs already use `randomSlug()` (ids like `nss907zy7`); this makes
*all* docs consistent. Identity survives a file rename/move via **git rename
detection** (`git diff -M`) in the projector — which works for `git push` **and**
web-author commits (both are git commits), so it holds even if `git push` is later
dropped.

**Not backcompatible** (authorized): existing path-derived slugs are kept as-is
(they are already valid, unique opaque strings) — no identity data-migration; we
only stop *deriving* new ones and add the new projection index.

## Design

### 1. Schema — `src/db/schema.ts` + `drizzle/0018_*.sql`

- Add partial unique index:
  `docs_space_source_path_idx` on `(spaceId, sourcePath) WHERE deleted_at IS NULL`.
- Keep `docs_slug_idx` (random ids are globally unique for free).
- Migration is index-only. Pre-existing rows have one `sourcePath` per space
  (slug was 1:1 with path), so the index builds cleanly. The reported CASA case
  has only the `.md` row today; the `.html` gets its own row on next reindex.

### 2. Repo — `src/lib/git/repo.ts`

- `changedPaths`: switch `--no-renames` → `-M` (find-renames). Extend the result
  type and parse rename/copy records (a rename record under `-z` is
  `R<score>\0<oldPath>\0<newPath>` — the status token consumes **two** paths):

  ```ts
  export type ChangedPath =
    | { status: "A" | "M" | "D"; path: string }
    | { status: "R"; oldPath: string; path: string };
  ```

  `C` (copy) records are treated as `A` at the new path (a copy is a new doc; the
  original is untouched). `fromSha == null` still reports every tree path as `A`.

### 3. Indexer — `src/lib/git/indexer.ts`

- Delete `slugForPath` as an identity source. Mint ids with `randomSlug()`.
  `folderPathForRepoPath` (folder `path`) and `titleFromContent` stay.
- `indexFile(spaceId, repoPath, …)`: look up `WHERE spaceId = ? AND source_path = ?
  AND deleted_at IS NULL`.
  - **hit** → refresh title/format/path/commit/renderedCache/frontmatter; **keep
    `slug` and `id`**.
  - **miss** → insert with `slug: randomSlug()`; on the (astronomically rare)
    `docs_slug_idx` unique violation, regenerate and retry (≤5 attempts).
- `tombstonePath(spaceId, repoPath)`: key by `(spaceId, sourcePath)` (was slug).
- `renamePath(spaceId, oldPath, newPath, actor)` (new): find the live row at
  `(spaceId, oldPath)`; set `sourcePath = newPath`, refresh folder `path` and the
  content/render from the blob at `newPath`; **keep `slug`/`id`**. If no row
  exists at `oldPath` (e.g. it was never a doc, or a full reindex gap), fall back
  to an `A`-style upsert at `newPath`.
- `reindexSpaceByDisk`: dispatch on status — `R` → `renamePath`; `A`/`M` →
  `indexFile`; `D` → `tombstonePath`. Skip non-doc paths (unchanged).
- `reindexSpaceFull` (full rebuild via `listTree`): unchanged control flow, now
  keyed by `sourcePath`. Renames are *not* reconstructable in a from-scratch walk
  (no before-tree) — acceptable, since full reindex is a recovery/rebuild op and
  the incremental path maintains id continuity in normal operation.

### 4. Link previews (Open Graph) — Q2

WhatsApp/Slack/iMessage render a link card from `og:title` / `og:description`
(and `og:image` if present). Today only the **share** page emits `og:title`
(`src/app/s/[token]/[slug]/page.tsx:32`); the **doc viewer** has no
`generateMetadata`.

- `src/app/(hub)/docs/[slug]/page.tsx`: add `generateMetadata` →
  `openGraph: { title, description, type: "article" }` +
  `twitter: { card: "summary", title, description }`. Respect access scoping
  (use the same viewer-scoped `getDocBySlug`; a doc the caller can't see yields
  neutral/default metadata — no title leak).
- `src/app/s/[token]/[slug]/page.tsx`: enrich the existing metadata with
  `description` + `twitter`.
- Shared helper `docPreviewDescription(doc)`: frontmatter `description`/`summary`
  if present, else a trimmed plain-text snippet of the body (≤200 chars, markdown/
  HTML stripped). Lives in `src/lib/docs.ts` (or a small `src/lib/preview.ts`).
- `og:image` (a rendered thumbnail card) is **deferred** — out of scope here.

## Tests (boundary-critical — the access boundary is sacred)

New/updated, all under `npx vitest run` (serial):

- **Cross-space isolation** (`indexer.test.ts`): two spaces, both `README.md` →
  two independent live rows, distinct ids; indexing space B never reads or writes
  space A's row. *This is the sacred cross-space projection-isolation coverage.*
- **Extension no longer collides**: `foo.md` + `foo.html` in one space → two docs,
  distinct ids, formats `md` and `html`. (The reported bug, fixed.)
- **Rename preserves id** (incremental): commit at `A`, reindex; `git mv A B`,
  incremental reindex → same id, `sourcePath = B`, no tombstone of `A`.
- **Web-author-style rename** (delete `A` + write identical bytes at `B` in one
  commit) → detected as rename by `-M`; id preserved.
- **Cross-folder move** preserves id and updates folder `path`.
- **Ids are opaque** — a projected doc's slug matches `randomSlug` shape
  (`^[a-z0-9]{9}$`), not the path.
- **`changedPaths` `-z -M` parser** (unit): A/M/D and an `R` record parse
  correctly; a copy maps to `A`.
- **OG metadata**: doc page + share page `generateMetadata` return the doc title
  in `openGraph.title` and a non-empty `description`; a non-visible doc leaks no
  title.
- **Update existing tests** that asserted path-derived slugs
  (`indexer.test.ts` `slugForPath`/`isDocPath`/`slugForPath("README.md")==="readme"`
  and any `commitFiles(... {"a.md"})` expecting slug `a`) — retarget to the new
  identity model.

## Out of scope / deferred

- `desk_id` frontmatter/`<meta>` anchor (a belt-and-suspenders identity pin that
  would survive even a rename+full-rewrite in one commit). `git diff -M` is
  sufficient for v1; the anchor is a clean future add.
- `og:image` thumbnail cards.
- `/{owner}/{space}/{path}` readable URLs — explicitly *not* pursued; opaque
  `/docs/<id>` stays.
- Any change to the git read/write **auth** boundary (`resolveSpaceRole`,
  push-policy) — untouched.

## Rollout / landing posture (per AGENTS.md)

Branch `feat/doc-identity-opaque-id`. TDD. Run the full suite + `pnpm typecheck`
+ `pnpm build`, then **STOP for review** before any deploy push. No `--force`,
no `--no-verify`.
