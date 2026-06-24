# Desk — External Collaboration: invite, self-serve onboarding, configurable PR protection (build spec)

> **Status: ACTIVE — building 2026-06-23.** Turns "share a set of docs with an external partner whose agent reads + contributes, and changes come back safely" into a real, self-serve, canon-protected flow. AUTH-SENSITIVE (account creation from a capability link + a new git write-boundary rule). Lands in the Desk repo.
> **Model:** inherits `docs/architecture.md` (spaces = git repos; read = membership/visibility/share; write = space membership via token through `src/lib/git/auth.ts`). Reuses: capability links (sha256-at-rest, uniform-404), `mintPrincipalToken`, `space_members`, `initBareRepo` (it already installs a hook), the revision/propose UI patterns.

## Use case
An owner shares a space with an external partner; the partner's **agent** clones it, reads instructions, contributes (edits + **new files**), and changes return to the owner. Today this is doable but manual (admin mints a token by hand; canon is protected only by using a separate space; fold-back is manual). This feature makes it **self-serve** and **protects the source of truth**.

## Decisions
- **Invite = a capability link.** Random token (sha256 at rest), scoped to one space + role + expiry + optional target email + use-limit. The **accept flow is public** (on the share host / a CF-Access-bypassed path) — external recipients can't pass CF Access, so **the invite link itself is the authorization.**
- **Self-serve accept:** open link → enter email → find-or-create user → add space membership at the invite's role → **auto-mint a principal token** → show a **paste-able setup prompt**.
- **Configurable per-space push policy:** `spaces.push_policy ∈ {direct, proposal}`, owner-settable, **default `direct`** (current behavior preserved). In `proposal` mode, **non-owner** writers CANNOT push the hosted branch (`main`); their pushes go to `proposals/*` and surface as **PRs** the owner reviews + merges. **Owner/admin always push direct.**
- **Proposals (PRs):** a `proposals/<name>` ref = a proposal. Owner sees the **diff** (merge-base(main,proposal)..proposal) and **Accept** (server-side merge → main + reindex + delete ref) / **Reject** (delete ref).

---

## Slice E1 — Invite + self-serve onboarding + setup prompt + push-policy config (lower-risk; build first)

**Schema (migration):**
- `space_invites` { id, spaceId → spaces.id, role (`writer`|`reader`), tokenHash text uniq, email text? (targeted/optional), createdByUserId → users.id, expiresAt, maxUses int default 1, uses int default 0, createdAt }.
- `spaces.push_policy` enum(`direct`,`proposal`) NOT NULL default `direct`.

**Endpoints:**
- `POST /api/spaces/[slug]/invites` (owner/admin) `{role, email?, expiresInDays?, maxUses?}` → mints the invite; returns the **invite URL** (`<SHARE_BASE_URL>/invite/<rawToken>`), shown once. MCP `create_invite` (agents may invite). Parity per the MCP=agent-surface rule.
- `GET /invite/[token]` — **public page on the share host** (must be reachable without CF Access — confirm the share host/path is not CF-gated, like `/s/*`). Resolve by tokenHash; **uniform 404** for invalid/expired/over-limit/revoked. Render: "You're invited to **<space>** as **<role>** — enter your email to join."
- `POST /api/invite/[token]/accept` `{email}` — in one transaction: find-or-create the user (email, role=`member`, active), `space_members` upsert at the invite's role, `uses++` (reject if over `maxUses`/expired — uniform 404), `mintPrincipalToken(user, label="invite:<space>")`. Return `{ token (raw, once), cloneUrl, setupPrompt }`. Do **not** reveal whether the email already existed.

**Setup prompt** (template; shown on accept + on the space page to members) — adapt to `push_policy`:
> You have access to the Desk space **`<owner>/<space>`**. Configure git to use this token, clone it, read `INSTRUCTIONS.md`, do the work, then push.
> ```
> git clone https://<token>@<git-host>/api/git/<owner>/<space>.git
> # …work…
> git push origin HEAD:main            # push_policy=direct
> git push origin HEAD:proposals/<you> # push_policy=proposal → opens a PR for the owner
> ```

**Push-policy UI:** on `/spaces/[slug]` (owner/admin), a control to set `push_policy` → `PATCH /api/spaces/[slug] {push_policy}` (reuse the visibility-PATCH gate: owner-or-admin).

**Security (E1):** the invite is a capability (sha256 at rest, uniform-404, expiry + use-limit). **Account creation is gated by a valid invite** — no invite, no account; the created user is scoped to the one space. No email-existence leak.

**Tests (E1):** invite create (owner-or-admin only); accept with a new email (creates user+member+token) and an existing email (adds membership, no dup user); expired/over-limit/unknown/revoked → uniform 404; `push_policy` defaults to `direct` and can be set by owner/admin only; setup-prompt copy switches on policy. Full suite + build + typecheck green.

---

## Slice E2 — Push-policy enforcement (git transport) + proposals/PR review (security-critical; build after E1 is verified)

**Ref-level push authz** — when `push_policy=proposal` and the pusher is a **non-owner writer**: reject updates to `main` (the hosted branch), allow only `refs/heads/proposals/*`. Owner/admin → unrestricted. **Direct mode unchanged.**
- Enforce via a **pre-receive hook** on the bare repo. The git route already authenticates the principal + spawns `git-http-backend`; pass the resolved **role** + the space's **push_policy** to the hook via env (`DESK_PUSHER_ROLE`, `DESK_PUSH_POLICY`) on the spawn — they propagate through `git-http-backend` → `git-receive-pack` → the hook. The hook reads the ref updates on stdin (`<old> <new> <ref>`) and rejects disallowed ones with a clear message (`remote: rejected — this space requires proposals: push to proposals/<name>`). **⚠ Verify env actually reaches the hook EARLY — it's the crux; if `git-http-backend` strips custom env, fall back to enforcing in the route by inspecting the advertised/expected refs.**
- `initBareRepo` already installs a hook — install/extend the pre-receive policy hook there, and **backfill** it onto existing bare repos.

**Proposals surface (PR review):**
- `GET /api/spaces/[slug]/proposals` → list `proposals/*` refs as `{name, pusher, tipSha, createdAt}` (owner/admin, or the proposer for their own).
- A review view (reuse revision/approval UI patterns): **diff** (merge-base(main, proposal)..proposal); **Accept** → server-side merge of proposal → main (ff or merge commit), then **reindex** + delete the proposal ref; **Reject** → delete the ref. Emit events.
- `POST /api/spaces/[slug]/proposals/[name]/accept|reject` (owner/admin). MCP `list_proposals` / `decide_proposal` (the owner's agent may triage).

**Security (E2) — CRITICAL, exhaustive tests:** in `proposal` mode a non-owner writer's push to `main` is **rejected** but to `proposals/x` **succeeds**; owner/admin push `main` in proposal mode; `direct` mode behaves exactly as today; Accept merges + reindexes + deletes the ref; Reject deletes; a non-owner/non-admin cannot accept/reject; the read boundary (who sees the space's docs) is unchanged. Plus a live clone→push-to-proposal→accept e2e.

---

## Landing
Branch off `main`. **E1 then E2** (E2 after the orchestrator verifies E1's boundary). Atomic commits; full `npx vitest run` + `pnpm build` + `pnpm typecheck` green; **commit + STOP, no deploy** (orchestrator verifies the auth boundary + deploys to staging). Also commit this spec into the Desk repo at `docs/specs/external-collaboration.md`.

## Outcomes
_(appended after each slice.)_
