# Desk

Desk is a self-hosted doc publishing and capability-link sharing service. It gives teams a lightweight way to share documents and HTML artifacts — with stable, revocable URLs — without file-drop tools or manual attachment management. Publishing is a deliberate act: unpublishing kills every link instantly, and source files are never exposed directly.

## Architecture

Desk runs as a single Next.js 16 app behind two hostnames, with all authentication handled by Cloudflare Access (optional in dev, required in production):

- **`desk.<domain>`** — CF Access-protected. Full app: docs reader, admin dashboard, REST API. Only staff (users with active rows in the DB) can reach this host.
- **`share.<domain>`** — No CF Access. Only `/s/*` capability-link pages are reachable; the middleware hard-blocks everything else with a real HTTP 404. The capability token in the URL is the credential — no accounts, no guest sign-ups, no app registrations for external recipients.

Capability tokens are ≥128-bit random values stored hashed. Revoking a token (or unpublishing the underlying doc) makes every share URL that references it return 404 immediately.

## Access model

**Operator surfaces** (`desk.<domain>`) use Cloudflare Access for authentication. The CF Access JWT carries an email or service-token name; the app resolves it against the `users` table.

**First-login-admin + multi-admin model.** The first CF-verified email principal to sign in on a fresh deployment is automatically seeded as admin (no manual DB seed or env var required). From that point, admins can promote any member to admin (or demote them back) from the Users page — it is a stored, mutable column. Multiple admins are fully supported; the only invariant is that at least one active admin must always remain (the last-admin guard blocks demote/deactivate). Service-token rows can also be promoted to admin, giving an agent publish rights.

**Members** see published docs whose audience is a real **group** they can see: either the audience is marked *member-visible* (all signed-in members) **or** the member has been added to that audience's membership list. Admins see everything, manage users and audiences (incl. group membership), view the share log, and create/revoke capability links.

**Capability links** (`share.<domain>/s/<token>`) are accessible without any login. The raw token is the credential; it is shown exactly once on creation. Anyone with the URL can read the doc until the link is revoked or the doc is unpublished.

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

**Auth in dev.** `AUTH_MODE=dev` bypasses CF Access and activates a role switcher in the bottom-right corner of the app. Switch between `admin`, `member`, and `anonymous` to test all surfaces. The switcher is hidden in `AUTH_MODE=cloudflare` (production).

No manual DB seed is required: the first CF-verified email sign-in on a fresh deployment automatically creates the admin row (first-login-admin bootstrap).

---

## Tests and typecheck

```bash
pnpm vitest run          # run the full test suite (expects 235+ tests green)
pnpm vitest              # watch mode
pnpm typecheck           # tsc --noEmit
```

---

## CLI

The `desk` CLI publishes docs, creates share links, revokes them, and checks drift between local files and published versions. See [`cli/README.md`](cli/README.md) for commands and examples.

```bash
# One-time alias setup (adjust path to match where you cloned the repo)
alias desk='node /path/to/desk/cli/desk.mjs'

# Quick examples (local dev)
desk publish ~/docs/overview.md --audience team
desk share overview --label "Partner review" --expires 7
desk revoke "Partner review"
desk list
desk status
```

---

## Connecting an agent (MCP)

Desk exposes a **Model Context Protocol** server at **`/mcp`** so external agents (Claude Code, etc.) can call Desk tools directly. It speaks the MCP **Streamable HTTP** transport in stateless mode (each request is self-contained — no session to keep alive), and reuses the exact same authentication and authorization as the REST API: the Cloudflare Access wall in front of `desk.<domain>` authenticates the request, `getPrincipal` resolves it to a principal, and each tool enforces the same admin-vs-staff rules as its REST counterpart.

