# Desk — cloud cutover checklist

Supervised runbook for going live on a Coolify-managed VPS. Run with an operator present; each step is a checkbox. Complete every check before calling the cutover done.

Prereqs: local build green (`pnpm build`), test suite green (`pnpm vitest run`), typecheck clean (`pnpm typecheck`). This checklist assumes the repo is on GitHub and `<server>` is reachable via SSH.

> **Example values:** server = `server-1`, admin email = `lucas@example.org`, desk host = `desk.example.net`, share host = `share.example.net`. Substitute your values where `<placeholders>` appear.

---

## A. Coolify — provision the app

- [ ] Open Coolify at `https://coolify.<server>` (or whichever admin URL is configured).
- [ ] **New resource → Application → From a Git repository.** Point to the `desk` repo; branch `main`; build command `pnpm build`; start command `pnpm start`.
- [ ] Under **Build settings**, set the Node version to 20+ (or set `NIXPACKS_NODE_VERSION=20` in environment variables).
- [ ] Under **Environment variables**, add all required vars (see table below). Mark every secret as "Secret" so Coolify encrypts it at rest.

  | Variable | Value | Notes |
  |---|---|---|
  | `AUTH_MODE` | `cloudflare` | Enables CF JWT verification; refuses to start in production if set to `dev` |
  | `ADMIN_EMAIL` | `<your-admin-email>` | Upgrade aid only — promotes this email to admin on first boot after upgrading to admin model v2; remove after first deploy confirms admin access. Leave unset for fresh deployments (first sign-in auto-bootstraps). |
  | `CF_TEAM_DOMAIN` | `<team>.cloudflareaccess.com` | From CF Access → Settings → Team Domain |
  | `CF_AUD` | *(copy from CF Access app tag — step B below)* | The audience tag for the `desk.<domain>` Access application |
  | `SHARE_HOST` | `share.<domain>` | Bare hostname, no scheme/port |
  | `DATABASE_URL` | `postgres://hub:…@coolify-postgres:5432/hub` | Connection string to the Coolify Postgres service (step A2 below) |
  | `HUB_BASE_URL` | `https://desk.<domain>` | Used by the CLI and for absolute URL generation |
  | `SHARE_BASE_URL` | `https://share.<domain>` | Used when minting capability share links |
  | `DESK_DATA_DIR` | `/data/desk` (a backed-up volume) | **Root for the bare space git repos — these are the canon.** Mount a persistent, OFF-BOX-backed-up volume here (NO-BACKUPS risk). Defaults to `<cwd>/.desk-data` if unset, which is ephemeral on a container redeploy — do not rely on the default in prod. |
  | `GIT_HTTP_BACKEND_BIN` | *(usually unset)* | Path to `git-http-backend` if it isn't at `/usr/lib/git-core/git-http-backend`. Ensure system `git` is in the deploy image and on `PATH`. |
  | `DESK_TOKEN_KEY` | `<openssl rand -base64 32>` | Optional — enables copy/reveal of existing share links (AES-256-GCM at rest). Without it shares still work; they just can't be re-copied from the UI. |

