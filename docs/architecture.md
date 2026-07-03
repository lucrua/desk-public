# Desk — Source of truth, spaces, packs (foundational design record)

> **Status: ACTIVE — foundational.** The architecture decision the whole Desk chapter rests on: **what is the source of truth, how is access drawn, and how do humans + agents share and edit the same documents.** Read this before `design.md` — it reframes the canon/storage model recorded there.
> **Audience & voice:** instance-neutral / public-safe. This doc names **roles** (the *owner*, a *coworker*-reader, an *external partner*, a *headless agent*), never specific people, companies, repos, or deployments. Instance bindings (which repo to import, real hosts, real names) live in the long-run launch prompt and a private runbook, **never here.** Keep it generic — Desk is open-source/portfolio-grade; any docs-as-source repo is just a demo dataset.
> **Last updated:** 2026-06-19
> **Role:** The foundational model every downstream Desk spec inherits, plus the **Phase-1 build contract** (§14–§15) and the **Phase-2 contract** (§16). AUTH-SENSITIVE throughout — it defines the write boundary.
> **Supersedes / reframes:** the **canon direction** in `design.md` §3 and the **sync model** in `sync-spec.md` (cloud-Postgres-as-canon + sync-client). See §11. **Keeps** intact: the proposed-revision conflict model, the both-channels parity rule, events-as-first-class, and the NO-BACKUPS standing risk.
> **Related:** `specs/desk/design.md`, `specs/desk/sync-spec.md` (superseded), `specs/desk/collab-spec.md`, `specs/desk/kanban-catalog-spec.md`, the Desk repo, and the headless-agent program doc (Desk's first write-member).

---

## 0. Why this doc exists

A design conversation kept circling one question that felt unanswerable: *if the truth is files in a repo, but Desk also holds them, and both can be edited — which is the truth, and how does one not drown in sync conflicts?* The breakthrough: the question was **mislabelled**. This doc records the model that dissolved it, so it is never re-derived.

## 1. The one principle — one source, many doors

**Desk is a render + access + feedback layer over a source. It is never a second place the content lives.**

The feared pain — "multi-source-of-truth" — is not what the system is. Two different problems:

- **Multi-source-of-truth** = the *same document exists as two independent, editable copies* that must be reconciled. ← the thing to avoid.
- **One source, many doors** = the document lives in *exactly one place*; the filesystem, the web UI, and the API/MCP are all **windows onto that one copy.** Editing through any door edits the one document. ← no reconciliation, because there is only one copy.

Every painful branch (two-way sync, auto-merge, native-vs-mirror copies) came from accidentally creating the *first* shape. The fix is not to sync two copies better — it is to **never have two copies.**

## 2. Truth vs projection

- **Truth = files, in git repos that Desk hosts** (§3, §4).
- **Desk's Postgres = a derived *projection*** of those files: the render cache, the catalog/board/table indexes, resolved cross-links — **plus** Desk's own *native* data that has no file (comments, approvals, shares, audiences, view-tracking, access requests).
- **The projection is rebuildable from the repos.** Lose it and you lose feedback + access config + cache — never a document. Truth is reproducible; the cloud layer is derived.

Mental model: **the filing cabinet is the git repos; Desk is the room** with everyone's cabinets in it. Editing a document = editing the file (any actor, through the hosted git). Desk renders, scopes who sees which, and holds the sticky notes. There is exactly **one** of every document.

## 3. Spaces and the access model

A **space** is an owned, access-controlled **git repo that Desk hosts.** It is the unit of write/clone access and the security boundary. Desk is **multi-tenant**: N owners × spaces, symmetric. Each principal's home = *"my spaces + what's shared with me."*

Write and read have **different natural granularities**:

| | Unit | Lives where | Granularity |
|---|---|---|---|
| **WRITE** (change the truth) | a **space** (a git repo, with owner + members) | the files / git | **coarse** — by space membership |
| **READ / SHARE** (view a rendered doc/folder) | a **share / tier / audience / pack** over a subset | Desk's projection | **fine** — per doc, per directory, per pack |

**Why the split is forced, not arbitrary:** a git repo is the *finest access boundary git can enforce*. Sparse-checkout and partial-clone only change what a client downloads — not what it *may* fetch. Stock git has no server-enforced per-folder ACL. So **the repo is the security boundary for anyone with clone access.**

### The reader-vs-agent asymmetry (the key clarifier)

- **A reader (a coworker)** is scoped in the **projection** — Desk renders per-doc/dir/tier, default-deny. They can be shown one document and none of the owner's private work *even from the same repo*, because their access is a rendered view, not a clone. **Readers never force a repo split.**
- **A file-running agent** needs *real files on disk* to run. It cannot consume a rendered view; it needs a working tree → clone-or-export. **So the agent is the actor bound by the repo boundary**, and the only one forcing a decision about how to hand it a subset (→ §5 packs).

So: *write is repo-grained, read is doc-grained.* "I don't want to share everything with the agent" lands entirely on the write/agent side; readers are already handled by the projection's tiers (built today as the `audience` field + capability/directory shares).

## 4. The two locked decisions (2026-06-19)

1. **Desk hosts the git** (Gitea-like). Smart-HTTP backend + an auth gate mapping **principal token → space ACL**; bare repos on the host's disk are the canonical store every door reaches. A `post-receive` hook fires **re-projection** (rebuild the index/render cache). *This is git-as-the-single-store, not git-as-a-sync-mechanism* — one copy; the hook only refreshes a derived view Desk owns.
2. **Some owners are web-only.** A web edit becomes a **real commit** into the space's repo (author = the editor's principal, committer = Desk). Web edits and agent edits land in the **same git history, indistinguishable in kind.** Concurrency is the git way: a web commit is a **compare-and-swap on the ref** (based on commit X; if the tip moved, re-apply the small edit, else tell the user "someone just changed this, reload"). Reject-and-retry on one small edit — **not** a background auto-merge daemon.

