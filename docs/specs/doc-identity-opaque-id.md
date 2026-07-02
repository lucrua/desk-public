# Spec — Doc identity: stable opaque id + collision-free projection + link previews

> **Status: APPROVED for implementation (2026-07-02).** Owner: Lucas.
> Supersedes the path-derived `slug` identity for git-projected docs.
> Revised 2026-07-02 after adversarial self-review (findings folded in below).
> **Revision 2 (2026-07-02, during implementation):** the `(space_id, source_path)`
> index is **NON-unique** (a lookup index), not a unique constraint. Rationale:
> the collision fix lives in the indexer *keying* on `(spaceId, sourcePath)` +
> opaque slugs — a DB uniqueness constraint is not needed for correctness, and it
> would have imposed a new invariant on the legacy `publishDoc` path (where
> `source_path` is a non-unique "provenance stamp") that ~10 test files and
> potential real callers violate. So the `publishDoc` conflict-guard from §6 was
> dropped; the web-create app-level guard (§6) stays. A unique constraint remains
> a clean future hardening step IF the publish path is first made path-aware.

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

## Decision

Split the two roles.

| Role | Today | New |
| --- | --- | --- |
| **Public identity** (`docs.slug`) | derived from path, globally unique | **permanent random opaque id** (`randomSlug()`), minted once per file, never derived, never changed on rename |
| **Projection key** | *also* `slug` (global) | the indexer keys on **`(spaceId, sourcePath)`** (non-unique lookup index); includes the extension |

Web-authored docs already use `randomSlug()` (ids like `nss907zy7`); this makes
*all* docs consistent. Identity survives a file rename/move via **git rename
detection** (`git diff -M`) in the projector — which works for `git push` **and**
web-author commits (both are git commits), so it holds even if `git push` is later
dropped.

**Rename-detection scope (calibrated after review).** git's *exact* rename
detection pairs a delete+re-add of **identical bytes** as `R100` unconditionally
(SHA equality, size-independent, threshold-independent) — so pure moves and
web-author-style delete+write-identical are rock-solid. A rename **bundled with a
substantial content edit in one commit** falls below the similarity threshold and
surfaces as `D`+`A` → the id is *not* preserved (old row tombstoned, new path gets
a fresh id). This is the one accepted gap for v1; the deferred `desk_id` anchor
(below) is its real fix.

**Not backcompatible** (authorized): existing path-derived slugs are kept as-is
(they are already valid, unique opaque strings) — no identity data-migration; we
only stop *deriving* new ones and add the new projection index.

## Design / change set

### 1. Schema — `src/db/schema.ts` + `drizzle/0018_doc_source_path_uniq.sql`

- Add a NON-unique lookup index (hand-authored raw SQL; the drizzle-kit
  `generate` path is blocked by a pre-existing 0013/0014 meta-snapshot collision,
  so 0018 is hand-authored + a `_journal.json` entry — `migrate` needs no
  snapshot):
  ```sql
  CREATE INDEX "docs_space_source_path_idx" ON "docs" ("space_id","source_path");
  ```
  mirrored as `index("docs_space_source_path_idx").on(t.spaceId, t.sourcePath)`
  in `schema.ts`. Backs every `(spaceId, sourcePath)` query (indexer upsert,
  tombstone, rename, `listSpaceFiles`, the web create-guard).
- Keep `docs_slug_idx` (random opaque ids are globally unique for free).
- No pre-migration dup guard needed (the index is non-unique). The collision fix
  is the indexer *keying* on this pair, not a constraint.

### 2. Repo — `src/lib/git/repo.ts` (`changedPaths`)

- Switch `--no-renames` → `-M` (find-renames). Extend the result type:
  ```ts
  export type ChangedPath =
    | { status: "A" | "M" | "D"; path: string }
    | { status: "R"; oldPath: string; path: string };
  ```
- **Parse with a variable-stride cursor dispatching on `token[0]`** (the current
  fixed `i += 2` loop at `repo.ts:293` desyncs on rename records — an `R` record
  carries TWO paths):
  ```
  i = 0
  while i < tokens.length:
    c = tokens[i][0]
    if c === 'R' || c === 'C':   push {status:'R', oldPath: tokens[i+1], path: tokens[i+2]}; i += 3
    else:                        push {status: c==='A'?'A': c==='D'?'D':'M', path: tokens[i+1]}; i += 2
  ```
  Note: the single-path branch maps **any** non-R/C status (including `T`
  typechange) to `M` — so an unexpected status can't desync the stride. `C`
  (copy) never appears without `-C`, but the branch handles it defensively.
  Confirmed `-z` layout: `R100\0<old>\0<new>`, `M\0<path>`, etc.