- [ ] **(A1b) Healthcheck.** Point Coolify's container healthcheck at `GET /api/health` (e.g. `curl -fsS http://localhost:3000/api/health`). It needs no auth and touches no DB — it returns `{ ok: true, version }` (the package.json version) as soon as the process is up, so deploy watchers stop racing the boot and a wedged DB doesn't mark the app unhealthy.
- [ ] **(A2) Postgres 16 service.** In Coolify: New resource → Database → PostgreSQL 16. Note the internal connection string. Create a database named `hub` and a user `hub` with a strong password. Paste the full connection string into `DATABASE_URL` above.
- [ ] Deploy once to confirm the build succeeds (it will fail at DB connection before migration — that's expected; proceed to A3).
- [ ] **(A3) Run migrations.** SSH into `<server>`:
  ```bash
  ssh <server>
  # From the Coolify app's working directory, or via a one-off container:
  DATABASE_URL="<the real connection string>" npx drizzle-kit migrate
  ```
  Verify output: `migrations applied successfully!`
- [ ] Redeploy the app in Coolify; confirm it starts cleanly (check logs for `ready` — no auth errors at boot).

---

## B. Cloudflare — tunnels and Access

- [ ] Open the Cloudflare dashboard → Zero Trust → Networks → Tunnels. Confirm the existing `cloudflared` tunnel for `<server>` is healthy.
- [ ] **Add two public hostnames to the tunnel:**
  - `desk.<domain>` → service `http://desk:3000` (or whatever the Coolify internal hostname/port is).
  - `share.<domain>` → service `http://desk:3000` (same app, different hostname — routing is done in the middleware).
- [ ] **CF Access application — desk host only.**
  - Create a new Access application for `desk.<domain>` only.
  - Policy: allow by email. Add your admin email and any other team emails to the explicit allowlist.
  - Session duration: 7 days (or as your policy requires).
  - Under **Overview**, copy the **Application Audience (AUD) tag** → paste into `CF_AUD` env var in Coolify (step A).
  - **NOTE: do NOT create an Access application for `share.<domain>`.** That hostname is intentionally unprotected by CF Access — the capability token in the URL is the credential. Adding an Access policy there would break unauthenticated partner links.
- [ ] **Let the git transport through the wall.** A `git` CLI authenticates with HTTP Basic (the principal token), NOT a CF-Access JWT, so the `desk.<domain>` Access app must not block `/api/git/*`. Add a **bypass / service-auth** path rule on the Access application so requests to `desk.<domain>/api/git/*` reach the app's own token gate (which enforces the per-space read/write ACL and returns a uniform 404 on no-access). Without this, `git clone`/`git push` over the token will fail at the CF wall. *(This is the one integration point that can't be verified headlessly — confirm it with the clone/push smoke in section D.)*
- [ ] **Service token for CLI access.**
  - CF Access → Access → Service Auth → Create Service Token. Name it descriptively (e.g. `desk-agent`).
  - Copy the `CF-Access-Client-Id` and `CF-Access-Client-Secret` values — they are shown exactly once.
  - Add the service token to the `desk.<domain>` Access policy (add a second rule: Service Token = your token name).
  - Store the two values in your shell profile for CLI use:
    ```bash
    export CF_ACCESS_CLIENT_ID=…
    export CF_ACCESS_CLIENT_SECRET=…
    ```
- [ ] Confirm DNS: both `desk.<domain>` and `share.<domain>` resolve through the Cloudflare proxy (orange cloud).

---

## C. Seed the users table

**Note:** The admin row no longer needs to be manually seeded. On first sign-in on a fresh deployment, the first CF-verified email automatically becomes admin (first-login bootstrap). For existing deployments upgrading from admin model v1, set `ADMIN_EMAIL` to your email for the first deploy — the boot-time backfill will promote it to admin, after which you can remove `ADMIN_EMAIL`. This step is only needed to pre-seed the CLI service token or additional users.

- [ ] Connect to the hub Postgres:
  ```bash
  ssh <server>
  psql "$DATABASE_URL"
  ```
- [ ] *(Optional)* Pre-seed the CLI service token:
  ```sql
  INSERT INTO users (token_name, display_name, role)
  VALUES ('<your-token-name>', '<token display name>', 'admin')
  ON CONFLICT (token_name) DO NOTHING;
  ```
  *(Schema note: `token_name` is the service token identifier column. Verify with `\d users`.)*
- [ ] *(Optional)* Verify rows:
  ```sql
  SELECT email, token_name, display_name, role FROM users;
  ```

---

## D. Smoke tests

Run these in order. Each must pass before moving to the next.

- [ ] **Agent curl to `/api/docs` (CF-protected):**
  ```bash
  curl -s -o /dev/null -w "%{http_code}" \
    -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
    -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
    https://desk.<domain>/api/docs
  ```
  Expect: `200`.

- [ ] **Publish a test doc via CLI:**
  ```bash
  export HUB_URL=https://desk.<domain>
  desk publish /path/to/any/file.md --slug smoke-test
  ```
  Expect: `published smoke-test v1 (new version)` + a hub URL. *(Read access is space-scoped now — there is no `--audience` flag.)*

- [ ] **Git transport — clone & push (the Gen-2 publish path).** Mint a principal token at `https://desk.<domain>/settings/tokens` (shown once), then:
  ```bash
  git clone https://git:<token>@desk.<domain>/api/git/<owner>/<space>.git
  # edit a file, commit, then publish by pushing to main:
  git -C <space> push origin HEAD:main
  ```
  Expect: the clone succeeds with a writer/owner token; the push re-renders the changed doc on the hub within seconds. A **reader** token can clone but the push is rejected. An anonymous/invalid token on a private space returns a uniform 404 (no existence leak). *(If the clone hangs or 403s at the edge, revisit the section-B git-transport bypass.)*