Both are auth-sensitive; their changes are held for owner review before any deploy.

## 5. Packs — the access/sharing primitive

A **pack** is a **manifest-defined *view* of a subset of a space, materialized as a cloneable git repo.** It gives an agent (or a person) exactly its allowed slice **without physically splitting the source repo** — the *view repo* becomes the boundary.

A known, production-grade pattern — build the known thing:
- **Google Copybara** — moves a path-remapped subset of files between a monorepo and external repos, **bidirectionally, with review.**
- **josh** ("git for monorepos") — serves **virtual repos** via filters (subdir select, prefix/rename), clone + **push back** mapped into the monorepo.
- **Perforce client views** — decades-old remapped subset workspaces, submit maps back.

### Shape

A pack manifest is config in the source repo (`.desk/packs/<name>.yml`) declaring `source-path → view-path` rules, **directory-level** (so new files a writer creates have a deterministic home). Example:

```yaml
# .desk/packs/<name>.yml — a re-organized subset
includes:                         # explicit; default-deny
  - registries/conventions.md  -> conventions.md
  - registries/findings.md     -> findings.md
  - reports/2026-06-21-run/     -> reports/2026-06-21-run/
denies: []                        # optional subtractions
```

### Two directions, very different cost

- **Forward (source → pack)** is cheap — a *build*: gather the manifest's files, lay them out, commit to the view repo. **Read packs use only this.**
- **Reverse (PR on the pack → merge into source)** is the real subsystem — needs an **invertible mapping**, a **home for new files** (hence directory-level rules), a **rebase onto current source** if it drifted, and a **history policy** (simplest: **squash** the pack PR into one proposed source changeset).

### Two de-riskers that make it practical

1. **The review gate absorbs ambiguity.** The reverse-mapper produces a *proposed source-space changeset the owner reviews* (edit/drop) — it may **flag** anything it cannot confidently map rather than being bulletproof.
2. **Reads need no reverse at all.** A read pack (coworker / external partner) is forward-only.

### Build decomposition (value first)

- **Read packs** (curated, remapped shareable bundles): low cost, high value; generalize "share a folder" → "share an arbitrary re-organized set." **Remap freely** (no reverse).
- **Write packs**: **start path-preserving** (a subset keeping source paths → reverse-merge is just a normal subset PR, trivial). **Remapped-AND-writable is deferred** (§17) — the single hardest piece.

### Pack manifest = an ACL

Explicit `includes` (default-deny; no broad globs that could swallow a future sensitive file), optional `denies`, a **preview that resolves globs to a concrete file list** (with sensitive-pattern warnings), and an **explicit confirm on activate/rebuild.** Cross-links to documents outside the pack resolve-or-hide (§13.2), never leaking the target.

## 6. Catalogs as projection

