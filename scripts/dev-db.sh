#!/bin/bash
# Dev-database fallback for environments without Docker (e.g. WSL when Docker
# Desktop is off). Runs an embedded Postgres on 127.0.0.1:5433 with data in
# ~/.desk-pg/data. Prefer `docker compose -f docker-compose.dev.yml up -d`
# when Docker is available — this script exists for when it isn't.
set -euo pipefail

DATA_DIR="${DESK_PG_DATA:-$HOME/.desk-pg/data}"
LOG="${DESK_PG_LOG:-$HOME/.desk-pg/server.log}"
EPG_DIR="/tmp/epg"

# (Re)install the embedded-postgres binaries if /tmp was wiped.
if ! find "$EPG_DIR" -name pg_ctl -path "*native*" 2>/dev/null | grep -q .; then
  echo "[dev-db] installing embedded-postgres into $EPG_DIR ..."
  mkdir -p "$EPG_DIR" && cd "$EPG_DIR"
  pnpm add embedded-postgres > /dev/null
fi

NATIVE=$(dirname "$(dirname "$(find "$EPG_DIR" -name pg_ctl -path "*native*" | head -1)")")

# pnpm blocks the package's postinstall, which creates the lib symlinks — recreate.
( cd "$NATIVE/lib" && for f in lib*.so.*.*; do
    base=$(echo "$f" | sed -E "s/(\.so\.[0-9]+)\.[0-9.]+$/\1/")
    [ -e "$base" ] || ln -s "$f" "$base"
  done )
chmod +x "$NATIVE/bin/"* 2>/dev/null || true
export LD_LIBRARY_PATH="$NATIVE/lib"

if "$NATIVE/bin/pg_ctl" -D "$DATA_DIR" status > /dev/null 2>&1; then
  echo "[dev-db] already running on 127.0.0.1:5433"
  exit 0
fi

if [ ! -f "$DATA_DIR/PG_VERSION" ]; then
  echo "[dev-db] initializing fresh data dir at $DATA_DIR"
  mkdir -p "$DATA_DIR"
  "$NATIVE/bin/initdb" -D "$DATA_DIR" -U hub --auth=trust > /dev/null
fi

"$NATIVE/bin/pg_ctl" -D "$DATA_DIR" -l "$LOG" -o "-p 5433 -k /tmp" start
echo "[dev-db] up on 127.0.0.1:5433 (databases: create hub/hub_test + migrate if fresh — see README)"
