# Remotes: source modes + GitHub mirroring

Every space Desk hosts is a real git repo (§3 of `architecture.md`). This doc
covers the durability layer on top of that (convergence fix-pass, Slice 4;
decisions D-C3/D-C4/D-C5): how a space's canon relates to a paired GitHub
repo, and how to configure it. If you only read one section, read the
invariant below — everything else is a consequence of it.

## The one-push-target invariant

**Every repo has exactly one push target. The other side is always read-only.**

A space is either:

- **`hosted`** (the default) — **Desk is canon.** You push to Desk; Desk
  mirrors `main` *out* to a paired GitHub repo after every write, one-way. The
  GitHub side is a read-only mirror — nobody pushes to it directly.
- **`mirrored`** — **GitHub is canon.** You push to GitHub; a GitHub Action
  forwards the push *in* to Desk. Desk-originated writes (web authoring,
  accepting a proposed revision, accepting a proposal) are refused server-side
  — the only way content reaches Desk is a git push arriving over the
  transport, exactly as GitHub sent it.

Getting this backwards — pushing to the read-only side of either pairing —
either does nothing useful (a `hosted` space's GitHub mirror rejects a push if
you protect `main` as recommended below) or gets silently overwritten on the
next mirror/forward cycle. **Pick one mode per space and always push to the
canon side.**

```
hosted:    you ──push──▶ Desk ──mirror-out──▶ GitHub (read-only)
mirrored:  you ──push──▶ GitHub ──Action (git push)──▶ Desk (refuses its own writes)
```

## `main`-only, and branch naming

Desk renders (and mirrors) **`main` only** — v1 does not mirror `proposals/*`
or any other ref. Desk's bare-repo `HEAD` is `main`; if your local default
branch is `master` (an older `git init` default, or an imported repo), pushing
`HEAD` alone moves nothing Desk renders. Always push explicitly:

```bash
git push desk HEAD:main
```

This applies in both modes — the GitHub Action recipe below also targets
`main` explicitly for the same reason.

## Recipe: `hosted` (Desk is canon, GitHub is a mirror)

This is the default for every space (`source_mode` defaults to `hosted`, no
mirror configured). To add a GitHub backup:

1. Create an empty GitHub repo (no README/license — an empty `main`, or Desk's
   first mirror push will fail to fast-forward a divergent history).
2. In Desk, open the space's settings page (`/spaces/<slug>`, owner/admin
   only) → **GitHub mirror** → set the **remote URL** to the GitHub repo's
   clone URL (`https://github.com/<org>/<repo>.git` or
   `git@github.com:<org>/<repo>.git`), leave **source mode** at `hosted`.
3. Set a credential Desk can push with (pick one):
   - **Instance PAT** (primary path, §"Setting the instance PAT" below) — one
     fine-grained GitHub token for the whole deployment, used for every
     `https://` mirror remote that has no per-space override.
   - **Per-space deploy key** (secondary, §"Per-space deploy key" below) — an
     SSH keypair scoped to one GitHub repo, for isolation.
4. Click **Mirror now** to push immediately, or just keep working — Desk
   mirrors automatically after every `main`-advancing write (a transport push,
   a web-authored commit, an accepted proposal, an accepted revision).
5. **Protect `main` on the GitHub side** (repo Settings → Branches → branch
   protection rule for `main`, require a PR / restrict who can push, or simply
   don't grant anyone push access) — this repo exists to receive Desk's
   mirror pushes, not to be edited directly. A direct push to the GitHub
   mirror is invisible to Desk (Desk never pulls from it in `hosted` mode) and
   will be silently overwritten on the next mirror push.

Mirror pushes are **fire-and-forget**: a failure (bad credential, unreachable
remote, a protected `main` on the GitHub side) never blocks or fails the
triggering Desk write — it's recorded in `mirror_state` (last mirrored sha,
last attempt time, last error) and shown on the space settings page, with
exponential-backoff retries.

## Recipe: `mirrored` (GitHub is canon, Desk receives pushes)

Use this when a team already lives in GitHub and wants Desk purely as the
render/access/feedback layer, with GitHub staying the place people actually
edit and merge PRs.