A catalog — "a database of pages, each with editable metadata" — is **a projection over files that share a declared schema:**
- **A page = a file; its metadata = the file's frontmatter** (or a row in a registry file). That is the **truth**.
- **A catalog = the index**: Desk reads frontmatter, validates against a schema declared **in the repo** (`.desk.collection.yml` — read by Desk, never hardcoded, so Desk stays generic), and renders **board / table / list** views, grouped/filtered by field.
- **Editing metadata** = editing the frontmatter (an agent does this) or a **web suggestion → commit.** The "DB of pages" feeling is the *view*; the truth stays in the file. A collection = items conforming to a declared schema, **however stored** (one-file-per-item *or* rows-in-one-registry-file) — both feed one view engine.

This reframes `kanban-catalog-spec.md`'s "catalogs = Postgres rows authored in Desk" into "catalogs = the projection of repo frontmatter/registries." (Reconciliation: §11.)

## 7. The headless-agent workflow (the proof case)

The automation that justifies the foundation — works entirely within the model:

1. **Trigger.** A card assigned to the agent (the board is a Desk surface) emits a Desk **event** (`card.assigned`, agent = a bot principal) → webhook → a small **runner** (Desk does not manage runners).
2. **Scoped inputs.** The agent authenticates with its **own principal token** and gets its allowed subset as files — its **pack** (clone if path-preserving; or a per-run export). It holds no credentials to private spaces, so private work never reaches it.
3. **Run.** The agent runs *on its own host* against those files (registries, prior reports — including prior accepted agent output, which lives in the shared set).
4. **Propose, don't write.** New entries the agent wants to add, and the report itself, come back as a **PR (reverse-merge) → a proposed source-space changeset** — exactly Desk's existing propose→review→accept revision path.
5. **Review gate.** The owner reviews (locally or in the web), **edits/drops** anything, accepts the rest. The report stays **unpublished until accepted.**
6. **Publish.** On accept it commits to the space and is **tier-shared to the coworker** (and visible to future runs). Nothing is coworker-visible until the owner approves.

## 8. Why "finishing auto-share" is safe (retiring manual upload)

Killing the manual upload-to-share does **not** mean "Desk renders the whole repo to everyone." Desk renders **per space and per tier, default-deny.** A coworker sees the shared tier; the agent sees its pack; private work renders **to the owner only.** "Same copy" means *Desk shows the live file instead of a stale manual upload* — not *one public mirror.* Nothing is shared by virtue of existing in a repo; sharing is always (a) membership in a space, (b) an explicit tier/share, or (c) a pack. Manual upload dies **because of** the access model, not in spite of it.

## 9. Built today vs net-new

> **Status update (2026-07-03):** the Phase-1 and most of the Phase-2 net-new work below has **landed on `main`**. README's "What's built vs. not" table is the canonical current inventory; this table now reflects reality. Audiences (the old per-doc read tag) were **retired** (consolidation D2) — read scoping is space-scoped only. The remaining not-built items are packs and the headless-agent runner.

