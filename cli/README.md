# desk CLI

Command-line interface for Desk. Zero dependencies — plain Node.js >= 20.

> **Note (Gen-2 consolidation): `--audience` is vestigial.** Read access is now
> **space-scoped** — a doc is visible by space membership, the space's
> public/unlisted visibility, or a capability share. The `--audience` flag (and
> `link-dir --audience`) is still accepted for backward compatibility but the
> value is **stored unread** and does not govern who can see a doc. The primary
> publish path is now `git push … HEAD:main` to a space; `desk publish` remains a
> convenient single-file equivalent. See the repo `README.md` for the full model.

## Setup

```bash
# Adjust the path to wherever you cloned the repo.
alias desk='node /path/to/desk/cli/desk.mjs'
```

Add that line to your `~/.bashrc` or `~/.zshrc` for persistence.

## Commands

### `desk publish <file> [--audience <a>] [options]`

Publish a local file to the Hub.

| Option | Default | Description |
|--------|---------|-------------|
| `--audience <a>` | `private` | Audience tag (e.g. `pedro`, `team`, `internal`). Optional — omit to publish as `private` (only you + admins + members added to the audience group). |
| `--slug <s>` | filename stem, slugified | URL slug — must match `^[a-z0-9][a-z0-9-]*$` |
| `--title <t>` | first `# heading` (md) or filename stem | Doc title |
| `--source <path>` | the file path as given | Stored as `sourcePath` for status tracking |

Format is inferred from extension: `.md` → `md`, `.html`/`.htm` → `html`.

Output: `published <slug> v<id> (new version|unchanged)` followed by the Hub URL.

### `desk unpublish <slug>`

Mark a doc as unpublished (soft delete). The doc remains in the database.

### `desk share <slug> --label <label> [--expires <days>]`

Create a capability share link for a published doc.

**The URL is printed exactly once — copy it immediately.**

### `desk revoke <id-or-label>`

Revoke a share link. If the argument is all-digits it is treated as a numeric share id; otherwise it is matched against active share labels (ambiguous label → error listing matches).

### `desk list`

Print aligned plain-text tables of all docs and all shares.

### `desk status`

For each doc, resolve `sourcePath` relative to `cwd`, then `$HOME/<repo-name>/<sourcePath>` (a fallback path for repos stored in `$HOME`), and compare the local file's sha256 to the published version hash. Output per doc:

- `in sync` — file matches the published version
- `canon ahead — re-publish?` — local file differs
- `source file not found (tried: ...)` — file not found at either path

### `desk sync …` — keep local files in step with cloud canon

`desk sync` makes the cloud copy of a doc the source of truth and converges a
local file (or a whole folder) to it on demand. Unlike `publish`/`status` (which
are one-way, repo-canon), a *linked* file is bidirectional: local edits push up,
cloud edits pull down, and edits on both sides are merged.

| Subcommand | What it does |
|------------|--------------|
| `desk sync link <slug> <localPath>` | Map a cloud doc (by slug) to a local file. |
| `desk sync link-dir <cloudPrefix> <localDir> [--audience <a>]` | Map a cloud folder prefix to a local directory (admin). New docs are adopted both ways. |
| `desk sync unlink <slug\|prefix>` | Stop syncing a file/dir. **The local file is kept** — only the mapping is removed. |
| `desk sync status [--json]` | Table of every linked file: local / remote / base state, the pending action, last synced version. |
| `desk sync [--dry-run] [--json]` | One-shot convergence of every linked file/dir. `--dry-run` plans without touching anything. |

**Per-file algorithm.** On each `desk sync`, for every linked file:

- **neither side changed** → no-op
- **local only** → `push` with the last-synced version as the optimistic base (a 409 race re-enters as both-changed)
- **remote only** → `pull` (atomic write) and advance the state
- **both changed** → fetch the last-synced version as the common base and do a 3-way merge (`git merge-file` when git is on `PATH`, otherwise a bundled JS diff3):
  - *clean* → push the merged result (base-checked against cloud HEAD)
  - *conflict* → file the local content as a **proposed revision** (`note: "sync conflict from <host>"`), then set the local file to cloud HEAD. Sync never blocks on a conflict — the existing review queue resolves it.

**Member tokens** (`HUB_DEV_ROLE=member`, or a member CF service token) always file pushes as proposed revisions — permission model = conflict model.

**Folders (`link-dir`).** New cloud docs under the prefix are written locally; new local `.md`/`.html` files are published under the prefix to the prefix's `--audience` (admin; defaults to `private` when none is given) — a member sees a skip notice instead. A doc unpublished on the cloud side keeps the local file and drops its mapping with a loud notice (sync never deletes local data).

```bash
desk sync link overview ~/docs/overview.md     # link a slug ↔ a local file
desk sync                                       # converge everything
desk sync status                                # what would change, per file
desk sync --dry-run                             # plan only

desk sync link-dir os ~/work/os --audience team # link a folder (admin)
desk sync unlink overview                        # stop syncing, keep the file
```

The manifest lives at `~/.config/desk/sync.json` (override with `DESK_SYNC_MANIFEST`). Each machine is an independent replica that converges through the hub — no cross-machine coordination. Writes are atomic (tmp + rename); state is persisted only after the server/file action confirms; a corrupt state file is treated as "both changed" (safe — worst case is an extra revision).

The end-to-end acceptance walk lives in `cli/sync-e2e.sh` (boots `pnpm dev`, simulates two machines, exercises push/pull/merge/conflict/member-revision).

### `desk help`

Print usage.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `HUB_URL` | `http://localhost:3000` | Hub API base URL |
| `HUB_DEV_ROLE` | `admin` | Dev-mode role sent via `x-dev-role` header (`member` → sync pushes become proposed revisions) |
| `CF_ACCESS_CLIENT_ID` | — | Cloudflare Access service token client id |
| `CF_ACCESS_CLIENT_SECRET` | — | Cloudflare Access service token secret |
| `DESK_SYNC_MANIFEST` | `~/.config/desk/sync.json` | Override the `desk sync` manifest path (used by tests + multi-profile setups) |

If `CF_ACCESS_CLIENT_ID` **and** `CF_ACCESS_CLIENT_SECRET` are both set, Cloudflare Access headers are sent instead of `x-dev-role`.

## Examples

### Local dev

```bash
# Publish a markdown doc for audience "team"
desk publish ~/docs/overview.md --audience team

# Re-publish (unchanged → no new version)
desk publish ~/docs/overview.md --audience team

# Share it with an expiry
desk share overview --label "Partner review" --expires 7

# Revoke by label
desk revoke "Partner review"

# See everything
desk list

# Check local files vs published
desk status

# Unpublish
desk unpublish overview

# Two-way sync: link a doc, then converge it on demand
desk sync link overview ~/docs/overview.md
desk sync status
desk sync
```

### Production (Cloudflare Access service token)

```bash
export HUB_URL=https://desk.example.com
export CF_ACCESS_CLIENT_ID=your-client-id
export CF_ACCESS_CLIENT_SECRET=your-client-secret

desk publish docs/overview.md --audience team --slug overview
desk list
```

## Notes

- **Share URLs are shown exactly once.** After creation, only the numeric id and label are stored. There is no way to recover the raw URL — create a new share if you lose it.
- Slug derivation: non-`[a-z0-9-]` characters are replaced with `-`, consecutive dashes collapsed, leading/trailing dashes trimmed. Example: `Bräzil File.MD` → stem `Bräzil File` → `br-zil-file`. Provide `--slug` explicitly for non-ASCII filenames.
- The smoke test (`smoke.sh`) writes rows into the dev database (`hub`, not `hub_test`). It cleans up by unpublishing, but rows remain in the DB.