1. In Desk, open the space's settings page → **GitHub mirror** → set
   **source mode** to `mirrored`. (You do not need a mirror remote URL for
   this mode — Desk never pushes out.)
2. Mint a **principal token** for the account that will push (an existing
   member, or a dedicated bot user) at `/settings/tokens` — this is the git
   Basic-auth credential the Action uses, scoped by that user's `writer`/
   `owner` role on the space.
3. In the GitHub repo, add a step that pushes to Desk on every push to `main`.
   Store the principal token as a repo secret (e.g. `DESK_TOKEN`):

   ```yaml
   # .github/workflows/mirror-to-desk.yml
   name: Mirror to Desk
   on:
     push:
       branches: [main]
   jobs:
     mirror:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
           with:
             fetch-depth: 0
         - name: Push to Desk
           run: |
             git remote add desk https://git:${DESK_TOKEN}@<your-desk-host>/api/git/<owner>/<space>.git
             git push desk HEAD:main
           env:
             DESK_TOKEN: ${{ secrets.DESK_TOKEN }}
   ```

   Replace `<your-desk-host>`, `<owner>`, and `<space>` with this space's real
   git URL — copy it from the "push to this space" block on the space page (it
   already has the exact owner/space segments).

4. From here, Desk-originated writes are refused with a clear error: web
   authoring (new doc / edit / upload), accepting a proposed revision, and
   accepting a proposal all return a `mirrored`-refusal instead of committing.
   The revision/proposal review UI still shows the diff — apply the change
   upstream on GitHub (edit + merge there) and let the Action forward it in.
   The git transport push itself is **never** refused — it's exactly how a
   `mirrored` space receives its canon.

## Setting the instance PAT

One instance-wide GitHub PAT covers every `hosted` space's `https://` mirror
remote that has no per-space deploy-key override. As an admin:

1. Go to `/admin` → **GitHub mirror PAT**.
2. Paste a **fine-grained personal access token** scoped to **Contents:
   Read and write** on the repos you want to mirror into (repo access can be
   "selected repositories" — scope it to just your mirror targets).
3. Save. The page only ever shows **configured ✓ / not configured** — the
   token is AES-256-GCM-encrypted at rest (`DESK_TOKEN_KEY`) and there is no
   endpoint that reads it back, by design. Replace or clear it the same way;
   clearing it does not touch any space's `mirror_remote_url` or `source_mode`
   — it just removes the credential mirror pushes would use.

`DESK_TOKEN_KEY` must be set on the instance for this to work (it's the same
key that encrypts share-token reveal — see the README's Configuration table).
Without it, saving a PAT (or a deploy key) is refused rather than stored in
plaintext.

## Per-space deploy key (optional, advanced)

A per-space override is useful when you want repo-level credential isolation
instead of sharing the instance PAT across every mirror. It's an SSH
private key, preferred over the instance PAT whenever both are usable for a
given remote (an `ssh://`/`git@` remote uses the deploy key; an `https://`
remote uses the instance PAT; there is currently no keypair *generation* UI —
generate it yourself and paste the private half):

```bash
ssh-keygen -t ed25519 -f desk-mirror-key -N ""
# desk-mirror-key.pub  → GitHub repo → Settings → Deploy keys → Add deploy key
#                         (check "Allow write access")
# desk-mirror-key       → paste into the space's settings page,
#                         "advanced: per-space deploy key" (write-only, never
#                         shown again once saved)
```

Use an `ssh://` or `git@github.com:...` remote URL for this space so Desk
picks the SSH credential path. Clearing the override falls back to the
instance PAT for that space.

## Reference: what actually mirrors

- **v1 mirrors `main` only** — not `proposals/*`, not any other ref. One
  mirror remote per space.
- Mirror-out fires after any write that advances `main`: a `git push` over
  the transport, a web-authored commit, an accepted proposal, and an accepted
  revision.
- `mirror_state` (`{lastMirroredSha, lastAttemptAt, lastError}`) is shown on
  the space settings page and is the only place to check mirror health;
  there's no separate alerting.