| Capability | State |
|---|---|
| Capability + directory shares, view-tracking, roles/principals, per-doc owner | 🟢 built — the **read-scoping** layer (space-scoped; audiences retired) |
| Proposed-revision (propose → review → accept) | 🟢 built — the DB review gate; git-native **proposals/PRs** now sit alongside it |
| Catalog (projection of a space directory's frontmatter + optional `.desk.collection.yml` schema) | 🟢 built — reframed from Desk-authored to **projection of repo frontmatter** (D6) |
| Events table (`card.assigned`, etc.) | 🟢 built — the **agent trigger** consumes it (poll-based; no webhook) |
| **`space`** (owned, access-controlled hosted git repo) | 🟢 built — the structural keystone |
| **Desk hosts git** (smart-HTTP + token→ACL auth + post-receive re-project) | 🟢 built — the main subsystem |
| **Web authoring** (web new-doc / edit / upload → commit, CAS-on-ref) | 🟢 built — owner/writer direct or a proposal under `push_policy`; guest authoring (W2) deferred |
| External collaboration (invites → self-serve onboarding; per-space `push_policy`; proposals-as-PRs) | 🟢 built |
| Content store is **git, not DB** (doc rows are an *index* of repo files, via the indexer) | 🟢 built — a few legacy DB-direct write paths (`publish_doc`, `acceptRevision`) are being converged onto git commits (see `specs/convergence-fix-pass.md`) |
| **Packs** (manifest view-repos; forward build; reviewed reverse-merge) | 🔴 not built |

## 10. Value-first build order

- **Phase 1 — retire manual upload** (§14). Host one space as git; `git push` replaces manual upload; render + tier-share to a coworker-reader. The load-bearing primitive. ✅ **shipped.**
- **Phase 2 — make it a host** (§16). Multi-space + membership; the headless agent as a write-member; catalogs/boards as projections; web authoring; external collaboration. ✅ **shipped** (except **read packs** — still deferred, and the **headless-agent runner** — the event/proposal primitives exist but the runner does not).
- **Phase 3 / deferred** (§17). Remapped-writable pack reverse-merge; feedback round-trip into the repo; scheduled re-publish; read receipts (last-viewed already exists). ⏳ **deferred.**

Each phase ships standalone value; none re-decides anything — the model is identical at every step.

## 11. Relationship to the prior design docs (explicit reconciliation)

This record **inverts the canon direction** the chapter previously assumed:

- **`sync-spec.md`** framed *"cloud Postgres becomes the source of truth; local files are replicas that converge via a sync client."* **Superseded.** New model: **hosted git is the truth; Postgres is a projection.** No bidirectional sync client. Its **proposed-revision conflict model, folders-via-`path`, events-as-first-class, and member-pushes-are-revisions all survive** (they map onto pack reverse-merge + web-commit). Already re-statused.
- **`design.md` §3** ("canon = cards now, catalogs later"; cloud-as-canon; agents online-first with a `pull` cache). The **pull = cache/backup** intuition survives; the **cloud-as-canon** direction is reframed to **git-as-canon, Postgres-as-projection.**
- **`kanban-catalog-spec.md`** — catalogs as Postgres rows authored in Desk → reframed to **projections of repo frontmatter/registries** (§6). The schema-as-data engine is reused; its *input* moves from Desk-authored to repo-sourced.
- **NO-BACKUPS requirement** (`sync-spec.md`) carries forward and sharpens: before any space holds **cloud-only canon**, off-box backups must exist and be restore-tested. Bare git repos are the canon to protect (easy to mirror); Postgres holds feedback + access config (must be dumped too). Do not silently drop this.

## 12. Rejected alternatives (and why)

- **Two-way file sync / auto-merge** (Dropbox conflict-copies, or Notion/Docs op-log). A *phantom requirement*: no mapped use case needs concurrent automatic merge of opaque content. The cross-machine round-trip is **git's job**; cloud-edit→source is **propose/accept.** Two-way sync re-introduces the exact things rejected (conflict-copies polluting the repo, Desk writing into the repo as a daemon, runtime source-of-truth ambiguity) and makes Desk a forever-buggy sync engine. The impossibility is structural: you cannot have *(A) edit as plain files with any tool* + *(B) concurrent automatic merge* + *(C) no conflict-copy/manual-merge* at once; every system surrenders one. Desk surrenders automatic-B (uses propose/accept) and keeps A + C.
- **DB-as-truth / Notion model.** Cleanest *web* story, but it breaks filesystem-native agents (every agent would speak an API instead of reading files) and contradicts "don't author in Desk." Only correct if the **web** becomes the primary authoring surface — which it is not (every *writer* is file-native; the web is mostly read + feedback).
- **git-as-a-sync-hook between two copies.** The fragile post-commit-pushes-into-a-second-store pattern. Rejected — and distinct from **git-as-the-single-store** (adopted): the latter has no second copy.

## 13. Resolved decisions (2026-06-19)

1. **Remapped-AND-writable packs → deferred** (§17). Write packs are path-preserving in v1; read packs remap freely.
2. **Cross-space / pack link resolution → default-deny, no existence leak.** A `[[…]]`/relative link whose target is outside the viewer's accessible set renders as plain, non-clickable text — never revealing the target's title or existence; inside the set it resolves with backlinks. Scope = the viewer's spaces + shares + the pack they view through.
3. **Web-commit concurrency → CAS-on-ref + single-edit 3-way apply + reject-preserving-draft.** The commit asserts its base ref; if the tip moved, attempt a clean 3-way apply of the one edit; if it won't apply, reject with "this changed while you were editing — reload," preserving the user's draft client-side. No CRDT/realtime.
4. **Pack manifest → owner-authored `.desk/packs/<name>.yml`; explicit `includes` (default-deny) + optional `denies`; preview resolves globs to a concrete file list with sensitive-pattern warnings; explicit confirm on activate/rebuild.**
5. **Git transport → HTTPS smart-HTTP; principal token as Basic-auth password; an authz middleware in front of `git http-backend` maps token→principal→space-role and gates `git-upload-pack` / `git-receive-pack`.** No SSH in v1; no full Gitea sidecar.
6. **First space → import the owner's existing docs repo as one private space** (initial commit = current files); share subsets out via tiers/packs.
7. **Sequencing → Phase 1, then Phase 2 in sequence, before any public release.** Phase 1 ships + is smoke-tested by the owner; Phase 2 follows; only then is Desk made public.

## 14. Phase-1 implementation contract (the long-run build)

**Goal:** one space, hosted as git, where `git push` (or web-commit) is the *only* publish path, Desk renders the latest, and a tier-share shows a coworker the current version — **no manual upload anywhere.** Build the `space` abstraction so Phase-2 multi-tenancy is purely additive, even though Phase 1 has a single owner-only space.

**Schema (Drizzle + migration):**
- `spaces` { id, slug (unique), ownerUserId → users.id, visibility (`private`|`unlisted`|`public`), createdAt }.
- `space_members` { spaceId → spaces.id, userId → users.id, role (`owner`|`writer`|`reader`), PK(spaceId,userId) }.
- `docs` gains `spaceId → spaces.id` (NOT NULL). Every doc belongs to exactly one space.
- Journal/ordering gotcha applies (strictly-increasing `when`, atomic migration+journal+snapshot).

**Content store DB → git (the core refactor):**
- Content leaves `doc_versions`; the canonical bytes live in the space's git repo at the doc's `path`.
- Doc/version rows become a **projection index**: { slug, path, spaceId, currentCommit (sha), renderedCache, parsedFrontmatter (jsonb), contentHash }. Git history *is* version history; keep a thin `doc_versions` row per indexed commit for the existing version UI, sourced from git.
- **Migration/import:** create the first space from the owner's existing docs repo — initial commit = current files — then backfill the projection by indexing every file once.

**Git hosting (the main new subsystem):**
- Serve smart-HTTP for `…/<owner>/<space>.git` (`info/refs`, `git-upload-pack`, `git-receive-pack`).
- **Auth:** HTTP Basic; password = a principal token (username ignored). Middleware resolves token → principal → role on the target space: `reader+` may `upload-pack` (clone/fetch); `writer|owner` may `receive-pack` (push). Anonymous → 404-uniform on private spaces (no existence leak).
- Implementation: wrap the system `git http-backend` (spawned, CGI env) behind the middleware; do **not** embed a full git server or run Gitea.
- **Bare repos:** `<DATA_DIR>/spaces/<owner-slug>/<space-slug>.git`.

**Indexer (projection builder):**
- A `post-receive` hook (and the web-commit path) enqueues a **re-index over changed paths**: parse frontmatter, rebuild render cache, upsert doc rows + (later) catalog/link rows, advance `currentCommit`. Idempotent; incremental on changed paths; full-reindex available as a recovery command.

**Read path (reuse what exists):**
- Hub render and capability/tier shares now serve from the **projected render** of the current commit. Tier-share semantics, expiry, uniform-404 for revoked/unknown — **unchanged**.

**Parity & conventions:**
- Any new capability (create space, list spaces, set member role) exists in **REST and MCP** (both-channels rule) with help updated. Events emitted for space/member mutations.

**Landing posture (auth-sensitive):**
- Work on a **branch in the Desk repo, commit locally, and STOP for owner review. No push to the deploy branch** (it auto-deploys to production). Git-transport auth is maximally security-sensitive — it gates read/write to every space.

**Definition of done:**
- Full suite + build + typecheck green; new schema migrated; the import produced a hosted space whose projection matches the source; §15 smoke tests pass on a local/staging run; diff committed on a branch, nothing deployed.

### Built 2026-06-19 (branch `feat/phase1-document-host`, unmerged)

Implemented headlessly in 3 atomic commits (`52243b2` schema · `4d8896f` hosting/store/indexer/import/parity · `dfce023` read-path), 39 files (+5707). All 7 §14 items landed.
- **Verified:** full suite **1390 tests green** (+97), `pnpm build` + `pnpm typecheck` clean, migration `0015_p1_spaces_document_host` applies on fresh + populated DBs. *Independently re-confirmed:* git auth matrix + live clone/push e2e + spaces service (48 tests) pass; primary checkout clean; nothing pushed.
- **Auth boundary:** `principal_tokens` (sha256, raw-once) = the git HTTP-Basic credential → user → space role; every denial → **uniform 404**; `401`+`WWW-Authenticate` when no creds.
- **⚠ Prod-integration gates BEFORE any deploy (owner action):**
  1. **Cloudflare Access** fronts the hub and expects a CF-Access JWT, but a git CLI sends HTTP Basic. CF Access must be configured to let `/api/git/*` through to the app's token gate (or the transport reached on a path/host CF Access doesn't gate). *The one integration point not testable headlessly — the most likely blocker for real clone/push.*
  2. **`DESK_DATA_DIR`** → a **backed-up off-box volume** (bare repos are the canon; NO-BACKUPS risk §11). Dev default `<cwd>/.desk-data` (gitignored).
  3. **`git-http-backend`** present on the prod host (`/usr/lib/git-core/git-http-backend`, override `GIT_HTTP_BACKEND_BIN`); system `git` on PATH in the deploy image.
