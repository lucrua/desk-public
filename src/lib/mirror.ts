/**
 * GitHub mirror-out mechanism (convergence fix-pass, Slice 4b; decisions
 * D-C3/D-C4/D-C5). One-way, conflict-free-by-construction backup of a `hosted`
 * space's canon: after `main` advances, Desk pushes `main:main` to the space's
 * paired GitHub repo. The other side is read-only — a `mirrored` space instead
 * RECEIVES its canon from GitHub (the transport push), and this module never
 * pushes out for it.
 *
 * CREDENTIALS ARE INJECTED PER-INVOCATION AND NEVER PERSIST (D-C5):
 *   - We push with `git push <url> main:main`, passing the URL as an ARGUMENT —
 *     we never `git remote add` / `git config`, so nothing lands in the repo's
 *     `.git/config`.
 *   - PAT (https): the token is passed to git via a GIT_ASKPASS helper that reads
 *     it from the child process's ENV (`DESK_MIRROR_TOKEN`). The helper script
 *     contains NO secret (just `printf '%s' "$DESK_MIRROR_TOKEN"`), and the URL
 *     carries only the non-secret username `x-access-token@…`. So the PAT is
 *     never in argv, never in config, never written to disk as plaintext.
 *   - Deploy key (ssh): the decrypted PRIVATE key is written to a `chmod 600`
 *     temp file referenced by `GIT_SSH_COMMAND`, and the file is DELETED in a
 *     `finally` (even on throw).
 *   - A `file://` / local remote (the test fixture, and local mirrors) needs no
 *     credential and is pushed directly.
 *   Preference: a per-space deploy key wins over the instance PAT when present.
 *
 * FAIL-SOFT: every attempt records `mirror_state` (lastMirroredSha / lastAttemptAt
 * / lastError) and NEVER throws into the triggering write — `enqueueMirror` is the
 * same log-and-continue posture as the post-push reindex.
 */
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { spaces, users, type MirrorState } from "@/db/schema";
import { decryptToken, encryptToken } from "@/lib/crypto";
import {
  getSpaceBySlug,
  getSpaceById,
  ownerSlugForUser,
  type SpaceRow,
} from "@/lib/spaces";
import { getInstanceGithubPat } from "@/lib/instance-settings";
import { bareRepoPath, refTip, runGit, DEFAULT_BRANCH } from "@/lib/git/repo";

// Re-export for convenience (callers already import SpaceRow/MirrorState via
// their own paths, but the mirror surface is self-contained here).
export type { MirrorState } from "@/db/schema";

/** Resolve the on-disk bare-repo path for a space row (mirrors web-author /
 * proposals-service / materialize — identical derivation → identical path). */
async function repoPathForSpace(space: SpaceRow): Promise<string> {
  const owner = await db.query.users.findFirst({ where: eq(users.id, space.ownerUserId) });
  const ownerSlug = ownerSlugForUser(owner ?? null, space.ownerUserId);
  return bareRepoPath(ownerSlug, space.slug);
}

type RemoteScheme = "https" | "ssh" | "local";

/** Classify a mirror remote URL to decide which credential (if any) it needs.
 * Exported for the egress-proof tests. */
