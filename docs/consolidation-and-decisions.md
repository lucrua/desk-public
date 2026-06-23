# Desk — Gen‑1 → Gen‑2 consolidation plan (decision doc + build contract)

> **Status: ACTIVE — executing 2026-06-23 (autonomous, breaking changes authorized).** Desk accreted two generations: **Gen‑1** (flat Docs + Audiences + Upload + Board + Catalog + Distribution) and **Gen‑2** (Spaces = git repos + Tokens + push-to-publish + projection + per-space membership). Phase 1+2 grafted Gen‑2 *alongside* Gen‑1 without retiring it → the "what's the difference between Docs and Spaces?" incoherence. Lucas (the only user, pre-adoption) authorized breaking changes: *"run this consolidation plan, don't care about other users."*
> **Role:** the decisions + the Slice‑1 build contract. AUTH-SENSITIVE (it replaces the read-access model). Inherits the model in `design-document-host.md` (§3 access: write = space membership, read = doc/dir/tier in the projection).
> **Related:** desk repo `src/lib/docs.ts` (audience read path), `src/db/schema.ts` (audiences/audience_members + docs.audience), `src/app/(hub)/{docs,spaces,admin/Audiences,distribution,board,catalog}`, `src/app/api/audiences/*`.

## The target model (one sentence)
**A doc is a file inside a Space; you see it because you're a member of that space (or its visibility is public/unlisted) or someone shared a capability link — there is no second per-doc access tag.** Spaces are the home; Docs are content within them.

## Decisions (model-aligned; I'm making these, you can override)
- **D1 — Spaces is the home.** Hub root → Spaces. **Remove "Docs" as a top-level nav peer.** Docs are browsed inside a space (`/spaces/[slug]` lists its docs; the `/docs/[slug]` viewer stays, reached from a space; deep links keep working).
- **D2 — Access = space-scoped; RETIRE Audiences.** A doc's read access = **member of its space, OR the space's visibility (public/unlisted), OR a capability share.** Remove audience-based scoping from every read path (`listDocs`, `searchDocs`, `getDocBySlug`, events feed). Remove the **Audiences** admin UI + `/api/audiences/*`. `docs.audience` becomes **vestigial** → make nullable / stop requiring it; **leave the `audiences`/`audience_members` tables + column dormant this slice (no destructive migration), drop in a later cleanup.** No data migration needed — every doc already has `spaceId`.
- **D3 — Deprecate Upload.** Remove the drag-drop `UploadDoc` UI + its hub publish entry. Publishing = `git push` to a space. Keep the `publishDoc` *service* (the indexer uses it). Web creation of a brand-new doc → deferred to web-commit (a Phase‑2 item); editing an existing doc stays the revision/propose flow (now space-scoped).
- **D4 — Distribution** depends on audiences → **rework to report over spaces + shares** ("who can see what," space-based). If a part is too audience-entangled to rework cleanly, drop that part and note it.
- **D5 — Board (cards/buckets): KEEP as-is** (native coordination). Future option: reframe as a render of `_attention.md`, or remove if unused — **your call, NOT done now.**
- **D6 — Catalog (Desk-authored): KEEP as-is.** Future: reframe as a projection of repo frontmatter (the deferred Phase‑2 item) — **your call, NOT done now.**
- **D7 — Keep** Comments / Revisions / Approvals / Shares / Tokens / Admin / Help — all valid in Gen‑2; they become space-scoped where they reference docs.

## Why retire audiences (not keep them as a read-tier)
Audiences (`pedro|dani|team|external` per-doc tags + named groups) are exactly what space membership + visibility + shares now express, more cleanly: organize docs into spaces, set the space's members/visibility, use a capability link for one-off external read. Keeping both = the double access model that caused the confusion. One user, pre-adoption → cleanest to collapse now.