- Import = one-way seed (git-tracked files only; excludes `.env*` / `personal/` / `CLAUDE.local.md`); refuses existing slugs; **not** a prod cutover. Post-receive hook provided but not auto-installed (in-route re-index is the robust path).
- **Status:** awaiting owner local review; not merged, not deployed.

## 15. Phase-1 owner smoke tests (the simple manual checks)

Run these against the branch build before anything is deployed. Each is one action + one expected result:

1. **Token clone.** `git clone https://<host>/<owner>/<space>.git` with your token → succeeds. With **no/invalid token** → denied (and a private space returns a uniform 404, not "403 exists").
2. **Push re-renders.** Edit a file, commit, `git push` → the hub view of that doc shows the change **within seconds** (no manual upload).
3. **Share shows latest.** Open the coworker tier-share link → it shows the **just-pushed** version, not a stale copy. A revoked/expired link still returns the uniform 404.
4. **Role enforcement.** A **reader** token can clone but a `git push` with it is **rejected**; a **writer/owner** token can push.
5. **Web edit = commit.** (If web-commit is in this run) edit in the browser, save → a new commit appears in `git log`, and your local `git pull` retrieves it.
6. **Nothing shipped.** Confirm the work is on a branch and **the deploy branch is untouched** — production is unaffected until you choose to deploy.

