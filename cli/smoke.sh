#!/usr/bin/env bash
# smoke.sh — end-to-end smoke test for hub CLI
# Boots pnpm dev, exercises all main commands, then kills the server.
set -euo pipefail

HUB="${HUB:-node ~/desk/cli/desk.mjs}"
HUB_URL="${HUB_URL:-http://localhost:3000}"
SMOKE_SLUG="smoke-test-context-$(date +%s)"
SHARE_LABEL="Smoke Pedro $(date +%s)"
TEST_FILE="$HOME/acme-growth/os/CONTEXT.md"
DEV_PID=""
PASS=0
FAIL=0

# ── Cleanup trap ─────────────────────────────────────────────────────────────

cleanup() {
  if [ -n "$DEV_PID" ]; then
    echo ""
    echo "[smoke] Killing dev server process group (pid $DEV_PID)..."
    # pnpm forks node/next children — kill by process group to catch them all.
    # We started pnpm dev in a new process group (setsid), so PGID == DEV_PID.
    kill -- "-$DEV_PID" 2>/dev/null || kill "$DEV_PID" 2>/dev/null || true
    # Also kill any stray next-server on port 3000 that survived
    local port_pid
    port_pid=$(ss -tlnp 2>/dev/null | grep -oP 'pid=\K[0-9]+(?=,fd)' | head -1) || true
    if [ -n "$port_pid" ]; then
      kill "$port_pid" 2>/dev/null || true
    fi
    wait "$DEV_PID" 2>/dev/null || true
    echo "[smoke] Dev server stopped."
  fi
}
trap cleanup EXIT

# ── Helpers ──────────────────────────────────────────────────────────────────

ok() {
  echo "[PASS] $1"
  PASS=$((PASS + 1))
}

fail() {
  echo "[FAIL] $1"
  FAIL=$((FAIL + 1))
}

assert_contains() {
  local label="$1"
  local output="$2"
  local pattern="$3"
  if echo "$output" | grep -q "$pattern"; then
    ok "$label"
  else
    fail "$label (expected pattern: $pattern)"
    echo "       Output was: $output"
  fi
}

assert_not_contains() {
  local label="$1"
  local output="$2"
  local pattern="$3"
  if echo "$output" | grep -q "$pattern"; then
    fail "$label (did not expect pattern: $pattern)"
    echo "       Output was: $output"
  else
    ok "$label"
  fi
}

# ── Boot dev server ──────────────────────────────────────────────────────────

echo "[smoke] Checking if port 3000 is already in use..."
if ss -tlnp 2>/dev/null | grep -q ':3000 '; then
  echo "[smoke] ERROR: Port 3000 is already in use. Kill the existing server and retry."
  exit 1
fi

echo "[smoke] Starting pnpm dev..."
cd ~/desk
# setsid puts pnpm in its own process group so we can kill the whole tree at exit.
setsid pnpm dev > /tmp/hub-smoke-dev.log 2>&1 &
DEV_PID=$!
echo "[smoke] Dev server pid: $DEV_PID"

# Wait for the API to be ready (up to 60 seconds).
# We poll /api/docs (GET) specifically — Turbopack lazily compiles routes on
# first request, so the root / returning 200 is NOT sufficient. The API route
# may still be compiling (returns HTML 404) for several seconds after start.
echo -n "[smoke] Waiting for API to be ready"
for i in $(seq 1 120); do
  RESP=$(curl -s -o /dev/null -w "%{http_code}" -H "x-dev-role: admin" "$HUB_URL/api/docs" 2>/dev/null) || RESP="000"
  if [ "$RESP" = "200" ]; then
    echo " ready after ${i}×0.5s"
    break
  fi
  echo -n "."
  sleep 0.5
  if [ "$i" -eq 120 ]; then
    echo ""
    echo "[smoke] ERROR: API did not become ready within 60 seconds (last HTTP status: $RESP)."
    echo "[smoke] Dev log:"
    cat /tmp/hub-smoke-dev.log
    exit 1
  fi
done

# ── Test: desk help ────────────────────────────────────────────────────────────

echo ""
echo "[smoke] --- desk help ---"
HELP_OUT=$($HUB help)
assert_contains "desk help shows publish" "$HELP_OUT" "publish"
assert_contains "desk help shows share" "$HELP_OUT" "share"

# ── Test: publish new doc ─────────────────────────────────────────────────────

