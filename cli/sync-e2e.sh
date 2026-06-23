#!/usr/bin/env bash
# sync-e2e.sh — end-to-end acceptance for `desk sync` (sync-spec §8).
#
# Boots `pnpm dev` (AUTH_MODE=dev), simulates two machines A and B with separate
# sync manifests + separate local dirs pointed at the same hub, and walks the
# spec acceptance:
#   1. A links + pushes a file.
#   2. B links the same slug, syncs → pulls A's file.
#   3. A edits locally + syncs → pushes a new version.
#   4. B syncs → gets A's edit (clean pull).
#   5. A and B both edit NON-overlapping lines; A syncs (push), B syncs
#      (clean 3-way merge) → both converge, no revision.
#   6. A and B both edit the SAME line; A syncs (push), B syncs (conflict) →
#      a proposed revision is created and B's file == cloud HEAD.
# Asserts via the API that the revision exists. PASS/FAIL summary; trap-kills the
# server (process-group kill, mirrors smoke.sh).
set -uo pipefail

DESK="node ~/desk/cli/desk.mjs"
HUB_URL="${HUB_URL:-http://localhost:3000}"
export HUB_URL
WORK="$(mktemp -d /tmp/desk-sync-e2e.XXXXXX)"
MANIFEST_A="$WORK/manifest-a.json"
MANIFEST_B="$WORK/manifest-b.json"
DIR_A="$WORK/a"; mkdir -p "$DIR_A"
DIR_B="$WORK/b"; mkdir -p "$DIR_B"
SLUG="e2e-sync-$(date +%s)"
AUD="e2e-aud-$(date +%s | tail -c 6)"
DEV_PID=""
PASS=0
FAIL=0

cleanup() {
  if [ -n "$DEV_PID" ]; then
    echo ""
    echo "[e2e] Killing dev server process group (pid $DEV_PID)..."
    kill -- "-$DEV_PID" 2>/dev/null || kill "$DEV_PID" 2>/dev/null || true
    wait "$DEV_PID" 2>/dev/null || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

ok()   { echo "[PASS] $1"; PASS=$((PASS + 1)); }
nope() { echo "[FAIL] $1"; FAIL=$((FAIL + 1)); [ -n "${2:-}" ] && echo "       $2"; }

# A acts as admin; B also admin unless overridden per-step.
A() { DESK_SYNC_MANIFEST="$MANIFEST_A" HUB_DEV_ROLE="${A_ROLE:-admin}" $DESK "$@"; }
B() { DESK_SYNC_MANIFEST="$MANIFEST_B" HUB_DEV_ROLE="${B_ROLE:-admin}" $DESK "$@"; }
api() { curl -s -H "x-dev-role: ${ROLE:-admin}" "$@"; }

# ── Boot dev server ──────────────────────────────────────────────────────────

if ss -tlnp 2>/dev/null | grep -q ':3000 '; then
  echo "[e2e] ERROR: Port 3000 in use. Kill the existing server and retry."
  exit 1
fi
echo "[e2e] Starting pnpm dev..."
cd ~/desk
setsid pnpm dev > /tmp/hub-sync-e2e-dev.log 2>&1 &
DEV_PID=$!
echo -n "[e2e] Waiting for API"
for i in $(seq 1 120); do
  RESP=$(curl -s -o /dev/null -w "%{http_code}" -H "x-dev-role: admin" "$HUB_URL/api/docs" 2>/dev/null) || RESP="000"
  [ "$RESP" = "200" ] && { echo " ready (${i}×0.5s)"; break; }
  echo -n "."; sleep 0.5
  [ "$i" -eq 120 ] && { echo ""; echo "[e2e] API never ready ($RESP)"; cat /tmp/hub-sync-e2e-dev.log; exit 1; }
done

# ── Setup: an audience that members can see (for the member-revision step) ────
api -X POST -H "content-type: application/json" \
  -d "{\"key\":\"$AUD\",\"label\":\"E2E\",\"memberVisible\":true}" \
  "$HUB_URL/api/audiences" > /dev/null

# ── 1. A creates a file, links, publishes via dir-mapping-free file link ──────
# We publish first (admin) so the slug exists, then link both machines.
printf 'line1\nline2\nline3\nline4\n' > "$DIR_A/file.md"
PUB=$(A publish "$DIR_A/file.md" --audience "$AUD" --slug "$SLUG" --source "file.md" 2>&1)
echo "$PUB" | grep -q "published $SLUG" && ok "1. A published initial doc" || nope "1. A publish" "$PUB"

# Link A and seed its state by syncing (should be in-sync/noop or push noop).
A sync link "$SLUG" "$DIR_A/file.md" > /dev/null
SYNC_A1=$(A sync 2>&1); echo "[e2e] A sync(1): $SYNC_A1"

# ── 2. B links same slug, syncs → pulls A's file ─────────────────────────────
B sync link "$SLUG" "$DIR_B/file.md" > /dev/null
SYNC_B1=$(B sync 2>&1); echo "[e2e] B sync(1): $SYNC_B1"
if [ -f "$DIR_B/file.md" ] && diff -q "$DIR_A/file.md" "$DIR_B/file.md" > /dev/null; then
  ok "2. B pulled A's file (replicas identical)"
else
  nope "2. B pull" "B file: $(cat "$DIR_B/file.md" 2>/dev/null)"
fi

# ── 3. A edits locally + syncs → pushes a new version ────────────────────────
printf 'line1\nline2-EDITED-BY-A\nline3\nline4\n' > "$DIR_A/file.md"
SYNC_A2=$(A sync 2>&1); echo "[e2e] A sync(2): $SYNC_A2"
echo "$SYNC_A2" | grep -qE "pushed → v[0-9]+" && ok "3. A pushed local edit" || nope "3. A push" "$SYNC_A2"

# ── 4. B syncs → gets A's edit (clean pull) ──────────────────────────────────
SYNC_B2=$(B sync 2>&1); echo "[e2e] B sync(2): $SYNC_B2"
if grep -q "line2-EDITED-BY-A" "$DIR_B/file.md"; then
  ok "4. B pulled A's edit"
else
  nope "4. B pull edit" "B file: $(cat "$DIR_B/file.md")"
fi

# ── 5. Non-overlapping edits → clean 3-way merge converges ───────────────────
# A edits line1; B edits line4. A pushes; B's sync merges cleanly.
printf 'line1-A\nline2-EDITED-BY-A\nline3\nline4\n' > "$DIR_A/file.md"
printf 'line1\nline2-EDITED-BY-A\nline3\nline4-B\n' > "$DIR_B/file.md"
SYNC_A3=$(A sync 2>&1); echo "[e2e] A sync(3): $SYNC_A3"
echo "$SYNC_A3" | grep -qE "pushed → v[0-9]+" && ok "5a. A pushed non-overlap edit" || nope "5a. A push" "$SYNC_A3"
SYNC_B3=$(B sync 2>&1); echo "[e2e] B sync(3): $SYNC_B3"
if echo "$SYNC_B3" | grep -qE "merged \+ pushed → v[0-9]+"; then
  if grep -q "line1-A" "$DIR_B/file.md" && grep -q "line4-B" "$DIR_B/file.md"; then
    ok "5b. B clean 3-way merge converged (both edits present)"
  else
    nope "5b. B merge content" "B file: $(cat "$DIR_B/file.md")"
  fi
else
  nope "5b. B clean merge" "$SYNC_B3"
fi
# A pulls the merged HEAD to converge.
SYNC_A4=$(A sync 2>&1); echo "[e2e] A sync(4): $SYNC_A4"
if grep -q "line1-A" "$DIR_A/file.md" && grep -q "line4-B" "$DIR_A/file.md"; then
  ok "5c. A converged on merged HEAD"
else
  nope "5c. A converge" "A file: $(cat "$DIR_A/file.md")"
fi

# Count revisions BEFORE the conflict step (should be 0 — no conflict yet).
REV_BEFORE=$(api "$HUB_URL/api/docs/$SLUG/revisions" | grep -o '"id"' | wc -l)
echo "[e2e] revisions before conflict step: $REV_BEFORE"

# ── 6. Overlapping edits → conflict → proposed revision; B == cloud HEAD ─────
# Both edit the SAME line (line3). A pushes first; B's sync conflicts.
sed -i 's/^line3$/line3-CHANGED-BY-A/' "$DIR_A/file.md"
sed -i 's/^line3$/line3-CHANGED-BY-B/' "$DIR_B/file.md"
SYNC_A5=$(A sync 2>&1); echo "[e2e] A sync(5): $SYNC_A5"
echo "$SYNC_A5" | grep -qE "pushed → v[0-9]+" && ok "6a. A pushed conflicting edit" || nope "6a. A push" "$SYNC_A5"
SYNC_B5=$(B sync 2>&1); echo "[e2e] B sync(5): $SYNC_B5"
echo "$SYNC_B5" | grep -qi "proposed revision" && ok "6b. B reported a proposed revision on conflict" || nope "6b. B conflict" "$SYNC_B5"

# B's file must equal cloud HEAD (A's version) — i.e. line3-CHANGED-BY-A, not B.
HEAD_CONTENT=$(api "$HUB_URL/api/docs/$SLUG" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).currentVersion.content)}catch{process.exit(1)}})')
if [ "$(cat "$DIR_B/file.md")" = "$HEAD_CONTENT" ]; then
  ok "6c. B file == cloud HEAD after conflict"
