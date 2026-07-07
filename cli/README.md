# desk CLI

Command-line interface for Desk. Zero dependencies — plain Node.js >= 20.

> **Publishing is `git push` (truth = git).** The CLI's **write** commands
> (`desk publish`, `desk unpublish`) were **retired in the Convergence
> fix-pass** — a doc is published by pushing it to the space's `main` branch and
> Desk re-renders within seconds; unpublish by deleting the file and pushing. See
> the repo `README.md` "Publishing" section. The CLI keeps the **read + share**
> surface below. (Running a retired command prints a pointer to `git push` and
> exits non-zero.)

## Install

One line, no clone (downloads `desk.mjs` + `lib/config.mjs`, drops a `desk` launcher on your PATH):

```bash
curl -fsSL https://raw.githubusercontent.com/lucrua/desk-public/main/cli/install.sh | sh
```

Or, from a clone, just alias it:

```bash
alias desk='node /path/to/desk/cli/desk.mjs'   # add to ~/.bashrc / ~/.zshrc
```

## Configure (Desk URL + auth)

Run once — saved to `~/.config/desk/config.json` (chmod 600, since it can hold a service-token secret):

```bash
desk config          # interactive: Desk URL + auth (dev role, or CF service token)
desk config show     # print the effective config (secret masked)

# non-interactive (automation / CI bootstrap):
desk config --hub-url https://desk.example.com \
  --client-id <cf-client-id> --client-secret <cf-client-secret>
```

**Precedence is always ENV > config file > default** — an exported `HUB_URL` / `CF_ACCESS_*` / `HUB_DEV_ROLE` overrides the saved file, so CI can stay env-only. Relocate the file with `DESK_CONFIG`.

## Commands

### `desk config [show]`

Configure the Desk URL + auth (see [Configure](#configure-desk-url--auth) above). Interactive by default; `show` prints the effective config with the secret masked; flag form (`--hub-url` / `--client-id` / `--client-secret` / `--dev-role`) is non-interactive.

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
- `canon ahead (push?)` — local file differs (push it: `git push <remote> HEAD:main`)
- `source file not found (tried: ...)` — file not found at either path

### `desk help`

Print usage.

## Environment variables

All override the saved `desk config` file (ENV > config file > default), so CI can stay env-only.

| Variable | Default | Description |
|----------|---------|-------------|
| `HUB_URL` | `http://localhost:3000` | Hub API base URL |
| `HUB_DEV_ROLE` | `admin` | Dev-mode role sent via `x-dev-role` header |
| `CF_ACCESS_CLIENT_ID` | — | Cloudflare Access service token client id |
| `CF_ACCESS_CLIENT_SECRET` | — | Cloudflare Access service token secret |
| `DESK_CONFIG` | `~/.config/desk/config.json` | Override the `desk config` file path |

If `CF_ACCESS_CLIENT_ID` **and** `CF_ACCESS_CLIENT_SECRET` are both set, Cloudflare Access headers are sent instead of `x-dev-role`.

## Examples

### Publish (git push — not a CLI command)

```bash
# Mint a principal token in the UI (/settings/tokens), then push to main.
git remote add desk https://git:<token>@<host>/api/git/<owner>/<space>.git
git push desk HEAD:main            # Desk re-renders within seconds
```

### Read + share (local dev)

```bash
# Share a doc with an expiry
desk share overview --label "Partner review" --expires 7

# Revoke by label
desk revoke "Partner review"

# See everything
desk list

# Check local files vs published
desk status
```

### Production (Cloudflare Access service token)

```bash
export HUB_URL=https://desk.example.com
export CF_ACCESS_CLIENT_ID=your-client-id
export CF_ACCESS_CLIENT_SECRET=your-client-secret

desk list
```

## Notes

- **Share URLs are shown exactly once.** After creation, only the numeric id and label are stored. There is no way to recover the raw URL — create a new share if you lose it.