export function classifyRemote(url: string): RemoteScheme {
  if (/^https?:\/\//i.test(url)) return "https";
  if (/^ssh:\/\//i.test(url) || /^[^\s/@]+@[^\s/:]+:/.test(url)) return "ssh"; // git@host:owner/repo
  // file:// URLs, absolute paths, and relative paths are local — no auth needed.
  if (/^file:\/\//i.test(url) || url.startsWith("/") || url.startsWith("./") || url.startsWith("../")) {
    return "local";
  }
  // Anything unrecognised is treated as local (pushed directly; git decides).
  return "local";
}

/** Add a non-secret `x-access-token@` username to an https URL that has none, so
 * git prompts only for the PASSWORD (which GIT_ASKPASS supplies). Never embeds
 * the token itself. Exported for the egress-proof tests. */
export function injectHttpsUsername(url: string): string {
  const m = /^(https?:\/\/)([^/].*)$/i.exec(url);
  if (!m) return url;
  if (m[2].includes("@")) return url; // caller already supplied userinfo
  return `${m[1]}x-access-token@${m[2]}`;
}

/** Cap a git stderr string so a stored lastError can't balloon the row. */
function truncateErr(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > 500 ? flat.slice(0, 500) + "…" : flat || "git push failed";
}

/** Persist a mirror_state onto the space row (best-effort — a persist failure is
 * logged, never thrown), and return it. */
async function persist(spaceId: number, state: MirrorState): Promise<MirrorState> {
  try {
    await db.update(spaces).set({ mirrorState: state }).where(eq(spaces.id, spaceId));
  } catch (e) {
    console.error("[mirror] failed to persist mirror_state:", (e as Error)?.message);
  }
  return state;
}

/**
 * Push a space's `main` to its mirror remote ONCE, injecting the credential
 * per-invocation. Always records mirror_state and returns it; never throws.
 * Assumes the caller already decided the space is `hosted` with a remote URL
 * (mirrorNow / enqueueMirror gate that), but re-reads the URL defensively.
 */
export async function mirrorPush(space: SpaceRow): Promise<MirrorState> {
  const now = new Date().toISOString();
  const prev = (space.mirrorState ?? null) as MirrorState | null;
  const keepSha = prev?.lastMirroredSha ?? null;
  const remoteUrl = space.mirrorRemoteUrl;

  if (!remoteUrl) {
    return persist(space.id, {
      lastMirroredSha: keepSha,
      lastAttemptAt: now,
      lastError: "no mirror remote configured",
    });
  }

  let repoPath: string;
  try {
    repoPath = await repoPathForSpace(space);
  } catch (e) {
    return persist(space.id, {
      lastMirroredSha: keepSha,
      lastAttemptAt: now,
      lastError: `repo path error: ${(e as Error)?.message ?? "unknown"}`,
    });
  }

  const tip = await refTip(repoPath, DEFAULT_BRANCH);
  if (!tip) {
    return persist(space.id, {
      lastMirroredSha: keepSha,
      lastAttemptAt: now,
      lastError: "main has no commits to mirror yet",
    });
  }

  const scheme = classifyRemote(remoteUrl);
  const deployKey = space.mirrorDeployKeyEnc ? decryptToken(space.mirrorDeployKeyEnc) : null;

  const env: Record<string, string | undefined> = { GIT_TERMINAL_PROMPT: "0" };
  let pushUrl = remoteUrl;
  const cleanups: Array<() => Promise<void>> = [];

  try {
    if (scheme === "local") {
      // No credential — push the local/file remote directly.
    } else if (deployKey) {
      // Per-space deploy key (preferred): write the private key to a chmod-600
      // temp file and reference it via GIT_SSH_COMMAND; delete it in finally.
      const dir = await mkdtemp(path.join(tmpdir(), "desk-mirror-key-"));
      const keyPath = path.join(dir, "id");
      const pem = deployKey.endsWith("\n") ? deployKey : deployKey + "\n";
      await writeFile(keyPath, pem, { mode: 0o600 });
      cleanups.push(() => rm(dir, { recursive: true, force: true }));
      env.GIT_SSH_COMMAND =
        `ssh -i ${keyPath} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new ` +
        `-o UserKnownHostsFile=/dev/null -o BatchMode=yes`;
    } else {
      // Instance PAT via a generic GIT_ASKPASS helper (the token lives only in the
      // child env; the script holds no secret). Only for https remotes.
      const pat = await getInstanceGithubPat();
      if (!pat) {
        return persist(space.id, {
          lastMirroredSha: keepSha,
          lastAttemptAt: now,
          lastError:
            "no mirror credential configured — set an instance GitHub PAT or a per-space deploy key",
        });
      }
      const dir = await mkdtemp(path.join(tmpdir(), "desk-mirror-ap-"));
      const askPath = path.join(dir, "askpass.sh");
      await writeFile(askPath, "#!/bin/sh\nprintf '%s' \"$DESK_MIRROR_TOKEN\"\n", { mode: 0o700 });
      cleanups.push(() => rm(dir, { recursive: true, force: true }));
      env.GIT_ASKPASS = askPath;
      env.DESK_MIRROR_TOKEN = pat;
      pushUrl = injectHttpsUsername(remoteUrl);
    }

    const push = await runGit(["push", pushUrl, `${DEFAULT_BRANCH}:${DEFAULT_BRANCH}`], {
      cwd: repoPath,
      env,
    });

    if (push.code !== 0) {
      return persist(space.id, {
        lastMirroredSha: keepSha,
        lastAttemptAt: now,
        lastError: truncateErr(push.stderr),
      });
    }

    return persist(space.id, {
      lastMirroredSha: tip,
      lastAttemptAt: now,
      lastError: null,
    });
  } catch (e) {
    return persist(space.id, {
      lastMirroredSha: keepSha,
      lastAttemptAt: now,
      lastError: (e as Error)?.message ?? "mirror push failed",
    });
  } finally {
    for (const c of cleanups) await c().catch(() => {});
  }
}

// ── mirrorNow (the future "Mirror now" button service) ─────────────────────────

export type MirrorNowResult =
  | { ok: true; state: MirrorState }
  | { ok: false; reason: "unknown-space" | "not-hosted" | "no-remote" };

/**
 * Force a mirror push for a space NOW (owner/admin-gated at the eventual route;
 * this is the service only). Returns the recorded mirror_state, or a reason when
 * the space can't mirror (unknown / not hosted / no remote URL).
 */
export async function mirrorNow(spaceSlug: string): Promise<MirrorNowResult> {
  const space = await getSpaceBySlug(spaceSlug);
  if (!space) return { ok: false, reason: "unknown-space" };
  if (space.sourceMode !== "hosted") return { ok: false, reason: "not-hosted" };
  if (!space.mirrorRemoteUrl) return { ok: false, reason: "no-remote" };
  const state = await mirrorPush(space);
  return { ok: true, state };
}

// ── enqueueMirror — the in-process, deduped, backoff queue ─────────────────────

// Retry knobs (test-overridable via __setMirrorRetryForTests so the failure-path
// test doesn't wait real seconds).
let RETRY = { maxAttempts: 5, baseMs: 1_000, maxMs: 30_000 };

/** TEST-ONLY: shrink the retry schedule; returns a restore fn. */
export function __setMirrorRetryForTests(cfg: Partial<typeof RETRY>): () => void {
  const prev = RETRY;
  RETRY = { ...RETRY, ...cfg };
  return () => {
    RETRY = prev;
  };
}

function backoffMs(attempt: number): number {
  return Math.min(RETRY.baseMs * 2 ** (attempt - 1), RETRY.maxMs);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    // Don't keep the process alive just for a retry timer.
    if (typeof (t as unknown as { unref?: () => void }).unref === "function") {
      (t as unknown as { unref: () => void }).unref();
    }
  });
}