## 16. Phase-2 implementation contract (next in sequence, before public)

Built after Phase 1 ships and passes §15. Each item keeps REST+MCP parity, emits events, and is owner-review-gated before deploy.

1. **Multi-space + membership.** Owners create spaces and add members with roles (`owner|writer|reader`); hub home = "my spaces + shared-with-me"; all queries scoped by space. (Schema already laid in Phase 1.)
2. **Headless agent as a write-member.** The agent's token → `writer` on its space (or a **path-preserving** pack). `card.assigned` → webhook → runner → agent pulls its scoped inputs → proposes back via PR/revision → owner review gate → publish to the reader tier. (Remapped reverse-merge stays deferred — path-preserving reverse = a normal subset PR.)
3. **Catalogs / boards as projections.** Read `.desk.collection.yml` from the repo; render board/table/list grouped/filtered by frontmatter field; validate docs against the schema (flag drift); resolve `[[…]]` wiki-links + backlinks within the viewer's accessible set (§13.2).
4. **Web-commit.** Web edit → commit (author = principal, committer = Desk); CAS-on-ref + single-edit 3-way apply + reject-preserving-draft (§13.3). Enables web-only owners to author.
5. **Read packs.** Manifest-defined forward-only view-repos (§5); remap freely; preview = resolved file list + sensitive-pattern warnings; default-deny; clone over the same token-auth transport.

**Phase-2 done:** the agent loop runs end-to-end (assign → run → propose → review → publish) on real data; a coworker self-serves a read pack; a web-only edit lands as a commit; a catalog renders from repo frontmatter and validates it. Then — and only then — evaluate going public.

## 17. Deferred / explicitly out of scope (for now)

- **Remapped-AND-writable packs** (the hard reverse-merge with path transforms) — until a named need.
- **CRDT / realtime co-editing** — propose/accept + CAS covers the real cases.
- **SSH git transport** — HTTPS-token only in v1.
- **Binary / large-file lane** — separate future concern (consider LFS/object store for assets).
- **Scheduled re-publish** (P3) and **read receipts** (largely exist via `share_views`).

## 18. Still-open design questions (do not block Phase 1)

1. Web-commit conflict UX edge: auto-rebase threshold for "non-overlapping" before falling back to "reload."
2. Pack-manifest preview UX surface and who may author a manifest (owner-only assumed).
3. Cross-space link rendering detail (plain-text stub vs hidden) when the target is inaccessible.
4. Full generic sweep of the *other* `specs/desk/` docs (this record is done; the rest still name people/partners).
