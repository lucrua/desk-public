# Desk — Convergence fix-pass: git-truth writes, share-boundary fix, tiered client editing, GitHub mirrors, agent loop (build spec)

> **Status: DRAFT — pending owner review (2026-07-03).** Grounded in a four-agent read-only survey of `main@46de1d9`. This spec is the consolidation outcome: it fixes what contradicts the model, closes the two external write loops (clients and agents), and deletes what the consolidation already retired. It deliberately builds **nothing speculative** — every slice either fixes a found defect or completes a loop the owner's proof case (acme-growth Amplitude reports) needs.
> **Model:** inherits `docs/architecture.md` (space = git repo = boundary; truth = the file; Postgres = derived projection; publish = push). The organizing principle of this whole spec: **every content write converges on a git commit in the space's repo on Desk; Desk fans out from there.** Reuses: `commitFiles` (web-author W1 primitive), capability links (sha256-at-rest, uniform-404), `push_policy` + proposals (E2), the revisions queue + diff UI, `DESK_TOKEN_KEY` AES-GCM encryption (share-reveal machinery).

## Why (findings this spec answers)

1. **`publish_doc` (MCP) / `POST /api/docs` (REST+CLI) write Postgres only, never git**, and have no `space` param — a NEW doc silently lands in the default `workspace` space: not a file, invisible to a clone, invisible to the target space's members. Violates truth-in-git.
2. **`acceptRevision` → `publishDoc` also writes Postgres only** — accepting a revision updates the doc row while the file in the repo silently keeps the old content. Git and projection drift.
3. **Directory shares are not space-scoped** — `listDocsUnderShare` filters by path prefix with no `spaceId` predicate; same-named folders in two spaces leak through one link. Read-boundary bug.
4. **A share-link visitor can read and comment but has no edit path of any kind** — the owner's tiered-collaboration goal needs an anonymous "suggest edit" on the share surface.
5. **No durability story for canon** — `DESK_DATA_DIR` on one box, no backups (a standing risk flagged in `architecture.md` §11). Owner wants GitHub as the comfort/backup layer, per-space, without bespoke sync.
6. **Deployed staging MCP runs pre-consolidation code** (still advertises retired audience/catalog tools) and **README/architecture still label built features "not built"** (web-author W1, E1/E2).
7. **Gen-1 corpses linger**: dormant `audiences`/`audience_members`/`docs.audience`, dormant P3 `catalog_*` registry + inert auto-linker, vestigial `audience` params on MCP wire schemas, the CLI's non-git `desk sync`/`desk publish`.

## Decisions

- **D-C1 (tiered client editing).** Casual clients suggest edits **anonymously through the share link** (capability-scoped, no account, like comments today). Repeat collaborators use the already-built invite → membership → `push_policy` path. Both tiers' accepts land as **git commits**.
- **D-C2 (one merge machinery).** Git proposals (E2) stay the canon review path for git-capable actors. The DB `revisions` table survives **only** as the queue for browser/share suggestions — and its accept path is rebuilt on `commitFiles`. `publish_doc`/`POST /api/docs` are rebuilt on `commitFiles` with a **required `space`**. `desk sync` and the CLI write commands are retired. After this spec, **no code path writes doc content to Postgres except the indexer projecting git.**
- **D-C3 (source modes).** Per-space `source_mode ∈ {hosted, mirrored}`, **default `hosted`**. `hosted`: Desk is canon; Desk mirror-pushes `main` to a paired GitHub repo (one-way, conflict-free by construction). `mirrored`: GitHub is canon; a GitHub Action forwards pushes to Desk; Desk-originated commits are refused server-side. Invariant, documented everywhere: **every repo has exactly one push target; the other side is read-only.**
- **D-C4 (mirror config placement).** Mirror target + credentials live in **Postgres, owner/admin-settable** — never in-repo, never in a local file. Rule of thumb this encodes: *in-repo files configure how content renders (`.desk.collection.yml`); Postgres configures who can do what and where data flows (members, visibility, `push_policy`, shares, mirrors).* A mirror target is data egress — same trust class as a share.
- **D-C5 (credentials).** One **instance-level fine-grained GitHub PAT** (Contents: Read/Write only), entered once, AES-GCM-encrypted with `DESK_TOKEN_KEY`, write-only (never revealed back). Optional **per-space deploy-key override** for isolation. GitHub App: deferred.
- **D-C6 (dispatch).** No webhooks — the agent has no public interface, and near-real-time doesn't need one. v1: the agent **cursor-polls `list_events(kinds:["card.assigned"])` every 30–60 s** (outbound-only, CI-runner pattern). Optional later: a `wait_seconds` long-poll param on `list_events`. The runner is cron in the agent's container; Desk hosts no runner.
- **D-C7 (fail-closed backfill).** Existing directory shares that can't be unambiguously assigned to one space are **revoked** by the migration, not guessed at.