echo ""
echo "[smoke] --- desk publish (new) ---"
PUB1=$($HUB publish "$TEST_FILE" --audience pedro --slug "$SMOKE_SLUG" --source "$TEST_FILE")
echo "$PUB1"
assert_contains "publish new version" "$PUB1" "published $SMOKE_SLUG"
assert_contains "publish reports new version" "$PUB1" "new version"
assert_contains "publish returns hub URL" "$PUB1" "/docs/$SMOKE_SLUG"

# ── Test: re-publish same file (unchanged) ────────────────────────────────────

echo ""
echo "[smoke] --- desk publish (unchanged) ---"
PUB2=$($HUB publish "$TEST_FILE" --audience pedro --slug "$SMOKE_SLUG" --source "$TEST_FILE")
echo "$PUB2"
assert_contains "re-publish reports unchanged" "$PUB2" "unchanged"

# ── Test: share ───────────────────────────────────────────────────────────────

echo ""
echo "[smoke] --- desk share ---"
SHARE_OUT=$($HUB share "$SMOKE_SLUG" --label "$SHARE_LABEL")
echo "$SHARE_OUT"
assert_contains "share returns /s/ URL" "$SHARE_OUT" "/s/"
assert_contains "share warns URL shown once" "$SHARE_OUT" "shown once"

# Extract URL
SHARE_URL=$(echo "$SHARE_OUT" | grep "/s/")
echo "[smoke] Share URL: $SHARE_URL"

# ── Test: curl the share URL (should 200, non-empty) ──────────────────────────

echo ""
echo "[smoke] --- curl share URL ---"
CURL_BODY=$(curl -sf "$SHARE_URL")
if [ -n "$CURL_BODY" ]; then
  ok "share URL returns non-empty body"
else
  fail "share URL returned empty body"
fi

# ── Test: desk status (in sync after publish) ──────────────────────────────────

echo ""
echo "[smoke] --- desk status ---"
STATUS_OUT=$($HUB status)
echo "$STATUS_OUT"
assert_contains "status shows smoke slug" "$STATUS_OUT" "$SMOKE_SLUG"
assert_contains "status shows in sync" "$STATUS_OUT" "in sync"

# ── Test: desk list (shows the doc + share) ────────────────────────────────────

echo ""
echo "[smoke] --- desk list ---"
LIST_OUT=$($HUB list)
echo "$LIST_OUT"
assert_contains "list shows smoke slug" "$LIST_OUT" "$SMOKE_SLUG"
assert_contains "list shows share label" "$LIST_OUT" "$SHARE_LABEL"

# ── Test: revoke by label ─────────────────────────────────────────────────────

echo ""
echo "[smoke] --- desk revoke by label ---"
REVOKE_OUT=$($HUB revoke "$SHARE_LABEL")
echo "$REVOKE_OUT"
assert_contains "revoke by label" "$REVOKE_OUT" "revoked"

# ── Test: curl revoked share URL (should 404 / error) ────────────────────────

echo ""
echo "[smoke] --- curl revoked share URL (expect 404) ---"
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$SHARE_URL")
echo "[smoke] HTTP status for revoked share: $HTTP_STATUS"
if [ "$HTTP_STATUS" = "404" ]; then
  ok "revoked share returns 404"
else
  fail "revoked share returned $HTTP_STATUS (expected 404)"
fi

# ── Test: unpublish ───────────────────────────────────────────────────────────

echo ""
echo "[smoke] --- desk unpublish ---"
UNPUB_OUT=$($HUB unpublish "$SMOKE_SLUG")
echo "$UNPUB_OUT"
assert_contains "unpublish confirms slug" "$UNPUB_OUT" "unpublished $SMOKE_SLUG"

# ── Test: desk list shows doc as unpublished ───────────────────────────────────

echo ""
echo "[smoke] --- desk list after unpublish ---"
LIST2_OUT=$($HUB list)
echo "$LIST2_OUT"
assert_contains "list after unpublish shows unpublished marker" "$LIST2_OUT" "unpublished"

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
echo "================================"
echo "  PASS: $PASS  FAIL: $FAIL"
if [ "$FAIL" -eq 0 ]; then
  echo "  RESULT: PASS"
else
  echo "  RESULT: FAIL"
fi
echo "================================"

[ "$FAIL" -eq 0 ]