## Slices
- **Slice 1 (running): D1 + D2 + D3 + D4.** The core access + nav collapse. ~53 files touch `audience`; the *security-critical* change is the `docs.ts` read path moving from audience-keys → space-scope. Exhaustive access-boundary tests required; orchestrator independently verifies the boundary before deploy.
- **Slice 1.5 (next, after Slice 1 lands — added 2026-06-23 at Lucas's request): D8 + D9.** Sequenced *after* Slice 1 so it audits the consolidated surface, and to avoid colliding with Slice 1's edits to `tools.ts` + `/help`.
- **Slice 2 (deferred, your review): D5 board reframe, D6 catalog-as-projection**, then the destructive cleanup (drop dormant audience tables/column).

### D8 — Audit + simplify (or remove) the MCP/API interface
Post-Slice‑1, the surface is ~66 MCP tools + the matching REST routes. Audit and cut:
- **Inventory** every MCP tool + REST route; classify **keep / merge / remove / rename**.
- **Remove** tools for retired Gen‑1 surfaces (audiences already gone; any upload/audience leftovers) and dead/never-used endpoints.
- **Merge** over-granular tools (e.g. many tiny per-field mutations → one update tool) and collapse near-duplicates.
- **Relax the "both-channels parity" rule** where it adds noise: REST exists for the UI; MCP exists for *agents/automation*. Not every capability needs both — keep MCP focused on what a headless agent actually drives (publish/spaces/tokens/revisions/read), drop MCP for pure-UI-admin actions if they're not automation-relevant. Document the new rule.
- Goal: a small, coherent, agent-facing MCP + a REST surface the UI needs — not a 1:1 sprawl. Land a tool-count + before/after table.

### D9 — Documentation review (README + internal docs + docs/help menu)
Bring the docs to the consolidated Gen‑2 model:
- **`README.md`** (desk repo): rewrite to describe what Desk *is now* — a self-hosted git-host for document **spaces** with tiered sharing, tokens, projection, feedback; the push-to-publish flow; setup/env. Kill Gen‑1 framing (audiences/upload).
- **`/help`** (the in-app docs menu): ensure it matches the new model end-to-end (spaces, tokens, push `HEAD:main`, shares, revisions/approvals; no audiences/upload). Remove stale sections.
- **Internal docs** in the repo (`docs/`, design notes, any `*.md`): flag/refresh what's stale vs the consolidated model; remove dead references. (Cross-check against `design-document-host.md` as the source of truth.)
- Land a short "what changed in the docs" summary.

## Slice‑1 build contract
**Access (the core, get it right, fail-closed):**
- New scope helper: a doc is visible to a principal iff `principal` is an **admin**, OR a **member of the doc's space**, OR the **space.visibility ∈ {public, unlisted}**, OR the request carries a valid **capability share** for it. Replace `audienceKeysFor`/audience filters in `listDocs`/`searchDocs`/`getDocBySlug`/events with this space-scope.
- Anonymous/non-member on a `private` space → not visible (uniform 404 on direct fetch, excluded from lists). No existence leak.
- Keep the existing **git-transport** authz (`resolveSpaceRole`) untouched — it already enforces write boundary; this slice only changes the *projection read* path.

**Nav/UI:**
- `HubNav`: drop **Docs**; Spaces is first. (Keep Board/Catalog/Approvals/Tokens/Help/Admin/Distribution.)
- `/spaces/[slug]`: ensure it lists the space's docs (link to `/docs/[slug]` viewer). Add a clear empty state + the existing push-help.
- Remove the `UploadDoc` drag-drop UI + its entry. Remove the old flat `/docs` list page (or redirect `/docs` → `/spaces`). Keep `/docs/[slug]` viewer/editor.
- Remove the **Audiences** admin section + `/api/audiences/*` routes + MCP audience tools (update tool count + `/help`).
- Rework **Distribution** to report space membership + shares.

**Tests (REQUIRED — this is the access boundary):**
- The new space-scope matrix: admin sees all; member sees their spaces' docs; non-member does NOT see a private space's docs (list + direct 404); public/unlisted space docs visible; capability share still grants read; search + events respect space-scope.
- No remaining test asserts audience-based visibility (update/remove them).
- Full `npx vitest run` + `pnpm build` + `pnpm typecheck` green.

**Landing:** branch `feat/phase3-consolidation` off `feat/phase2-spaces-ui`; atomic commits; **no push/deploy** (orchestrator handles). Never touch `main`.

## Outcomes

### Slice 1 (D1–D4) — DONE 2026-06-23 (branch `feat/phase3-consolidation`, 8 commits)
- **New visibility predicate (D2):** a doc is visible iff **admin** OR **member of its space** OR **space.visibility ∈ {public, unlisted}** OR a **capability share** carries it. `memberVisibleSpaceIds` + `canSeeDocSpace` replace the audience resolver in `listDocs`/`searchDocs`/`getDocBySlug`/events; non-member on a private space → uniform 404 (no existence leak); `userId==null` → public/unlisted only (fail-closed). **git-transport authz untouched.**
- **Removed:** Audiences (lib, `/api/audiences/*`, 7 MCP tools → 69→62, admin UI, badges, per-doc visibility control); Upload (`UploadDoc`, `upload-model`, `DocsTree`); flat `/docs` list (→ redirects to `/spaces`); Docs dropped as a nav peer (Spaces first).
- **Migration `0016`:** `docs.audience` → nullable (non-destructive); `audiences`/`audience_members` left **dormant** (drop in a later cleanup).
- **Distribution** reworked to `bySpace` + `byUser` (membership/visibility/shares, not audiences).
- **Verified:** agent suite 1339 green; **I independently re-ran the boundary subset → 96 green** (docs space-scope matrix, events, spaces, git auth, clone/push e2e); build + typecheck clean. Slice 1 **deployed to staging** (branch repointed; deploy in progress at time of writing).
- **Flagged (not changed):** public/unlisted spaces aren't in a non-admin's `/spaces` *listing* (Phase-2 discovery choice; the *read* boundary is correct — members can open public-space docs); two dormant `audience.member_*` event kinds remain.

### Slice 1.5 (D8 MCP/API audit + D9 docs) — DONE 2026-06-23 (branch `feat/phase3-interface-docs`, 4 commits)
- **D8 — MCP 62 → 47.** New policy (in `tools.ts` + README + `/help`): **MCP = agent surface, REST = UI surface (not 1:1).** Removed from MCP (kept REST-only, UI renders them): user/multi-email admin (6), access-request triage (3), bucket lifecycle (3), `set_share_comments`, `list_share_views`. **Merged** `set_doc_path`+`set_doc_owner` → `update_doc`. **No REST routes removed** (Explore audit confirmed each `/api/*` is UI-rendered or transport). `distribution_overview` key `byAudience → bySpace`.
- **D9 — docs.** `README.md` full rewrite to the Gen-2 model (spaces, push `HEAD:main`, space-scoped access, tokens, shares, projection; killed audiences/upload; added what's-built-vs-not + env + MCP/REST policy + 47-tool table). `/help` MCP section updated. Internal refresh: `docs/account-merge-runbook.md`, `docs/cutover-checklist.md` (Gen-2 env, `/api/git/*` CF bypass, bare-repo backups). Flagged-not-rewritten: P1 plan snapshot, `cli/README.md` (`--audience` vestigial), design-handoff readmes.
- **Verified:** agent suite 1314 green; **I independently re-ran MCP suite → 99 green, tool count = 47**; build + typecheck clean. **Combined build (Slice 1 + 1.5) deployed to staging.**
- **Left for review:** `help/sections.ts` uses `audience` as a *visibility-class* field name (coincidence, not the feature) — left as-is; pre-existing lint nit `help/page.tsx:908` (`<a>`→`<Link>`); CLI `--audience` flag still in the CLI artifact (flagged in its README only).

## Slice 2 — Catalog-as-projection + hierarchical file view (decided 2026-06-23; building)
Decisions: **keep** Board + Catalog (D5/D6 → keep, reframe Catalog). Catalog definition = **auto + optional repo schema** (renders a space directory's frontmatter with zero config; optional `.desk.collection.yml` adds schema/views/validation). Pack primitive **final name = "Pack"**. Web-editing a catalog = the **web-commit path** (edit → commit to the file → re-project; never a Desk-only store) — **does NOT break git**; web-commit is a *later* slice, so Slice 2 is read/render only.

**Build contract (Slice 2):**
- **Hierarchical file view:** `/spaces/[slug]` renders docs as a collapsible **folder tree by `path`** (depth ≤6), leaves → `/docs/[slug]`. Replace the flat list.
- **Catalog-as-projection (D6):** a catalog = docs in a space under a chosen directory, rendering each doc's `parsedFrontmatter` (already populated by the indexer). **Auto mode:** no schema → table of all frontmatter fields, UI group/filter by any field. **Schema mode:** read `.desk.collection.yml` from that dir (in the space's git) for declared fields/enums/views (board `group_by`, table columns, filters) + validate docs (flag drift). Replace the Gen-1 Desk-authored catalog UI; keep `catalog_*` tables dormant or repurpose (don't break the build). View prefs = Desk-side display state (no file writes).
- Tests + build + typecheck green; branch off `feat/phase3-interface-docs`; commit, STOP, no deploy.

**Next slices (queued):** **web-commit** (makes the catalog + docs web-editable via commit-on-save, §13.3) → **Packs** (read-packs first = directory-shares++; write-packs/reverse-merge later).

## What remains (your calls)
- **D5 Board** (cards) — keep / reframe as `_attention.md` render / remove.
- **D6 Catalog** — reframe as projection of repo frontmatter, or keep Desk-authored.
- **Destructive cleanup** — drop the dormant `audiences`/`audience_members` tables + `docs.audience` column once you've confirmed the new model.
- **Discovery** — make public/unlisted spaces appear in a non-admin's `/spaces` listing (read boundary already correct).
- **Merge to `main`** — the whole Phase-2 + consolidation stack lives on branches; promoting to `main` (prod `desk`) is your call.
