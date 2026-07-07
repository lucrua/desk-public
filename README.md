# Desk

Desk is a **self-hosted git host for document _spaces_** with a render + access + feedback layer on top. Documents live as files in git repos Desk hosts; Desk renders them, scopes who can see which, and holds the feedback (comments, proposed revisions, share links). You publish by pushing — `git push … HEAD:main` — and Desk re-renders within seconds. Source files are never exposed directly; unpublishing a doc kills its page and every share link instantly.

## The one principle — one source, many doors

**Desk is a render + access + feedback layer over a source. It is never a second place the content lives.**

- **Truth = files, in git repos Desk hosts.** A **space** is one such repo — the unit of write/clone access and the security boundary.
- **Desk's Postgres = a derived _projection_** of those files: the render cache, the catalog/board indexes, resolved cross-links — **plus** Desk's own native data that has no file (comments, approvals, shares, view-tracking, access requests).
- **The projection is rebuildable from the repos.** Lose it and you lose feedback + access config + cache — never a document.

The filesystem, the web UI, and the API/MCP are all windows onto that one copy. There is exactly **one** of every document.

## Architecture

Desk runs as a single Next.js 16 app behind two hostnames, with authentication handled by Cloudflare Access (optional in dev, required in production):

- **`desk.<domain>`** — CF Access-protected. The full app: docs reader, spaces, board, catalog, admin dashboard, the REST API, the MCP endpoint, and the **git transport** (`/api/git/<owner>/<space>.git`). Only staff (users with active rows in the DB) reach this host.
- **`share.<domain>`** — No CF Access. Only `/s/*` capability-link pages are reachable; the middleware hard-blocks everything else with a real HTTP 404. The capability token in the URL is the credential — no accounts, no guest sign-ups for external recipients.

Capability tokens and principal (git) tokens are ≥128-bit random values stored hashed. Revoking a share token (or unpublishing the underlying doc) makes every share URL that references it return 404 immediately.

## Access model

Write and read have **different natural granularities**:

| | Unit | Granularity |
|---|---|---|
| **WRITE** (change the truth) | a **space** (a git repo, with owner + members) | coarse — by space membership |
| **READ / SHARE** (view a rendered doc/folder) | a capability **share** over a subset | fine — per doc, per directory |

**A doc is a file inside a space; you see it because you are a member of that space, or the space's visibility is public/unlisted, or someone shared a capability link.** There is no second per-doc access tag — read access is **space-scoped**, fail-closed (anonymous or non-member on a `private` space → uniform 404, no existence leak).