else
  nope "6c. B == HEAD" "B: $(cat "$DIR_B/file.md")\n---\nHEAD: $HEAD_CONTENT"
fi

# Assert a NEW revision now exists (conflict filed one).
REV_AFTER=$(api "$HUB_URL/api/docs/$SLUG/revisions" | grep -o '"id"' | wc -l)
echo "[e2e] revisions after conflict step: $REV_AFTER"
if [ "$REV_AFTER" -gt "$REV_BEFORE" ]; then
  ok "6d. a proposed revision exists in the API after conflict"
else
  nope "6d. revision created" "before=$REV_BEFORE after=$REV_AFTER"
fi

# ── 7. Member edit arrives as a revision (permission == conflict model) ──────
# B acts as a member, edits, syncs → revision regardless of clean state.
REV_PRE_MEMBER=$(api "$HUB_URL/api/docs/$SLUG/revisions" | grep -o '"id"' | wc -l)
printf 'member-line\n%s' "$(cat "$DIR_B/file.md")" > "$DIR_B/file.md.new" && mv "$DIR_B/file.md.new" "$DIR_B/file.md"
SYNC_BM=$(B_ROLE=member B sync 2>&1); echo "[e2e] B(member) sync: $SYNC_BM"
echo "$SYNC_BM" | grep -qi "proposed revision" && ok "7a. member edit filed as a revision" || nope "7a. member revision" "$SYNC_BM"
REV_POST_MEMBER=$(api "$HUB_URL/api/docs/$SLUG/revisions" | grep -o '"id"' | wc -l)
if [ "$REV_POST_MEMBER" -gt "$REV_PRE_MEMBER" ]; then
  ok "7b. member revision recorded in the API"
else
  nope "7b. member revision recorded" "pre=$REV_PRE_MEMBER post=$REV_POST_MEMBER"
fi

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════"
echo "  desk sync E2E:  $PASS passed, $FAIL failed"
echo "════════════════════════════════════════"
[ "$FAIL" -eq 0 ]