---

## Slice 0 — Hygiene: deploy + docs truth (no product code; do first)

- **Operator:** redeploy staging (`desk.example.com`) from current `main` so the live MCP registry matches the code (43 tools; retired audience/catalog tools gone). Re-run the README curl smoke (`initialize` → `tools/list` → `whoami`). Standing rule from here on: **redeploy staging after every landed slice** — the MCP-drift found in this survey must not recur.
- **Docs edits (committed):** README "What's built vs not" + `architecture.md` §9/§16 — mark web-author W1, E1/E2 invites + push-policy + proposals, and doc-identity as built; keep W2, packs, runner, wikilinks as not-built. Fix `consolidation-and-decisions.md` branch-status language: in this repo the full stack is merged to `main` (the "on branches / main is pre-consolidation" narrative is historical). Note in `docs/README.md` that pre-consolidation screenshots are historical.
- **Tests:** none (docs). Build must stay green.

## Slice 1 — Directory-share space scoping (boundary bug; security-critical, small)

**Schema (hand-authored migration):** `shares.space_id uuid NULL REFERENCES spaces(id)`. Required going forward for directory shares (doc shares keep deriving their space via `doc_id`; backfill doc shares' `space_id` from their doc for uniformity).

**Backfill (one-shot, at migration time):** for each existing directory share, resolve the set of spaces owning currently-matching docs. Exactly one space → set `space_id`. Zero or >1 → **revoke** (D-C7) and log the share id + prefix so the owner can re-mint.

**Code:** `createDirectoryShare` gains a required space argument; `listDocsUnderShare` adds the `space_id` predicate; `resolveShareDoc`'s prefix guard unchanged. REST `POST /api/shares` and MCP `create_directory_share` gain a required `space` param (breaking MCP change — acceptable, the deployed registry is being replaced in Slice 0; update `/help`). Folder-share UI already operates in a space context — pass it through.

**Tests (exhaustive, boundary-class):** the leak regression (two spaces, same `reports/` prefix, one share → only the share's space's docs resolve, both in the index and via `/s/<token>/<slug>`); backfill unambiguous/ambiguous/empty cases; create-without-space rejected; full share matrix (valid/revoked/expired/deleted) still uniform-404.

## Slice 2 — Git-truth write convergence (kills findings 1 + 2)

Everything here funnels into `commitFiles` (CAS on ref tip, throwaway worktree, author = acting principal, committer = Desk) followed by the existing synchronous reindex.

- **`acceptRevision`:** on accept, commit the revision content to the doc's `(space, sourcePath)` on `main` via `commitFiles`, then let the reindex project it (the projection write via `publishDoc` is replaced by the indexer's own path). CAS conflict → re-read tip, retry once, else surface a stale error to the reviewer. Commit author: the proposer label (e.g. `link:<share label>` after Slice 3, or the member handle), committer Desk. **Materialization pre-step (one-time):** any doc row whose `sourcePath` has no corresponding blob in its space repo (legacy `publishDoc`-created rows, incl. the `workspace` space) gets its current version content committed to the repo, so accept-time CAS always has a real base.
- **`publish_doc` (MCP) + `POST /api/docs` (REST):** rebuilt, breaking: required `space` + `path`; content committed via `commitFiles` honoring `push_policy` (owner/admin and direct-mode writers → `main`; proposal-mode non-owner writers → `proposals/<handle>`, surfacing in the existing PR review). Doc-format paths project as docs; other paths land as raw files (same posture as web-author upload). Response: `{slug, url, ref}`. `update_doc` path moves become **rename commits** (doc-identity's `-M` detection preserves the opaque id); owner reassignment stays projection metadata (access config, not content). `unpublish_doc` becomes a file-deleting commit (tombstone follows via indexer). `delete_doc` remains the stage-2 DB cleanup for tombstoned rows.
- **Retire:** CLI `desk sync`, `desk publish`, `desk unpublish` (delete the commands; keep read/share commands for now); the vestigial `audience` param on `publish_doc`'s wire schema and `DocListItem.audience`.
- **Tests:** e2e — MCP `publish_doc` → commit visible in a fresh clone + doc renders; proposal-mode routing; accept-revision → commit in clone + projection matches; materialization migration; rename-via-update_doc preserves slug; CAS conflict paths. Full suite + build + typecheck.

## Slice 3 — Tier 1 client editing: suggest-edit on the share surface (the one new feature)

**Schema:** `revisions.share_id uuid NULL REFERENCES shares(id)`; `revisions.proposer_label text NULL`. `shares.allow_edits boolean NOT NULL DEFAULT false` (sibling of `allowComments`).

**Public endpoints (share host, token-as-capability, mirroring the comments pattern):**
- `POST /api/s/[token]/suggest` and `/api/s/[token]/[slug]/suggest` `{content, note?}` → validates share (live, not revoked/expired, `allow_edits` on, doc is md; directory shares: slug must pass the prefix guard) → `createRevision` with `share_id`, `proposer_label = "link:<share label>"` (forced, never client-supplied), anchored to the resolved `baseVersionId`. Any failure mode → **uniform 404** (a disabled-edits share is indistinguishable from a dead token).
- Share page UI: a "Suggest an edit" affordance (md docs only) opening the current source in a plain editor + optional note; on submit, confirmation ("the owner will review"). Pinned shares suggest against the pinned version's content but anchor to it as base — the existing stale-base diff handles divergence.
- Abuse controls: dedicated limiter (5/hour per share id), `content-length` pre-check, `MAX_CONTENT_CHARS` cap.

**Owner review:** the existing revisions queue + diff UI lists share suggestions with a "via share `<label>`" badge; Accept flows through Slice 2's commit path; Reject as today. `list_open_revisions`/`decide_revision` (MCP) surface the queue to the owner's agent unchanged. The `allow_edits` toggle: `PATCH /api/shares/[id]` (REST-only, like `allowComments`).

**Tier 2 (repeat collaborators): nothing to build** — invites (E1) + `push_policy=proposal` (E2) already cover it; the runbook (Slice 5) documents when to upgrade a client from tier 1 to tier 2. Web-author W2 (guest browser authoring into `proposals/*`) remains the deferred richer form.

**Tests (boundary-class, exhaustive):** suggest on live share with edits on (doc + directory-child) succeeds and forces proposer identity; edits off / revoked / expired / deleted / html doc / bad slug-outside-prefix → uniform 404; comments and edits toggles are independent; rate limit + size cap; accepted suggestion produces a git commit and a rendered update; rejected changes nothing; a share visitor still cannot reach any staff surface.

## Slice 4 — Source modes + GitHub mirror-out (durability; kills finding 5)

**Schema:** `spaces.source_mode enum('hosted','mirrored') NOT NULL DEFAULT 'hosted'`; `spaces.mirror_remote_url text NULL`; `spaces.mirror_state jsonb NULL` (`{lastMirroredSha, lastAttemptAt, lastError}`); `spaces.mirror_deploy_key_enc text NULL` (per-space override, private key encrypted); instance settings row for the GitHub PAT (`valueEnc`, AES-GCM via `DESK_TOKEN_KEY`, single row v1, write-only — no reveal endpoint).

**Mirror-out (hosted spaces with a `mirror_remote_url`):** after every successful update of `main` — transport push (post-reindex), web-author commit, proposal accept, revision accept — enqueue a mirror push: `git push <remote> main:main`, credential injected per-invocation (askpass/env; **never written to disk or repo config**), deploy key preferred over PAT when present. In-process queue, exponential backoff, capped retries; failures **never block** the triggering write (same posture as reindex); `mirror_state` surfaces status + a "Mirror now" button in space settings. v1 mirrors `main` only (not `proposals/*`), exactly one mirror remote per space.

**`mirrored` spaces:** no mirror-out; **Desk-originated commits refused server-side** with a clear error (`webAuthorCommit`, revision accept, proposal accept) — Desk renders, shares, comments; content arrives only via git push (the documented GitHub Action: `on: push → git push desk main` with a Desk token secret). Suggest-edit (Slice 3) on a mirrored space: suggestions queue but cannot be accepted on Desk — the review UI says so and shows the diff for manual application upstream. Documented in a new `docs/remotes.md`: the one-push-target invariant, both mode recipes, the Action snippet, and "protect `main` on the GitHub mirror so nobody pushes to the read-only side."

**Settings surface:** space settings (owner/admin only, same gate as `push_policy`/visibility): mode, mirror URL, deploy-key generate/rotate (public key shown for GitHub Deploy Keys paste); instance settings (admin): PAT set/replace/clear.

**Tests:** mirror config gates (owner/admin only; member/anonymous → 404); mirror push fires on all four write paths (local bare "GitHub" remote as fixture) and retries/records failure without failing the write; PAT stored encrypted, never returned by any API; mirrored-mode write-refusal matrix (web-author, revision accept, proposal accept refused; git push still accepted); `source_mode` defaults hosted; migration green.

## Slice 5 — Agent loop enablement (docs + one optional param)

- **`docs/agent-runbook.md`** — the acme-growth proof case, end to end: provision (agent user, writer membership, principal token; CF Access service token for MCP), container loop (cron: `git pull` → read catalogs as files (`.desk.collection.yml` + frontmatter — **cloning is the catalog API**) → call Amplitude → write `reports/<date>-<topic>.md` → commit + push), `push_policy=proposal` on the space so reports arrive as PRs (or `direct` for auto-accept), directory share on `reports/` for the team, dispatch loop (poll `list_events` every 30–60 s with a persisted cursor, filter `card.assigned` to the agent's user, work the card, `move_card` when done), and the tier-1→tier-2 upgrade path for collaborators.
- **Optional (5b, build only if a minute feels slow in practice):** `wait_seconds` (0–55) long-poll param on `list_events` (REST + MCP) — request parks until an event lands or timeout; still outbound-only from the agent.
- **Tests:** 5b only (param bounds, immediate return when events pending, timeout return). The runbook is validated by actually running the proof case against staging — that live run is this spec's overall acceptance gate.

## Slice 6 — Cruft deletion (destructive migrations; owner call, land last)

- Drop `audiences`, `audience_members`, `docs.audience`; remove the two dormant `audience.member_*` event kinds; remove the CLI `--audience` flag.
- Remove the P3 registry catalog: `catalog_schemas`/`catalog_items`/`catalog_links` tables, `src/lib/catalogs.ts`, `src/lib/catalog-refs.ts`, the inert `catalogPatterns`/`rehypeCatalogRefs` plumbing in `Markdown`, and their orphaned tests. (When cross-referencing returns, it comes back as `[[wikilinks]]` over the projection, per `architecture.md` §13.2 — deferred.)
- Remove `desk sync` remnants and dead CLI code left by Slice 2.
- **Tests:** suite green after each removal; grep-clean for `audience` (except the unrelated `help/sections.ts` field name) and `catalog_` table references. Migrations hand-authored (drizzle-kit generate is broken — project convention).

---

## Explicitly deferred (documented so they stop haunting the backlog)

Packs (scoped agent inputs) · headless runner infrastructure in Desk · webhooks/push dispatch · catalog cross-references (`[[wikilinks]]`/backlinks) · web-author W2 (guest browser authoring) · GitHub App auth · multiple mirror remotes per space · non-md/html rendering in shares (PDF/images; raw-serve exists for owners) · board browser-e2e tests · `og:image` + `desk_id` frontmatter anchor + readable URLs (per doc-identity spec).

## Landing

Order: **0 → 1 → 2 → 3 → 4 → 5 → 6.** Rationale: hygiene unblocks everything and costs nothing; the boundary bug (1) precedes anything that increases share usage; convergence (2) must precede suggest-edit (3) because 3's accept path is 2's commit path; mirrors (4) come after convergence so every commit path that exists is mirrored; the runbook (5) is the acceptance gate; deletions (6) land last and alone.

Per slice: branch off `main`, atomic commits, full `npx vitest run` + `pnpm build` + `pnpm typecheck` green, then **commit + STOP for review** (slices 1–4 are auth-sensitive: read boundary, write boundary, data egress). Never force-push. Redeploy staging after each landed slice. Migrations hand-authored.

**Overall acceptance:** the proof case runs live on staging — a Docker agent clones acme-growth, reads catalogs from the clone, pushes a report that arrives as a proposal, the owner accepts it (commit → projection → GitHub mirror), the team reads it via a space-scoped directory share, a visitor suggests an edit that the owner accepts as a git commit, and a dispatched card is picked up by the agent within a minute.

## Outcomes

_(appended after each slice.)_

### Slice 2 — Git-truth write convergence (landed)

**What shipped.** Every production doc-content write now converges on a real git commit in the space's repo; the indexer projects it. `publishDoc` (the low-level service) is retained ONLY as the test-seeding seam (`src/test/db.ts`) — no production path calls it anymore.

- **`acceptRevision`** (`src/lib/revisions.ts`) — accepting a revision commits its content to the doc's `(space, sourcePath)` on `main` via `webAuthorCommit` (role forced to `owner` — an accept is an authoritative merge), then the synchronous reindex projects the new version. The direct `publishDoc` DB write is gone. CAS on the live `main` tip; on a `stale` result it re-reads the tip and retries once, else surfaces `stale` to the reviewer (409 / MCP error). The open→accepted transition + `revision.decided` event are preserved. New `AcceptResult` reasons: `stale`, `error`.
- **MCP `publish_doc`** (`src/lib/mcp/tools.ts`) — breaking rewrite: required `space` + `path` (repo-relative file path); commits via `webAuthorCommit` honoring `push_policy` (owner/admin → `main`; non-owner writer under `proposal` → `proposals/<handle>`). The opaque slug is minted by the projection; returns `{ slug, url, ref }` (slug/url null for a proposal). The vestigial `audience` param (and `slug`/`source_path`/`format`/`base_version_id`) were removed from the wire schema.
- **`POST /api/docs`** — same convergence: required `space` + `path`, routed through `webAuthorCommit`; membership-gated (was admin-only-create). Returns `{ slug, url, ref }`.
- **`POST /api/docs/[slug]/publish`** (owner direct-publish of an existing doc) — routed through `webAuthorCommit` (role `owner`), CAS-with-one-retry on `main`; `canPublishVersion` gate (admin OR doc owner) unchanged.
- **Shared plumbing** — `resolveWebAuthorAccess(principal, spaceSlug)` + `liveMainTip(spaceSlug)` added to `src/lib/web-author.ts` (the read/existence + space-role resolution that MCP + REST callers share, fail-closed).

**Tests.** New `src/lib/slice2-git-truth.test.ts` (13) proves: `publish_doc` → commit visible in a fresh `git clone` + doc renders; proposal-mode routing (writer → `proposals/*`, no main projection); accept-revision → commit in a clone + projection matches; accept reads the LIVE tip (survives a main move); CAS stale rejection; wire-schema requires `space`+`path` and dropped `audience`. New `src/test/git.ts` helper (git detection + throwaway `DESK_DATA_DIR` + repo cleanup + clone-read) isolates every committing suite. Bounded updates to the callers' existing suites (revisions, events, doc-ownership, mcp route, tools, tools-s1, docs route, s1-route, `[slug]/revisions`). Two pre-existing test-data `(space, path)` collisions (an `html-doc` sharing a source path with its `test-doc`/`team-doc` sibling in the same space) were fixed — the DB-keyed `publishDoc` masked them; the projection key `(space, sourcePath)` exposes them.

**Deferred (residual gaps, do-if-clean items 5/6/8 — see report).** `update_doc` path-move stays a DB folder-metadata update (not a git rename commit); `unpublish_doc` stays a DB tombstone (not a file-deleting commit); no boot-time materialization backfill. Rationale: a clean git-rename / delete-commit for a doc that was created by the LEGACY DB-only `publishDoc` (no blob at `main`) needs the materialization backfill first, and both are lifecycle/metadata ops — neither writes doc CONTENT to Postgres, so the finding-1/finding-2 invariant ("no production path writes doc content to Postgres except the indexer") holds without them. Pre-existing DB-only docs materialize lazily on their next accept/direct-publish; until then they render from the projection but are absent from a clone.
