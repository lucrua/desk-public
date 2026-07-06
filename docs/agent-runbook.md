# Agent runbook: an autonomous reporting bot, end to end

This is the concrete, copy-pasteable recipe for the owner's proof case
(convergence fix-pass, Slice 5): an **autonomous agent running in Docker** that,
on a schedule, reads Amplitude + a space's catalogs and **publishes a report the
team reviews**. It is the worked example behind everything in `README.md` and
`docs/architecture.md` — spaces, principal tokens, MCP, `push_policy`,
proposals, directory shares, suggest-edit, and the event log.

The running example is the **`acme-growth`** space (owner `lucas`), a
Docker agent user `growth-bot`, and a weekly Amplitude report landing under
`reports/`.

> **The mental model.** Desk hosts **no runner**. "The agent" is your own
> container with `cron` (or any scheduler) in it. Desk gives it four things: a
> git repo to clone/push (the space), the MCP tool surface, a review gate
> (`push_policy` + proposals), and an event log to poll for dispatch. Everything
> below is orchestration you own; Desk is the substrate.

---

## The two-credential reality (read this first)

An agent that both **pushes git** and **calls MCP** needs **two separate
credentials**, because Desk has two doors with two auth mechanisms:

| Surface | Credential | How the agent presents it |
|---|---|---|
| **git transport** (`/api/git/<owner>/<space>.git`) — clone/pull/push | a **principal token** (HTTP Basic) minted by the bot user | `https://git:<token>@<host>/api/git/...` |
| **MCP** (`/mcp`) — `list_events`, `move_card`, `decide_proposal`, … | the bot's **web identity**: a Cloudflare Access **service token** (prod) or `x-dev-role` (dev) | `CF-Access-Client-Id` / `CF-Access-Client-Secret` headers (prod) |

They are **not interchangeable**: a principal (git) token is rejected by MCP, and
a CF service token cannot push git. Both must resolve to the **same bot user** so
the bot's single `writer` membership governs both — see provisioning below.

---

## 1. Provision the agent

Done once, by an **admin/owner**. All of this is in the web UI; the MCP
equivalents are shown so an admin's own agent can self-provision.