type QueueEntry = { promise: Promise<void>; rerun: boolean };
const active = new Map<number, QueueEntry>();

/**
 * Run the mirror push for a `hosted` space with a remote URL, with exponential
 * backoff on failure and per-space dedupe. FIRE-AND-FORGET and crash-proof: it
 * MUST NOT throw into or block the triggering write (same posture as the
 * post-push reindex). A concurrent enqueue while a run is in flight coalesces
 * into ONE follow-up run (so the latest `main` is always mirrored).
 *
 * Acts ONLY when source_mode==='hosted' AND mirror_remote_url is set — a
 * `mirrored` space (or a hosted space with no remote) is a silent no-op, so it is
 * safe to call unconditionally from every main-advancing path (incl. the git
 * transport push, which is exactly how a MIRRORED space receives its canon).
 */
export function enqueueMirror(spaceId: number): void {
  try {
    const existing = active.get(spaceId);
    if (existing) {
      existing.rerun = true; // coalesce — re-run once the current run finishes
      return;
    }
    const entry: QueueEntry = { promise: Promise.resolve(), rerun: false };
    active.set(spaceId, entry);
    entry.promise = runLoop(spaceId, entry).finally(() => active.delete(spaceId));
  } catch (e) {
    // Never let queueing failure escape into the write path.
    console.error("[mirror] enqueue failed:", (e as Error)?.message);
  }
}

async function runLoop(spaceId: number, entry: QueueEntry): Promise<void> {
  do {
    entry.rerun = false;
    await attemptWithRetries(spaceId);
  } while (entry.rerun);
}