- **The git transport** (`/api/git/...`) enforces the write boundary: a **reader** token may clone/fetch, a **writer**/**owner** token may push. A push to `main` fires a re-projection (re-index the changed paths).
- **Operator surfaces** (`desk.<domain>`) authenticate via Cloudflare Access. The CF Access JWT carries an email or service-token name; the app resolves it against the `users` table.
- **First-login-admin + multi-admin model.** The first CF-verified email to sign in on a fresh deployment is automatically seeded as admin (no env var or manual seed). From there, admins promote/demote others from the Users page; at least one active admin must always remain (the last-admin guard). Service-token (agent) rows can be promoted to admin.
- **Capability links** (`share.<domain>/s/<token>`) need no login. The raw token is the credential, shown exactly once on creation. Anyone with the URL reads the doc until the link is revoked or the doc is unpublished.

## What's built vs. not

| Capability | State |
|---|---|
| Spaces (hosted git repos) + per-space membership/roles, space-scoped read | 🟢 built |
| Git transport (smart-HTTP, token→ACL, post-receive re-index) + push-to-publish | 🟢 built |
| Principal tokens (the git Basic-auth credential, self-serve) | 🟢 built |
| Projection: render cache, catalog/board indexes, doc rows as an index of repo files | 🟢 built |
| Capability + directory shares, view-tracking, comments, proposed revisions / approvals | 🟢 built |
| Anonymous "suggest an edit" on a share (opt-in per share via `allow_edits`; queues as a revision the owner accepts → git commit, or rejects) | 🟢 built |
| Board (kanban) | 🟢 built — native coordination |
| Catalog (projection of a space directory's frontmatter; optional `.desk.collection.yml` schema + views + drift validation) | 🟢 built — read/render-only (edit an item by editing its doc's frontmatter through web authoring) |
| Hierarchical file view (full git-tree file browser on a space, incl. non-doc files) | 🟢 built |
| External collaboration: invite links → self-serve onboarding, per-space `push_policy` (`direct`/`proposal`), proposals-as-PRs (diff + accept/reject) | 🟢 built |
| Doc identity: stable opaque id per file, projection keyed on `(space, path)`, git `-M` rename tracking, link previews | 🟢 built |
| **Web authoring** (browser new-doc / edit / upload → a real commit, CAS-on-ref) | 🟢 built — owner/writer commits direct (or opens a proposal under `push_policy=proposal`); guest (share-visitor) browser authoring (W2) not yet built |
| **Source modes + GitHub mirroring** (per-space `hosted`/`mirrored`, one-way mirror-out to a paired GitHub repo, `mirrored`-space write refusal) | 🟢 built — see [`docs/remotes.md`](docs/remotes.md); deploy-key *generation* deferred (paste an existing private key instead) |
| **Headless-agent loop** (`card.assigned` → runner → propose → review → publish) | 🔴 not built — the event + revision primitives exist; the runner does not |
| **Packs** (manifest-defined view-repos for scoped agent inputs) | 🔴 not built |

---

## Dev quickstart

Prerequisites: Node.js >= 20, pnpm >= 10, Docker (for the local Postgres container).

```bash
# 1. Start Postgres 16 in Docker
docker compose -f docker-compose.dev.yml up -d

# 2. Copy env
cp .env.example .env.local
# .env.local has working defaults for local dev (AUTH_MODE=dev,
# DATABASE_URL pointing at the Docker container).

# 3. Install dependencies
pnpm install

# 4. Apply migrations
pnpm drizzle-kit migrate

# 5. Start dev server
pnpm dev
# → http://localhost:3000
```

**Auth in dev.** `AUTH_MODE=dev` bypasses CF Access and activates a role switcher in the bottom-right corner of the app. Switch between `admin`, `member`, and `anonymous` to test all surfaces. The switcher is hidden in `AUTH_MODE=cloudflare` (production). The first CF-verified email sign-in on a fresh deployment automatically becomes admin (first-login bootstrap) — no manual DB seed.

---

## Publishing — push to a space

Publishing is `git push`. Get a **principal token** (the git credential), then push to the space's `main` branch:

```bash
# Mint a principal token in the UI: /settings/tokens (shown ONCE) — or POST /api/tokens.

# clone (reader, writer, or owner)
git clone https://git:<token>@<host>/api/git/<owner>/<space>.git

# push from an existing repo (writer or owner)
git remote add desk https://git:<token>@<host>/api/git/<owner>/<space>.git
git push desk HEAD:main
```

**Desk renders the `main` branch.** It indexes only that ref, so always push with `HEAD:main` explicitly — a bare `git push desk HEAD` from a local `master` branch is accepted but renders nothing (the `main` ref never moves). A push re-renders the affected docs within seconds (the projection re-indexes the changed paths). A reader token can clone but a push is rejected; a writer/owner token can push.

> Creating a new doc, editing a doc, or uploading a file **in the browser** lands as a real git commit for an owner/writer (a non-owner writer under `push_policy=proposal` opens a proposal for review instead). Guest (share-visitor) browser authoring (W2) is not yet built.

**Every content write converges on a git commit** (truth = git; Postgres is a rebuildable projection). The **agent** (`publish_doc`) and **REST** (`POST /api/docs`) publish paths both take a required **`space`** + **`path`** and commit the file to the space's repo — the doc's stable opaque slug is minted by the projection, so you address by `(space, path)`, never by a chosen slug. They honor `push_policy` exactly like a `git push`: owner/admin (and writers under `direct`) land on `main`; a non-owner writer under `proposal` opens a `proposals/<handle>` ref for review. **Accepting a proposed revision** (`decide_revision` / the review UI) likewise commits the revision's content to `main` and lets the indexer project it — the DB is never written directly. After this convergence, **no production path writes doc content to Postgres except the indexer projecting git.**

### Source modes & GitHub mirroring

Every space has a `source_mode`: **`hosted`** (default — Desk is canon, and mirrors `main` out to a paired GitHub repo you configure) or **`mirrored`** (GitHub is canon; a GitHub Action forwards pushes in, and Desk refuses its own content writes). Configure mode, the mirror remote, "Mirror now", and an optional per-space deploy key on a space's settings page (owner/admin); the instance-wide GitHub PAT credential is set once on `/admin` (write-only — never revealed back). Full recipes (including the GitHub Action YAML for `mirrored` spaces) are in **[`docs/remotes.md`](docs/remotes.md)**.

---

## Tests and typecheck

```bash
pnpm vitest run          # run the full test suite
pnpm vitest              # watch mode
pnpm typecheck           # tsc --noEmit
```

---

## CLI

The `desk` CLI manages share links and checks drift between local files and published versions. **Publishing is `git push`** (truth = git) — the CLI's write commands were retired in the Convergence fix-pass. See [`cli/README.md`](cli/README.md) for the full command list.

```bash
# Install without cloning, then configure once (saved to ~/.config/desk/config.json):
curl -fsSL https://raw.githubusercontent.com/lucrua/desk-public/main/cli/install.sh | sh
desk config                        # set your Desk URL + auth (dev role or CF service token)

# Quick examples
desk share overview --label "Partner review" --expires 7
desk revoke "Partner review"
desk list
desk status
```

---

## Connecting an agent (MCP)

Desk exposes a **Model Context Protocol** server at **`/mcp`** so external agents (Claude Code, etc.) can call Desk tools directly. It speaks the MCP **Streamable HTTP** transport in stateless mode (each request is self-contained — no session to keep alive), and reuses the exact same authentication and authorization as the web app: the Cloudflare Access wall authenticates the request, `getPrincipal` resolves it to a principal, and each tool enforces space-scoped reads + admin/owner mutation rules.

> **Building an autonomous agent?** [`docs/agent-runbook.md`](docs/agent-runbook.md) is the end-to-end recipe: a Docker bot that provisions its two credentials (a git principal token **and** an MCP identity), clones a space to read catalogs as files, publishes reports through the `push_policy` review gate, distributes them via a directory share, and picks up assigned cards by polling `list_events` (optionally with the `wait_seconds` long-poll for near-real-time dispatch).

**MCP is the agent surface; REST is the UI surface — deliberately not 1:1.** MCP exposes what a headless agent actually drives. Pure web-UI admin actions (user & multi-email management, access-request triage, board-bucket lifecycle, a share's view-log / comment- and edits-toggle) are **REST-only and have no MCP tool**; an agent that needs the "who can see what" audit uses `distribution_overview` + `list_shares`.

**Anonymous "suggest an edit" on a share.** A share whose owner flips on `allow_edits` (`PATCH /api/shares/[id]`, REST-only, admin — the sibling of the comments toggle, and independent of it) grows a "Suggest an edit" affordance on markdown docs. A link visitor (no account — the capability token is the credential) submits a full proposed body; it queues as a **revision** carrying a forced `link:<share label>` identity (never client-supplied), which the owner reviews in the existing diff UI and **accepts** (→ a real git commit on `main`, authored by the proposer) or **rejects** (nothing changes). Fail-closed: while `allow_edits` is off — or the token is revoked/expired, or the doc is HTML — the suggest endpoint returns a uniform 404, indistinguishable from a dead link. Rate-limited per share (5/hour).

- **URL:** `https://desk.<domain>/mcp` (also reachable at `/api/mcp`; `/mcp` is the canonical public path).
- **Auth:** the same CF Access service-token headers the CLI uses (`CF-Access-Client-Id` / `CF-Access-Client-Secret`). An unauthenticated request gets a JSON-RPC `401`. On `share.<domain>` the endpoint is unreachable (the host middleware 404s everything outside `/s/*`).
- **Access:** **members** get read-only, space-scoped access (the same docs they'd see in the reader); **admins** (and a doc's **owner**, for its own doc) get the mutation surface. Calling an admin tool as a member returns a tool error result, not a crash. The REST API and `desk` CLI remain fully available alongside MCP.

### Add it to Claude Code

```bash
claude mcp add --transport http desk https://desk.<domain>/mcp \
  --header "CF-Access-Client-Id: <service-token-id>" \
  --header "CF-Access-Client-Secret: <service-token-secret>"
```

In local dev (`AUTH_MODE=dev`, no CF wall) point at the dev server and send the role header instead:

```bash
claude mcp add --transport http desk-local http://localhost:3000/mcp \
  --header "x-dev-role: admin"
```

### Tools (43)

| Tool | Role | Description |
|---|---|---|
| `list_docs` | staff | List docs visible to the caller (members: docs in spaces they can see). Optional `q` full-text search, `path_prefix` folder filter. |
| `search_docs` | staff | Full-text search over title + content, ranked, with snippets. Space-scoped. |
| `get_doc` | staff | One doc by `slug`: metadata, current content, version list. Viewer-scoped. |
| `get_version` | staff | Raw content of a specific `version_id` of a doc (`slug`). Viewer-scoped; cross-doc ids rejected. |
| `publish_doc` | space member | Publish a file into a **space** by committing it to git. Requires `space` + `path` (repo-relative file path) + `content` (optional `title`, `message`). Honors `push_policy` (owner/admin → `main`; non-owner writer under `proposal` → a `proposals/*` ref). The opaque slug is minted by the projection. Returns `{ slug, url, ref }` (slug/url null for a proposal). Content capped at 2 MB. |
| `update_doc` | admin | Move a doc to a folder (`path`) and/or reassign its owner (`owner_user_id`) — projection metadata, no new version. |
| `unpublish_doc` | admin | Unpublish a doc by `slug` — kills the hub page and every share instantly. |
| `delete_doc` | admin | Stage-2 destructive delete: purges content, deletes its share links, frees the slug. |
| `list_events` | staff | The append-only event log (cursor on `since`, optional `kinds`). Space-scoped for members. Optional `wait_seconds` (0–55, default 0) long-polls — parks server-side until an event arrives or the timeout elapses, then returns (possibly empty). Near-real-time agent dispatch (e.g. `kinds:["card.assigned"]`) without tight polling. |
| `create_share` | admin | Mint a capability link for a doc (`doc_slug`, `label`, optional `expires_in_days` / `pinned_version_id`). Returns the one-time URL. |
| `create_directory_share` | admin | Mint a capability link for a whole folder in a space. **Space-scoped:** requires `space` (the space slug) + `path_prefix`; exposes every published doc under the prefix **in that space only** (a same-named folder in another space never leaks). One revoke kills the lot. |
| `list_shares` | admin | All shares (doc + directory) with view stats. Each row carries `mode` + `docSlug`/`pathPrefix`. |
| `list_doc_shares` | admin | Shares for one doc (`slug`), newest-first, with view stats. |
| `revoke_share` | admin | Revoke a share by numeric `id`. |
| `reveal_share` | admin | Reconstruct an existing share's URL by `id` (requires `DESK_TOKEN_KEY`). |
| `delete_share` | admin | Stage-2 delete a share link by `id` (after revoke). |
| `distribution_overview` | admin | The "who can see what" audit in three lenses: `bySpace`, `byUser`, `links`. |
| `list_comments` | staff | Comments on a doc you can see (slug → thread, space-scoped). |
| `add_comment` | staff | Add a comment to a doc you can see (author = your principal). |
| `resolve_comment` | admin | Mark a comment resolved by `id`. |
| `delete_comment` | admin | Hard-delete a comment by `id`. |
| `propose_revision` | staff | Propose an edit to a markdown doc you can see (`slug`, full `content`, optional `note`) — queues an open revision. |
| `list_revisions` | staff | Proposed revisions on a doc (`slug`), newest-first, optional `status` filter. |
| `decide_revision` | admin / owner | Accept (`accept: true` → publishes a new version) or reject a revision by `id`. |
| `list_open_revisions` | staff | The central approval queue — admin sees all open revisions, an owner sees those on docs they own. |
| `list_buckets` | staff | The board's buckets (columns) in order, with live card counts. |
| `list_cards` | staff | Board cards (filters: `bucket_id`, `owner_user_id`, `owner: "me"`, `include_archived`). |
| `get_card` | staff | One card by `id` plus its activity trail (card.* events, oldest-first). |
| `create_card` | staff | Create a card (`title`, `bucket_id`/`bucket_key`, optional `body`/`doc_slug`/`checklist`/`owner_user_id`). |
| `update_card` | staff (owner/admin) | Edit a card's `title`/`body`/`doc_slug`/`checklist`. |
| `move_card` | staff (owner/admin) | Move a card to a `bucket_id` at a slot (`index`). |
| `assign_card` | admin | Assign (or clear) a card's owner — admin-only reassignment. |
| `archive_card` | staff (owner/admin) | Archive (`archived: true`) or restore a card. |
| `list_spaces` | staff | Spaces visible to the caller (admins: all; members: theirs + public/unlisted). |
| `create_space` | admin | Create a space (`slug`, optional `visibility` / `owner_user_id`). |
| `set_space_member` | admin / owner | Set (`writer`/`reader`) or remove (`null`) a user's role on a space. |
| `create_invite` | admin / owner | Mint an invite capability link for a space (`slug`, `role`, optional `email` / `expires_in_days` / `max_uses`). Returns the one-time invite URL for self-serve onboarding. |
| `list_proposals` | staff | List open `proposals/*` refs on a space (name, pusher, tip, created) — the PR queue under `push_policy=proposal`. |
| `decide_proposal` | admin / owner | Accept (merge → `main` + reindex + drop ref) or reject (drop ref) a proposal by space + name. |
| `create_token` | staff | Mint a principal (git) token for the caller. Returns the raw token ONCE. |
| `list_tokens` | staff | List the caller's tokens (admin: `all=true` lists everyone's). |
| `revoke_token` | staff | Revoke a token by `id` (own token, or any for an admin). |
| `whoami` | staff | The resolved principal (kind, name, masked email/token) — "is my token wired right?" |

> **REST-only admin actions** (no MCP tool): user CRUD + multi-email (`/api/users/**`), access-request triage (`/api/access-requests/**`), board-bucket lifecycle (`/api/buckets/**`), and a share's view-log / comment- and edits-toggle (`GET /api/shares/[id]/views`, `PATCH /api/shares/[id]` — `{ allowComments?, allowEdits? }`).
>
> **No catalog tools.** The catalog was reframed (D6) from a Desk-authored registry into a **read-only projection of a space directory's doc frontmatter** (+ an optional `.desk.collection.yml` schema). Its truth is the repo, so an agent "writes" a catalog by committing frontmatter — there is no catalog MCP/REST authoring surface. The dormant P3 registry (`catalog_schemas` / `catalog_items` / `catalog_links` tables + the inert auto-linker) was **removed** in the convergence fix-pass (Slice 6).

### Verify with curl

A working stateless exchange against a dev server (`AUTH_MODE=dev`) — `initialize`, then `tools/list`, then a `whoami` `tools/call`. The `Accept` header must list both `application/json` and `text/event-stream` per the Streamable HTTP spec:

```bash
# initialize
curl -s -X POST http://localhost:3000/mcp \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -H "x-dev-role: admin" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
# → {"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{"listChanged":true}},"serverInfo":{"name":"desk","version":"0.1.0"}},"jsonrpc":"2.0","id":1}

# list tools
curl -s -X POST http://localhost:3000/mcp \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -H "x-dev-role: admin" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'

# call whoami
curl -s -X POST http://localhost:3000/mcp \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -H "x-dev-role: admin" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"whoami","arguments":{}}}'
# → {"result":{"content":[{"type":"text","text":"{ \"kind\": \"admin\", ... }"}],"structuredContent":{"kind":"admin","name":"Dev Admin","email":null,"tokenName":null}},"jsonrpc":"2.0","id":3}
```

In production replace the `x-dev-role` header with the two `CF-Access-Client-*` headers.

---

## Configuration

All configuration is via environment variables. Copy `.env.example` to `.env.local` for local dev; set these in your hosting platform (e.g. Coolify environment variables) for production.

### App env vars (Next.js server)

| Variable | Required | Default (dev) | Description |
|---|---|---|---|
| `AUTH_MODE` | Yes | `dev` | Identity provider. `dev` — role-switcher UI, no real auth, must not be used with `NODE_ENV=production`. `cloudflare` — Cloudflare Access JWT verification. |
| `DATABASE_URL` | Yes | `postgres://hub:hub@127.0.0.1:5433/hub` | PostgreSQL 16 connection string for the main database. |
| `TEST_DATABASE_URL` | Test only | `postgres://hub:hub@127.0.0.1:5433/hub_test` | Separate database used by the Vitest test suite. Keep isolated from the dev/prod DB. |
| `DESK_DATA_DIR` | Prod (recommended) | `<cwd>/.desk-data` (gitignored) | Root directory for the bare space repos (`<DESK_DATA_DIR>/spaces/<owner>/<space>.git`). **These bare repos are the canon** — point this at a backed-up, off-box volume in production (the NO-BACKUPS standing risk). |
| `GIT_HTTP_BACKEND_BIN` | No | `/usr/lib/git-core/git-http-backend` | Path to the system `git-http-backend` CGI the git transport wraps. Override if it lives elsewhere on the host. System `git` must be on `PATH`. |
| `ADMIN_EMAIL` | No (upgrade aid only) | — | **Transitional backfill only.** If set at boot, the app idempotently promotes that email's user to `role='admin'`. On a fresh deployment leave unset — the first CF-verified sign-in becomes admin. |
| `HUB_BASE_URL` | Yes | `http://localhost:3000` | Absolute base URL of the `desk.<domain>` host (no trailing slash). Used for absolute URL generation in API responses and the CLI. |
| `SHARE_BASE_URL` | Yes | `http://localhost:3000` | Absolute base URL of the `share.<domain>` host (no trailing slash). Used when minting capability share link URLs. |
| `SHARE_HOST` | Prod only | *(unset)* | Bare hostname of the share host, no scheme or port (e.g. `share.example.com`). When set, the middleware blocks all paths except `/s/*`, `/_next/*`, and `/robots.txt` on this hostname, returning a real HTTP 404. Unset in dev — the middleware becomes a no-op. |
| `DESK_TOKEN_KEY` | Optional | *(unset)* | 32-byte key for AES-256-GCM at-rest encryption of share tokens. Required to enable the **copy/reveal link** feature. Generate with `openssl rand -base64 32`. Accepts base64 (44 chars) or hex (64 chars). When unset, shares still work — the raw token is hashed for lookup — but `canCopy` is false and reveal returns 404. Rotating it makes existing `token_enc` values un-revealable (the links still work). |
| `CF_TEAM_DOMAIN` | Prod only (`cloudflare` mode) | — | Your Cloudflare Access team domain, e.g. `your-team.cloudflareaccess.com`. CF Zero Trust → Settings → Team Domain. |
| `CF_AUD` | Prod only (`cloudflare` mode) | — | The Audience Tag (AUD) for the `desk.<domain>` Access application. CF Zero Trust → Access → Applications → your app → Overview → Application Audience. |

> **Cloudflare Access + the git transport.** CF Access fronts the hub and expects a CF-Access JWT, but a `git` CLI sends HTTP Basic (the principal token). In production, CF Access must be configured to let `/api/git/*` reach the app's token gate (e.g. a bypass/service-auth policy for that path), or the transport must be reached on a path/host CF Access doesn't gate. This is the one integration point not testable headlessly.

### CLI env vars (`desk` CLI)

The CLI reads these from the shell environment, not from `.env.local`.

| Variable | Default | Description |
|---|---|---|
| `HUB_URL` | `http://localhost:3000` | API base URL the CLI calls. Set to `https://desk.<domain>` in production. |
| `HUB_DEV_ROLE` | `admin` | Dev-mode role sent via the `x-dev-role` header when CF headers are absent. Only effective in `AUTH_MODE=dev`. |
| `DESK_SOURCE_ROOT` | _(unset)_ | Optional root directory `desk status` uses as a fallback when resolving a doc's `sourcePath`. |
| `CF_ACCESS_CLIENT_ID` | — | Cloudflare Access service token client ID. If both CF vars are set, the CLI sends CF Access headers instead of the dev role header. |
| `CF_ACCESS_CLIENT_SECRET` | — | Cloudflare Access service token secret (shown once on creation). |

### Deploy platform

| Variable | Where to set | Description |
|---|---|---|
| `NIXPACKS_NODE_VERSION` | Coolify / Railway / Nixpacks build config | Node.js version for the Nixpacks build. Set to `20` to match `engines` in `package.json`. |

## Deploy

See [`docs/cutover-checklist.md`](docs/cutover-checklist.md) for the full supervised cloud cutover runbook (Coolify app + Postgres 16, Cloudflare tunnel hostnames, CF Access policy, service tokens, the git-transport bypass, the `DESK_DATA_DIR` backup cron, smoke tests).

---

## Repo layout

```
desk/
├── src/
│   ├── app/
│   │   ├── (hub)/          # Operator surfaces — CF Access-protected
│   │   │   ├── spaces/      # Spaces home: my spaces + shared-with-me; per-space docs (folder tree), members, visibility
│   │   │   ├── docs/        # Doc reader/editor (reached from a space)
│   │   │   ├── board/       # Kanban board
│   │   │   ├── catalog/     # Projection of a space directory's frontmatter (auto + `.desk.collection.yml` schema)
│   │   │   ├── distribution/# "Who can see what" audit (by space / user / links)
│   │   │   ├── settings/    # Principal (git) tokens
│   │   │   └── admin/       # Users, access requests, share log
│   │   ├── api/             # REST API (docs, shares, spaces, tokens, board, users) + /api/mcp + /api/git
│   │   ├── mcp/             # Public /mcp alias → MCP Streamable HTTP server (re-exports api/mcp)
│   │   ├── s/[token]/       # Public capability-link reader (no auth, token = credential)
│   │   ├── host-404/        # Route handler: real HTTP 404 for share-host guard
│   │   └── robots.ts        # Disallow all (nothing in Desk is publicly indexable)
│   ├── components/         # Shared UI components (Markdown, badges, etc.)
│   ├── db/                 # Drizzle schema + DB client
│   ├── lib/
│   │   ├── auth/           # Pluggable identity middleware (cloudflare / dev modes)
│   │   ├── git/            # Git transport (token→ACL gate in front of git-http-backend) + indexer.ts (the projection builder)
│   │   ├── spaces.ts       # Spaces + membership + principal tokens
│   │   ├── docs.ts         # Docs domain logic + space-scoped read path
│   │   ├── shares.ts       # Capability token mint/hash/resolve/revoke/view-log
│   │   ├── distribution.ts # The space-scoped "who sees what" lenses
│   │   └── mcp/            # MCP tool registry (tools.ts) + per-request server builder (server.ts)
│   ├── middleware.ts       # Host-based routing guard (share host → block non-/s/* paths)
│   └── test/               # Vitest global setup and test DB helpers
├── cli/                    # desk CLI (zero-dependency Node.js 20+)
├── docs/
│   ├── cutover-checklist.md  # Supervised cloud cutover runbook
│   ├── account-merge-runbook.md
│   ├── agent-runbook.md    # Autonomous reporting-bot recipe (provision → loop → review → distribute → dispatch)
│   ├── remotes.md          # Source modes + GitHub mirroring (hosted/mirrored recipes)
│   └── plans/              # Implementation phase plans
├── drizzle/                # Generated migration SQL files
├── docker-compose.dev.yml  # Local Postgres 16 for development
├── drizzle.config.ts       # Drizzle Kit config
└── next.config.ts          # Next.js config
```