### 3. Indexer — `src/lib/git/indexer.ts`

- Stop using `slugForPath` for identity. Mint ids with `randomSlug()`.
  `folderPathForRepoPath` (folder `path`) and `titleFromContent` stay.
  `slugForPath` is **removed from `indexer.ts`** once §5/§6 callers migrate off it
  (see §5 — it currently has 3 other prod callers, so it cannot simply vanish
  until they're converted).
- `indexFile(spaceId, repoPath, …)`: look up `WHERE spaceId = ? AND source_path = ?
  AND deleted_at IS NULL`.
  - **hit** → refresh title/format/path/commit/renderedCache/frontmatter; **keep
    `slug` and `id`**.
  - **miss** → insert with `slug: randomSlug()`; on a `docs_slug_idx` unique
    violation, regenerate and retry (≤5 attempts).
- `tombstonePath(spaceId, repoPath)`: key by `(spaceId, sourcePath)` (was slug);
  drops its `slugForPath` import.
- `renamePath(spaceId, oldPath, newPath, actor)` (new): find the live row at
  `(spaceId, oldPath)`; set `sourcePath = newPath`, refresh folder `path` and the
  content/render from the blob at `newPath`; **keep `slug`/`id`**. If no row
  exists at `oldPath`, fall back to an `A`-style upsert at `newPath`.
- `reindexSpaceByDisk`: **dispatch on status AND doc-ness of both paths** for
  renames (avoids orphaning a doc renamed to a non-doc extension):
  - `A`/`M`: `isDocPath(path)` ? `indexFile` : skip.
  - `D`: `isDocPath(path)` ? `tombstonePath` : skip.
  - `R oldPath→path`:
    - both doc paths → `renamePath`.
    - doc → non-doc (`a.md`→`a.txt`) → `tombstonePath(oldPath)` (else the old row
      orphans, pointing at a path that no longer renders).
    - non-doc → doc (`a.txt`→`a.md`) → `indexFile(path)` (new doc).
    - non-doc → non-doc → skip.
- `reindexSpaceFull` (full rebuild via `listTree`): unchanged control flow, now
  keyed by `sourcePath`. A full rebuild has no before-tree, so it cannot
  reconstruct renames and does **not** reconcile vanished paths (pre-existing
  behavior) — it is a recovery/rebuild op; the incremental path maintains id
  continuity in normal operation.

### 4. Link previews (Open Graph) — Q2

WhatsApp/Slack/iMessage render a link card from `og:title` / `og:description`.
Today only the **share** page emits `og:title`
(`src/app/s/[token]/[slug]/page.tsx:32`); the **doc viewer** has no
`generateMetadata`.

- `src/app/(hub)/docs/[slug]/page.tsx`: add `generateMetadata` →
  `openGraph: { title, description, type: "article" }` +
  `twitter: { card: "summary", title, description }`. Uses the same viewer-scoped
  `getDocBySlug`; a doc the caller can't see yields neutral default metadata (no
  title leak — mirrors the page's own 404 path).
- `src/app/s/[token]/[slug]/page.tsx`: enrich the existing metadata with
  `description` + `twitter`.
- Shared helper `docPreviewDescription(doc)`: frontmatter `description`/`summary`
  if present, else a trimmed plain-text snippet of the body (≤200 chars,
  markdown/HTML stripped). New tiny module `src/lib/preview.ts`.
- `og:image` (rendered thumbnail card) is **deferred** — out of scope.

### 5. Space git-tree file view — the reverse path→slug couplings (blocker from review)

These build the *public* slug from the repo path and would 404 under random ids:

- `src/lib/web-author.ts` `listSpaceFiles` + `src/app/(hub)/spaces/[slug]/page.tsx:98`
  (`docSlug: slugForPath(f.path)`), consumed by
  `src/app/(hub)/spaces/[slug]/SpaceFilesView.tsx:46-48` (`/docs/${f.docSlug}`).
  **Fix:** `listSpaceFiles` joins each tree path to the `docs` projection by
  `(spaceId, source_path)` and surfaces the **real** `docs.slug` (undefined when
  the path isn't a projected/live doc). `page.tsx` stops calling `slugForPath`.
- The existing `SpaceDocsTree.tsx:140` path is already DB-sourced (`d.slug`) —
  no change.

### 6. Create-doc endpoint (blocker from review)

- `src/app/api/spaces/[slug]/docs/route.ts` `handleNewDoc` (`:186`): previously
  pre-checked uniqueness and returned the created slug via `slugForPath(repoPath)`
  (both wrong under opaque ids). **Fix:** (a) replace the 409 guard with a real
  `(spaceId, source_path)` live-doc existence check (`getLiveDocBySpacePath` in
  `docs.ts`); (b) after `webAuthorCommit` on `main`, look up and return the
  **actual** `docs.slug` for `(spaceId, source_path)` (the random id minted by the
  indexer), not a path-derived one. A proposal write returns `slug: null` (not
  projected yet).
- `publishDoc` reconciliation is **dropped** (see Revision 2): with a non-unique
  index there is no DB violation to convert, and `source_path` stays a non-unique
  provenance stamp on the legacy publish path.

## Tests (boundary-critical — the access boundary is sacred)

`npx vitest run` (serial):

- **Cross-space isolation** (`indexer.test.ts`): two spaces, both `README.md` →
  two independent live rows, distinct ids; indexing space B never reads/writes
  space A's row. *Sacred cross-space projection-isolation coverage.*
- **Extension no longer collides**: `foo.md` + `foo.html` in one space → two docs,
  distinct ids, formats `md`/`html`. (The reported bug, fixed.)
- **Rename preserves id** (incremental): commit at `A`; `git mv A B`; incremental
  reindex → same id, `sourcePath = B`, `A` not left as a live orphan.
- **Web-author-style rename** (delete `A` + write identical bytes at `B`, one
  commit) → `R100` → id preserved.
- **Rename doc→non-doc** (`a.md`→`a.txt`) → old row tombstoned, no orphan.
- **Cross-folder move** preserves id, updates folder `path`.
- **Ids are opaque** — projected slug matches `^[a-z0-9]{9}$`, not the path.
- **`changedPaths` `-z -M` parser** (unit): A/M/D + an `R` record parse correctly
  and don't desync a following record.
- **`listSpaceFiles`** surfaces the real random `docs.slug` for a projected path
  (not a path-derived slug), and `undefined` for a non-doc/unprojected path.
- **`handleNewDoc`** returns a slug that actually resolves via `getDocBySlug`.
- **OG metadata**: doc + share `generateMetadata` return the doc title in
  `openGraph.title` and a non-empty `description`; a non-visible doc leaks no
  title.
- **Retarget existing tests** asserting path-derived slugs (`indexer.test.ts`
  `slugForPath`/`isDocPath`/`slugForPath("README.md")==="readme"`, and any
  `commitFiles({"a.md"})` expecting slug `a`) to the new identity model.

## Out of scope / deferred

- `desk_id` frontmatter/`<meta>` anchor (identity pin surviving rename+rewrite in
  one commit, and a git-less future). `git diff -M` suffices for pure moves in v1.
- `og:image` thumbnail cards.
- `/{owner}/{space}/{path}` readable URLs — opaque `/docs/<id>` stays.
- Full "`publishDoc` upserts by source_path" semantics (only the collision is made
  safe here).
- The git read/write **auth** boundary (`resolveSpaceRole`, push-policy) —
  untouched.

## Rollout / landing posture (per AGENTS.md)

Branch `feat/doc-identity-opaque-id`. TDD. Run the full suite + `pnpm typecheck`
+ `pnpm build`, then **STOP for review** before any deploy push. No `--force`, no
`--no-verify`.

**Test-suite note:** many existing tests seed multiple docs at a shared
`source_path` (a "provenance stamp") and assert path-derived slugs. Those
assertions were retargeted to `sourcePath`/the real opaque slug (`indexer.test.ts`,
`import.test.ts`, `read-path.test.ts`). The non-unique index means the shared
`source_path` seeding keeps working — no fixture rewrite needed.