async function attemptWithRetries(spaceId: number): Promise<void> {
  for (let attempt = 1; attempt <= RETRY.maxAttempts; attempt++) {
    let state: MirrorState | null;
    try {
      state = await runOnce(spaceId);
    } catch (e) {
      // A thrown push is a failure; keep retrying (never propagate).
      console.error("[mirror] attempt threw:", (e as Error)?.message);
      state = { lastMirroredSha: null, lastAttemptAt: new Date().toISOString(), lastError: "threw" };
    }
    if (state === null) return; // not hosted / no remote → nothing to do
    if (!state.lastError) return; // success
    if (attempt < RETRY.maxAttempts) await sleep(backoffMs(attempt));
  }
  console.error(`[mirror] space ${spaceId}: mirror push failed after ${RETRY.maxAttempts} attempts`);
}

/** One push attempt, gated on the space being hosted + having a remote. Returns
 * null when there is nothing to mirror. */
async function runOnce(spaceId: number): Promise<MirrorState | null> {
  const space = await getSpaceById(spaceId);
  if (!space || space.sourceMode !== "hosted" || !space.mirrorRemoteUrl) return null;
  return mirrorPush(space);
}

/** TEST-ONLY: await the in-flight mirror work for a space (incl. retries +
 * coalesced re-runs). Resolves immediately when nothing is queued. */
export function settleMirror(spaceId: number): Promise<void> {
  return active.get(spaceId)?.promise ?? Promise.resolve();
}

// ── Mirror config + per-space deploy-key service functions (settings UI, 4c) ──

export type SetMirrorConfigResult =
  | { ok: true; space: SpaceRow }
  | { ok: false; reason: "unknown-space" };

/**
 * Set a space's source mode and/or mirror remote URL (owner/admin-gated at the
 * eventual route). Passing `mirrorRemoteUrl: null` clears the remote. Only the
 * provided fields change.
 */
export async function setMirrorConfig(
  spaceSlug: string,
  patch: { sourceMode?: "hosted" | "mirrored"; mirrorRemoteUrl?: string | null },
): Promise<SetMirrorConfigResult> {
  const space = await getSpaceBySlug(spaceSlug);
  if (!space) return { ok: false, reason: "unknown-space" };
  const set: Partial<typeof spaces.$inferInsert> = {};
  if (patch.sourceMode !== undefined) set.sourceMode = patch.sourceMode;
  if (patch.mirrorRemoteUrl !== undefined) {
    const trimmed = patch.mirrorRemoteUrl?.trim();
    set.mirrorRemoteUrl = trimmed && trimmed.length > 0 ? trimmed : null;
  }
  if (Object.keys(set).length === 0) return { ok: true, space };
  const [updated] = await db.update(spaces).set(set).where(eq(spaces.id, space.id)).returning();
  return { ok: true, space: updated };
}

/**
 * Set (or replace) a space's deploy-key override — the SSH PRIVATE key, encrypted
 * at rest (WRITE-ONLY, never revealed). Returns false WITHOUT storing when
 * DESK_TOKEN_KEY is unset (never persist a plaintext key) or the space is unknown.
 */
export async function setSpaceDeployKey(spaceSlug: string, privateKeyPem: string): Promise<boolean> {
  const space = await getSpaceBySlug(spaceSlug);
  if (!space) return false;
  const enc = encryptToken(privateKeyPem);
  if (enc === null) return false; // no key → refuse to store plaintext
  await db.update(spaces).set({ mirrorDeployKeyEnc: enc }).where(eq(spaces.id, space.id));
  return true;
}

/** Clear a space's deploy-key override (falls back to the instance PAT). */
export async function clearSpaceDeployKey(spaceSlug: string): Promise<boolean> {
  const space = await getSpaceBySlug(spaceSlug);
  if (!space) return false;
  await db.update(spaces).set({ mirrorDeployKeyEnc: null }).where(eq(spaces.id, space.id));
  return true;
}

/** Whether a space has a deploy-key override (no reveal). */
export async function hasSpaceDeployKey(spaceSlug: string): Promise<boolean> {
  const space = await getSpaceBySlug(spaceSlug);
  return space != null && space.mirrorDeployKeyEnc != null;
}
