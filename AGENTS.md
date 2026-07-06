# Desk — agent orientation

> **Read this first.** Desk is a **self-hosted git host for document _spaces_** with a render + access + feedback layer on top.
> **Deep docs (in this repo):** `README.md` (what Desk is + features) · `docs/architecture.md` (the foundational model + *why*) · `docs/consolidation-and-decisions.md` (every product decision, the current feature inventory, what's deferred, and the staging/branch status).

## The model in one screen
- **Space** = a git repo Desk hosts. It is the unit of write/clone access **and** the security boundary. You **publish by pushing** (`git push <space> HEAD:main`); Desk re-projects within seconds. Desk **renders** `main`.
- **Doc** = a file inside a space. **Truth = the file.** Desk's Postgres is a **derived projection** (render cache, parsed frontmatter, link graph) — rebuildable from the repos, **never a second source of truth**.
- **Read access — the boundary; never weaken it.** A principal sees a doc iff: **admin**, OR **member of its space**, OR **`space.visibility ∈ {public, unlisted}`**, OR a valid **capability share** carries it. Implemented as space-scope in `src/lib/docs.ts`. There is **no per-doc `audience` tag** — that Gen‑1 access model was retired in the consolidation and its tables + the `docs.audience` column were fully removed in the convergence fix-pass (Slice 6).
- **Write access.** `git push` authenticated by a **principal token** (minted at `/settings/tokens`) → `src/lib/git/auth.ts` (`resolveSpaceRole`) → the user's space role. This is the write boundary — **do not weaken it**, and cover any change with the boundary tests.
- **Share** = a read-only capability link to a doc or directory. **Catalog** = a projection of a space directory's frontmatter as a table/board/list (optional `.desk.collection.yml` schema + validation). **Board** = native kanban cards (coordination, authored in Desk). **Tokens** = git credentials.
- **MCP = the agent surface; REST = the UI surface** — deliberately *not* 1:1. MCP keeps what a headless agent actually drives; pure web-UI admin stays REST-only. (Tool registry: `src/lib/mcp/tools.ts`.)

## Dev
- Next.js 16 (App Router) · TypeScript · Drizzle ORM · Postgres. ⚠ **This Next has breaking changes — read `node_modules/next/dist/docs/` before writing Next code** (see the block at the bottom).
- Dev DB: `bash scripts/dev-db.sh` (embedded Postgres on **:5433**). Tests: **`npx vitest run`** (serial — `fileParallelism:false`). Build: `pnpm build`. Types: `pnpm typecheck`.
- Auth modes: `AUTH_MODE=dev` (role-switcher, no Cloudflare) for local; `AUTH_MODE=cloudflare` (CF Access JWT) for staging/prod. The dev role-switcher is gated to dev mode and is **inert** in cloudflare mode (auth reads only the CF JWT — `src/lib/auth/index.ts`).

## Deploy / environments
- **Example deployment:** `desk.example.com` (hub) + `share.example.com` (share host), on Coolify. **Cloudflare Access protects the hub and _bypasses_ `/api/git/*`** so git token-auth reaches Desk's own gate. The build needs **`git` in the runtime image** (nixpacks `aptPkgs=["git"]`) + a build heap cap (`NODE_OPTIONS=--max-old-space-size`); the box has swap. `DESK_DATA_DIR` holds the bare repos (back it up — it's the canon).
- **Prod:** none. This repository makes no production claim; deploy it wherever you like.
- **Branches:** Phase‑2 + the consolidation live on a feature-branch stack ending at the current branch; `main` is pre-consolidation. **Branch/merge status is in `docs/consolidation-and-decisions.md`** — check it before assuming `main` reflects current behavior.

## Conventions
- **Landing posture for risky / auth-sensitive changes:** branch, commit, run the full suite + `pnpm build` + `pnpm typecheck`, then **STOP for review** before pushing a deploy branch. Never `git push --force`, `git reset --hard`, or `--no-verify`.
- **The access boundary is sacred:** any change to who-sees-what needs exhaustive tests (admin / member / non-member / public / share / anonymous) and fail-closed defaults (no existence leak — non-member on a private space gets a uniform 404).
- **Shipped (built):** **web authoring** (browser new-doc / edit / upload → a real git commit, CAS-on-ref; the feature formerly listed here as "web-commit") and **external collaboration** (invite links → self-serve onboarding; per-space `push_policy` `direct`/`proposal`; proposals-as-PRs).
- **Deferred / queued (NOT built):** **packs** (re-organized shareable subset of a space; read-packs first) and the **headless-agent runner** (`card.assigned` → runner; the event/proposal primitives exist, the runner does not). The active build spec is `docs/specs/convergence-fix-pass.md`. Details in the decisions doc.

<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->