- [ ] **Create a share link:**
  ```bash
  desk share smoke-test --label "smoke" --expires 1
  ```
  Copy the `share.<domain>/s/…` URL. Open it in a phone browser (no CF login) — confirm the doc renders correctly.

- [ ] **View appears in admin log.** Open `https://desk.<domain>/admin` in the browser (CF login prompt → sign in as your admin email). Navigate to the smoke-test doc → confirm the view row appears (timestamp, UA, IP).

- [ ] **Revoke kills the link.** In the admin UI (or via CLI: `desk revoke smoke`), revoke the share. Reload the `share.<domain>/s/…` URL — confirm it returns the styled "There's nothing at this address." page with HTTP 404 (use DevTools or `curl -s -o /dev/null -w "%{http_code}" <url>` to verify the status code).

- [ ] **Share host blocks operator surfaces.** Verify the host-guard middleware:
  ```bash
  curl -s -o /dev/null -w "%{http_code}" https://share.<domain>/admin
  curl -s -o /dev/null -w "%{http_code}" https://share.<domain>/docs
  curl -s -o /dev/null -w "%{http_code}" https://share.<domain>/api/docs
  ```
  All three must return `404`.

- [ ] **Sign-out link.** Open `https://desk.<domain>` in the browser. Find the CF-injected sign-out link or navigate to `https://desk.<domain>/cdn-cgi/access/logout` — confirm it signs you out and redirects to the CF login screen.

- [ ] **Unpublish cleans up.** Run:
  ```bash
  desk unpublish smoke-test
  ```
  Confirm the hub URL (`https://desk.<domain>/docs/smoke-test`) returns 404.

---

## E. Backups

> **Two things to back up, and the order of importance is the opposite of Gen-1.**
> In Gen-2 the **bare git repos under `DESK_DATA_DIR` are the canon** — lose them
> and you lose every document. Postgres is a *rebuildable projection* (render
> cache + indexes) **plus** the native feedback/access data (comments, approvals,
> shares, view-tracking, access requests) that has no file. Back up **both**: the
> repos so documents survive, the DB so feedback + access config survive.

- [ ] **Nightly bare-repo backup (the canon).** Mirror or archive the space repos off-box:
  ```bash
  # /etc/cron.d/desk-repos-backup
  0 3 * * * tar -czf /var/backups/desk/repos-$(date +\%Y\%m\%d).tar.gz -C "$DESK_DATA_DIR" spaces 2>&1
  ```
  Because each space is a bare git repo, a `git clone --mirror` / `git push --mirror` to a second host is an equivalent (and incrementally cheap) off-box copy. Create `/var/backups/desk/` with appropriate permissions.

- [ ] **Nightly `pg_dump` cron on `<server>`.** Add a cron job (as root or the postgres user):
  ```bash
  # /etc/cron.d/hub-backup  (or crontab -e)
  0 3 * * * pg_dump "$DATABASE_URL" | gzip > /var/backups/hub/hub-$(date +\%Y\%m\%d).sql.gz 2>&1
  ```
  Create `/var/backups/hub/` with appropriate permissions. Test manually: `pg_dump "$DATABASE_URL" | gzip > /tmp/hub-test.sql.gz && ls -lh /tmp/hub-test.sql.gz`.

- [ ] **Offsite copy — TBD.** The destination (S3 bucket, Backblaze B2, or rclone to another host) is a shared decision with the engagement service, which runs on the same box and has the same open backup question (design.md §15 / engagement-service design §11). Mark this as pending and align when provisioning the engagement service.

- [ ] **Verify restore path (optional but recommended).** Restore the test dump to a scratch DB and confirm `drizzle-kit migrate` + a `desk list` against it returns clean output.

---

## F. Rollback

If anything goes wrong post-cutover:

- [ ] In Coolify → the hub app → **Deployments** → select the last known-good deployment → **Redeploy**. Coolify rolls back to that image instantly.
- [ ] DNS cutover is instant (CF tunnel hostname can be deleted or re-pointed in the CF dashboard).
- [ ] DB state is additive (migrations are only `CREATE TABLE / ALTER TABLE ADD COLUMN`) — rolling back the app does not require rolling back the DB unless a migration in the bad deploy added incompatible columns. Check migration history with `\d` in psql if unsure.

---

*All steps done? Cutover complete. Delete this checklist's `[ ]` tracking note from STATUS.md and add a dated entry there.*