- **URL:** `https://desk.<domain>/mcp` (also reachable at `/api/mcp`; `/mcp` is the canonical public path).
- **Auth:** the same CF Access service-token headers the CLI uses (`CF-Access-Client-Id` / `CF-Access-Client-Secret`). An unauthenticated request gets a JSON-RPC `401`. On `share.<domain>` the endpoint is unreachable (the host middleware 404s everything outside `/s/*`).
- **Access:** **members** get read-only, audience-scoped access (the same docs they'd see in the reader); **admins** get the full management surface — publish/unpublish, shares, audiences, users, and access requests — i.e. everything the browser admin can do. Calling an admin tool as a member returns a tool error result, not a crash. The REST API and `desk` CLI remain fully available alongside MCP.

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

### Tools

| Tool | Role | Description |
|---|---|---|
| `list_docs` | staff | List docs visible to the caller (members: member-visible audiences only). Optional `q` substring filter. |
| `get_doc` | staff | One doc by `slug`: metadata, current content, version list. Viewer-scoped. |
| `get_version` | staff | Raw content of a specific `version_id` of a doc (`slug`). Viewer-scoped; cross-doc version ids are rejected as not-found. |
| `publish_doc` | admin | Create/update a doc (`slug`, `title`, `source_path`, `audience`, `format`, `content`). Audience must exist; content capped at 2 MB. |
| `unpublish_doc` | admin | Unpublish a doc by `slug` — kills the hub page and every share instantly. |
| `create_share` | admin | Mint a capability link for a doc (`doc_slug`, `label`, optional `expires_in_days`). Returns the one-time share URL. |
| `create_directory_share` | admin | Mint a capability link for a whole folder (`path_prefix`, `label`, optional `expires_in_days` / `allow_comments`). Exposes every published doc under the prefix (boundary-safe; root disallowed); new docs appear automatically, one revoke kills the lot. Returns the one-time share URL. |
| `list_shares` | admin | All shares (doc + directory) with view stats (count, last-viewed, expiry, revocation). Each row carries `mode` (`doc`/`directory`) + `docSlug` or `pathPrefix`. |
| `list_doc_shares` | admin | Shares for one doc (`slug`), newest-first, with view stats. Unknown slug → not-found. |
| `revoke_share` | admin | Revoke a share by numeric `id`. |
| `set_share_comments` | admin | Toggle whether link visitors may comment on a share (`id`, `allow`). |
| `list_share_views` | admin | Raw view log for a share (`id`): `viewedAt`, `ip`, `uaLabel`, `rawUa`, `docVersionId`. |
| `list_audiences` | staff | All audiences (key, label, member-visibility, doc count). |
| `create_audience` | admin | Create an audience (`key` matching `^[a-z0-9][a-z0-9-]*$`, `label`, optional `member_visible`). |
| `update_audience` | admin | Toggle an audience's `member_visible` flag by `id`. |
| `delete_audience` | admin | Delete an audience by `id` — refused while any doc still uses it. |
| `list_audience_members` | staff | List the members of an audience by `id` (the users who see its docs via group membership). |
| `add_audience_member` | admin | Add a user to an audience (`id`, `user_id`) — makes the audience a group; idempotent. |
| `remove_audience_member` | admin | Remove a user from an audience (`id`, `user_id`). |
| `list_comments` | staff | Comments on a doc you can see (slug → thread, audience-scoped). |
| `add_comment` | staff | Add a comment to a doc you can see (author = your principal). |
| `resolve_comment` | admin | Mark a comment resolved by `id`. |
| `delete_comment` | admin | Hard-delete a comment by `id`. |
| `propose_revision` | staff | Propose an edit to a markdown doc you can see (`slug`, full `content`, optional `note`) — queues an open revision. |
| `list_revisions` | staff | Proposed revisions on a doc (`slug`), newest-first, optional `status` filter. |
| `decide_revision` | admin | Accept (`accept: true` → publishes a new version) or reject (`accept: false`) a revision by `id`. |
| `list_users` | admin | All users (id, email, tokenName, displayName, role, active, createdAt). |
| `create_user` | admin | Create a member user (`display_name` + ≥1 of `email` / `token_name`). |
| `update_user` | admin | Update a user (`id` + `display_name?` / `token_name?` (null clears) / `active?`); enforces the self-deactivation guard. |
| `list_access_requests` | admin | Pending access requests (id, email, first/last seen, hits). |
| `approve_access_request` | admin | Approve a request by `id` (optional `display_name`) — creates the user, clears the request. |
| `dismiss_access_request` | admin | Dismiss a request by `id` without creating a user. |
| `list_buckets` | staff | The board's buckets (columns) in order, with live card counts. |
| `create_bucket` | admin | Create a bucket (`label`, optional `key`) at the end of the column order. |
| `update_bucket` | admin | Rename a bucket by `id` (label only; the key is immutable). |
| `delete_bucket` | admin | Delete a bucket by `id` — refused while any card (live or archived) references it. |
| `list_cards` | staff | Board cards (filters: `bucket_id`, `owner_user_id`, `owner: "me"`, `include_archived`). |
| `get_card` | staff | One card by `id` plus its activity trail (card.* events, oldest-first). |
| `create_card` | staff | Create a card (`title`, `bucket_id`/`bucket_key`, optional `body`/`doc_slug`/`checklist`/`owner_user_id`). Members own their own card. |
| `update_card` | staff (owner/admin) | Edit a card's `title`/`body`/`doc_slug`/`checklist`. Members may edit only cards they own. |
| `move_card` | staff (owner/admin) | Move a card to a `bucket_id` at a slot (`index`). Members move only their own cards. |
| `assign_card` | admin | Assign (or clear) a card's owner — admin-only reassignment. |
| `archive_card` | staff (owner/admin) | Archive (`archived: true`) or restore a card. Members act only on cards they own. |
| `list_catalog_kinds` | staff | Every catalog kind (schema-as-data registry) with its label, idPattern, JSON Schema, and item count. |
| `get_catalog_schema` | staff | One kind's schema by `kind` slug. Unknown kind → error. |
| `upsert_catalog_schema` | admin | Create/update a kind (`kind`, `label`, `id_pattern` regex, `schema` JSON Schema). idPattern + schema must compile. |
| `list_catalog_items` | staff | Items in a kind, newest-updated first. Optional `status` (exact) + `q` (substring over id/title). |
| `get_catalog_item` | staff | One item (`kind`, `item_id`) plus its outbound + inbound typed links. |
| `upsert_catalog_item` | admin | Create/update an item. `item_id` is client-proposed (validated against the kind's idPattern); `data` validated against the schema; links auto-derived. |
| `delete_catalog_item` | admin | Delete an item (`kind`, `item_id`) — cascades its links both directions. |
| `whoami` | staff | The resolved principal (kind, name, masked email/token) — "is my token wired right?" |

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
| `ADMIN_EMAIL` | No (upgrade aid only) | — | **Transitional backfill only — not used for live role derivation.** If set at boot, the app idempotently promotes that email's user to `role='admin'` (preserves your admin across the v2 upgrade). Remove it from the environment after the first post-upgrade deploy confirms you're still admin. On a fresh deployment with no prior data, leave this unset — the first CF-verified sign-in automatically becomes admin. |
| `HUB_BASE_URL` | Yes | `http://localhost:3000` | Absolute base URL of the `desk.<domain>` host (no trailing slash). Used for absolute URL generation in API responses and the CLI. |
| `SHARE_BASE_URL` | Yes | `http://localhost:3000` | Absolute base URL of the `share.<domain>` host (no trailing slash). Used when minting capability share link URLs. |
| `SHARE_HOST` | Prod only | *(unset)* | Bare hostname of the share host, no scheme or port (e.g. `share.example.com`). When set, the middleware blocks all paths except `/s/*`, `/_next/*`, and `/robots.txt` on this hostname, returning a real HTTP 404. Unset in dev — the middleware becomes a no-op. |
| `DESK_TOKEN_KEY` | Optional | *(unset)* | 32-byte key for AES-256-GCM at-rest encryption of share tokens. Required to enable the **copy/reveal link** feature (admin can re-copy an existing share URL). Generate with `openssl rand -base64 32` and set in Coolify prod env. Accepts base64 (44 chars) or hex (64 chars). When unset, shares still work normally — the raw token is hashed for lookup — but `canCopy` is false and reveal returns 404. **Key rotation:** rotating this key makes existing `token_enc` values undecryptable (the links still work — hash lookup is unaffected — but they can no longer be copied/revealed via the admin UI until new shares are created). |
| `CF_TEAM_DOMAIN` | Prod only (`cloudflare` mode) | — | Your Cloudflare Access team domain, e.g. `your-team.cloudflareaccess.com`. Find it in the Cloudflare Zero Trust dashboard → Settings → Custom Pages → Team Domain. |
| `CF_AUD` | Prod only (`cloudflare` mode) | — | The Audience Tag (AUD) for the `desk.<domain>` Access application. Find it in Cloudflare Zero Trust → Access → Applications → your app → Overview → Application Audience. Used to verify the `aud` claim in CF JWTs. |

### CLI env vars (`desk` CLI)

The CLI reads these from the shell environment, not from `.env.local`.

| Variable | Default | Description |
|---|---|---|
| `HUB_URL` | `http://localhost:3000` | API base URL the CLI calls. Set to `https://desk.<domain>` in production. |
| `HUB_DEV_ROLE` | `admin` | Dev-mode role sent via the `x-dev-role` header when CF headers are absent. Only effective when the server is running in `AUTH_MODE=dev`. |
| `DESK_SOURCE_ROOT` | _(unset)_ | Optional root directory `desk status` uses as a fallback when resolving a doc's `sourcePath` (after trying the current working directory). |
| `CF_ACCESS_CLIENT_ID` | — | Cloudflare Access service token client ID. If both CF vars are set, the CLI sends CF Access headers instead of the dev role header. Obtain from CF Zero Trust → Access → Service Auth → your token. |
| `CF_ACCESS_CLIENT_SECRET` | — | Cloudflare Access service token secret (shown once on creation). |

### Deploy platform

| Variable | Where to set | Description |
|---|---|---|
| `NIXPACKS_NODE_VERSION` | Coolify / Railway / Nixpacks build config | Node.js version to use during the Nixpacks build. Set to `20` to match the `engines` field in `package.json`. |

## Deploy

The app deploys as a standard Next.js standalone build behind any Node.js host (Coolify, Railway, a container, etc.). Provision a Postgres 16 database, set the environment variables above, run `pnpm drizzle-kit migrate`, and start with `pnpm build && pnpm start`. For production auth, put the app behind Cloudflare Access and set `AUTH_MODE=cloudflare` with the `CF_*` variables.

---

## Repo layout

```
desk/
├── src/
│   ├── app/
│   │   ├── (hub)/          # Operator surfaces (docs list, admin) — CF Access-protected
│   │   │   ├── admin/      # Admin dashboard: all docs, shares, view log, drift
│   │   │   └── docs/       # Docs reader for authenticated internal users
│   │   ├── api/            # REST API endpoints (docs CRUD, shares, revoke, views) + /api/mcp
│   │   ├── mcp/            # Public /mcp alias → MCP Streamable HTTP server (re-exports api/mcp)
│   │   ├── host-404/       # Route handler: real HTTP 404 for share-host guard
│   │   ├── s/[token]/      # Public capability-link reader (no auth, token = credential)
│   │   ├── layout.tsx      # Root layout (fonts, theme init script)
│   │   └── robots.ts       # Disallow all (nothing in Desk is publicly indexable)
│   ├── components/         # Shared UI components (Markdown, AudienceBadge, etc.)
│   ├── db/                 # Drizzle schema + DB client
│   ├── lib/
│   │   ├── auth/           # Pluggable identity middleware (cloudflare / dev modes)
│   │   ├── constants.ts    # Shared copy constants (uniform 404 text, etc.)
│   │   ├── host-routing.ts # Pure decideRoute() function (share-host middleware logic)
│   │   ├── mcp/            # MCP tool registry (tools.ts) + per-request server builder (server.ts)
│   │   ├── docs.ts         # Docs domain logic
│   │   ├── shares.ts       # Capability token mint/hash/resolve/revoke/view-log
│   │   └── tokens.ts       # Cryptographic token primitives
│   ├── middleware.ts       # Host-based routing guard (share host → block non-/s/* paths)
│   └── test/               # Vitest global setup and test DB helpers
├── cli/                    # hub CLI (zero-dependency Node.js 20+)
├── drizzle/                # Generated migration SQL files
├── docker-compose.dev.yml  # Local Postgres 16 for development
├── drizzle.config.ts       # Drizzle Kit config
└── next.config.ts          # Next.js config
```

**Design.** The visual design (tokens, typography, component layout) lives in `src/app/globals.css` and the component styles. Theme tokens (light/dark, badge colors) are defined as CSS custom properties there.