**a. Create the bot user.** Admin → Users → add a user for the bot (give it an
email or, better, an agent identity keyed to a service-token name). Via MCP
(`create_user` is REST/UI-only for humans; for an agent identity the CF service
token's name becomes the user on first sign-in, then promote/role it).

**b. Give it `writer` on the space.** The bot must be able to write the space's
repo. On `/spaces/acme-growth` → **Members** → add `growth-bot` as
`writer`. Via MCP:

```jsonc
// set_space_member — admin/owner only
{ "slug": "acme-growth", "user_id": <growth-bot-user-id>, "role": "writer" }
```

`writer` (not `owner`) is deliberate: under `push_policy=proposal` (step 3) a
writer's pushes land as **proposals** for review, which is exactly the gate we
want for an autonomous bot.

**c. Mint the bot's principal (git) token.** Signed in **as the bot**, mint a
token at `/settings/tokens` (shown **once** — capture it into the container's
secret store). Via MCP, the bot mints its **own** token:

```jsonc
// create_token — mints a git token for the CALLING principal (the bot)
{ "label": "growth-bot docker" }   // → { "token": "…", … }  (raw token returned ONCE)
```

Store it as `DESK_GIT_TOKEN` in the container.

**d. (prod) Give the bot an MCP identity — a CF Access service token.** In
Cloudflare Zero Trust → Access → Service Auth → create a service token; add it to
the Access policy fronting `desk.<domain>`. Its **name** is what Desk resolves to
the bot user — so the same `growth-bot` row carries the `writer` membership for
**both** doors. Store `CF-Access-Client-Id` / `CF-Access-Client-Secret` in the
container. In **dev** (`AUTH_MODE=dev`, no CF wall) there is no service token —
the agent sends `x-dev-role: admin` (or `member`) instead.

Wire the MCP endpoint into the agent's client, e.g. Claude Code:

```bash
# prod
claude mcp add --transport http desk https://desk.<domain>/mcp \
  --header "CF-Access-Client-Id: $CF_ID" \
  --header "CF-Access-Client-Secret: $CF_SECRET"

# dev
claude mcp add --transport http desk-local http://localhost:3000/mcp \
  --header "x-dev-role: admin"
```

Sanity-check the wiring with the `whoami` tool — it should report the bot's
identity, not anonymous.

---

## 2. The container loop (cron)

The scheduler fires (say hourly). Each run is a self-contained clone → read →
call Amplitude → write → commit → push. A minimal shape:

```bash
#!/usr/bin/env bash
set -euo pipefail

HOST="desk.<domain>"
OWNER="lucas"
SPACE="acme-growth"
GIT_URL="https://git:${DESK_GIT_TOKEN}@${HOST}/api/git/${OWNER}/${SPACE}.git"
WORK="/work/${SPACE}"

# ── clone or pull ──────────────────────────────────────────────────────────
# ⚠ Desk renders MAIN ONLY. Always clone/pull/push `main` explicitly — a repo
#    whose default branch is `master` renders NOTHING (see docs/remotes.md,
#    "main-only, and branch naming"). Desk's bare HEAD is `main`.
if [ -d "${WORK}/.git" ]; then
  git -C "${WORK}" fetch origin main
  git -C "${WORK}" checkout main
  git -C "${WORK}" reset --hard origin/main
else
  git clone --branch main "${GIT_URL}" "${WORK}"
fi
```

**Read the catalogs as files — cloning IS the catalog API.** There is **no
catalog MCP/REST surface by design** (the catalog is a read-only *projection* of
the repo; its truth is the files). The agent reads each doc's **YAML
frontmatter** and the optional **`.desk.collection.yml`** schema **directly from
its clone**:

```bash
# The collection schema for a directory (optional — declares fields/validation).
cat "${WORK}/customers/.desk.collection.yml"    2>/dev/null || true

# Each doc's frontmatter is the catalog row — parse the `--- … ---` block.
for f in "${WORK}"/customers/*.md; do
  awk '/^---$/{c++; next} c==1{print} c==2{exit}' "$f"   # emit the frontmatter block
done
```

Whatever the agent needs as input (segment definitions, account lists, KPI
targets) lives as frontmatter in the space and arrives for free in the clone —
no extra API call.

**Call Amplitude.** Use Amplitude's own MCP server or REST API (its credentials,
not Desk's) to pull the metrics the report needs. This is entirely outside Desk.

**Write the report.** Emit a dated file under `reports/`:

```bash
DATE="$(date -u +%F)"
OUT="${WORK}/reports/${DATE}-weekly-growth.md"
mkdir -p "${WORK}/reports"
cat > "${OUT}" <<EOF
---
title: Weekly growth — ${DATE}
author: growth-bot
kind: report
---

# Weekly growth — ${DATE}

... report body assembled from Amplitude + the space's catalogs ...
EOF
```

**Commit + push `main`.** The push is the publish:

```bash
git -C "${WORK}" add reports/
git -C "${WORK}" -c user.name="growth-bot" -c user.email="growth-bot@acme" \
  commit -m "reports: weekly growth ${DATE}"
git -C "${WORK}" push origin HEAD:main    # HEAD:main — never a bare push
```

Under `push_policy=proposal` (next section) this push does **not** move `main`;
it lands on a `proposals/growth-bot` ref for review. Under `direct` it publishes
`main` immediately and Desk re-projects within seconds.

---

## 3. Review gate

Set the space's **`push_policy`** to control whether the bot's report
auto-publishes or waits for a human:

- **`proposal`** (recommended for an autonomous bot) — a non-owner writer's push
  lands as a **proposal (PR)**, not on `main`. The owner reviews the diff and
  **accepts** or **rejects**.
- **`direct`** — the writer's push publishes `main` immediately (no gate).

Set it on `/spaces/acme-growth` → **push policy** (owner/admin), or:

```bash
curl -X PATCH "https://desk.<domain>/api/spaces/acme-growth" \
  -H "content-type: application/json" \
  -H "CF-Access-Client-Id: $CF_ID" -H "CF-Access-Client-Secret: $CF_SECRET" \
  -d '{"push_policy":"proposal"}'
```

The owner works the queue (UI diff, or the agent surface):

```jsonc
// list_proposals — the PR queue for the space
{ "slug": "acme-growth" }

// decide_proposal — accept (merge → main + reindex + drop ref) or reject
{ "slug": "acme-growth", "name": "proposals/growth-bot", "accept": true }
```

On **accept**: the proposal merges to `main` → the indexer projects it → **if the
space is `hosted` with a mirror configured, the accepted commit mirrors out to
the paired GitHub repo** (see `docs/remotes.md`). One write, fanned out from git.

---

## 4. Distribute to the team

Publishing to `main` renders the report on the hub for **members**. To share it
with people who aren't space members (the wider team, external stakeholders),
mint a **directory share** on `reports/`:

```jsonc
// create_directory_share — admin. SPACE-SCOPED (Slice 1): requires `space`,
// so a same-named `reports/` folder in another space never leaks through.
{ "space": "acme-growth", "path_prefix": "reports", "label": "Weekly growth reports" }
// → returns the one-time share URL on share.<domain>/s/<token>
```

Recipients open the `share.<domain>` link with **no account** (the token is the
credential). They read every report under `reports/` and, if `allow_comments` is
on, comment.

**Let them suggest edits (Slice 3).** Flip `allow_edits` on the share
(`PATCH /api/shares/[id]` `{ "allowEdits": true }`, REST/admin) and a markdown
report grows a **"Suggest an edit"** affordance. A visitor submits a full
proposed body; it queues as a **revision** carrying a forced `link:<label>`
identity, which the owner reviews in the diff UI and **accepts** (→ a real git
commit on `main`, authored by the proposer, mirrored out like any other) or
**rejects**. Fail-closed: with `allow_edits` off, the endpoint is a uniform 404.

```jsonc
// the owner's agent works the suggestion queue over MCP:
{ }                                   // list_open_revisions → open revisions (with a "via share" badge)
{ "id": <revision-id>, "accept": true }   // decide_revision → commit on accept
```

---

## 5. Dispatch follow-ups (near-real-time)

To hand the bot ad-hoc work, **assign a board card to the bot's user**. The
agent discovers it by **polling the event log** for `card.assigned` — Desk hosts
**no push/webhook** dispatch (the agent has no public interface); the loop is
outbound-only, the CI-runner pattern.

```jsonc
// owner/admin assigns a card to the bot
{ "id": <card-id>, "owner_user_id": <growth-bot-user-id> }   // assign_card
```

The container's dispatch loop persists a **cursor** and asks for events after
it. Two ways to poll:

**Tight poll (always available)** — ask every 30–60 s:

```jsonc
// list_events — advance `since` to nextCursor each round; filter to card.assigned
{ "since": <cursor>, "kinds": ["card.assigned"] }
// → { "events": [ { "id": 1234, "payload": { "cardId": 42, "ownerUserId": … } } … ],
//     "nextCursor": 1234 }
```

**Near-real-time long-poll (`wait_seconds`, Slice 5)** — pass `wait_seconds`
(0–55) and the call **parks server-side** until an event arrives or the timeout
elapses, then returns (possibly empty). No tight-loop latency, still a normal
outbound request:

```jsonc
{ "since": <cursor>, "kinds": ["card.assigned"], "wait_seconds": 50 }
```

The REST equivalent is `GET /api/events?since=<cursor>&kinds=card.assigned&wait_seconds=50`.
When it returns empty (timeout), re-issue with the same `since`; when it returns
an event, work it and advance `since` to `nextCursor`. `wait_seconds` is clamped
to `[0, 55]`; `0`/omitted is the immediate default. It releases the DB connection
between internal polls and ends promptly on client disconnect, so a wall of
parked agents is safe.

The agent works the card (reads it with `get_card`, does the work, commits any
output per §2), then marks it done by moving it:

```jsonc
// move_card — into the "done" bucket at the top (resolve the bucket id via list_buckets)
{ "id": 42, "bucket_id": <done-bucket-id>, "index": 0 }
```

Persist the cursor across container restarts (a file/volume) so a restart never
re-processes or drops an assignment.

---

## 6. Tier-1 → Tier-2 upgrade (onboard a contributor)

A share visitor who suggests edits (§4) is a **Tier-1** collaborator: no account,
capability-scoped, one-suggestion-at-a-time. When one becomes a **regular
contributor**, upgrade them to **Tier-2** — a real space member — with an
**invite (E1)**:

```jsonc
// create_invite — admin/owner. Mints a one-time invite link for self-serve onboarding.
{ "slug": "acme-growth", "role": "writer", "email": "contributor@partner.com" }
// → the one-time invite URL
```

They accept the invite, land as a `writer`, and from then on their contributions
flow through the **same `push_policy`** as the bot: under `proposal` their pushes
(and web-authored edits) arrive as proposals the owner accepts; under `direct`
they publish straight to `main`. No new machinery — the invite → membership →
`push_policy` path already carries them.

---

## What is NOT built (so you plan around it)

- **No in-Desk runner.** Desk emits `card.assigned` and holds the
  proposal/revision primitives, but **the runner is your container's `cron`** —
  Desk does not execute agents. (`README` "What's built vs not": the
  headless-agent loop is 🔴 not built beyond the primitives.)
- **No push/webhook dispatch.** Dispatch is outbound polling only
  (`list_events`, optionally with `wait_seconds`) — there is no callback URL.
- **No packs (scoped inputs).** The agent clones the **whole** space to read
  catalogs; a re-organized, minimized *subset* repo for scoped agent inputs
  ("packs") is deferred. Until then, scope by directory (`path_prefix`) and by
  what you choose to read from the clone.
- **No catalog authoring API.** An agent "writes" a catalog by committing
  frontmatter (§2) — there is deliberately no catalog MCP/REST write surface.
