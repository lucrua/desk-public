/**
 * Git smart-HTTP transport endpoint — the document-host WRITE boundary
 * (design-document-host.md §13.5, §14, §15). AUTH-SENSITIVE.
 *
 * Mounted at /api/git/<owner>/<space>.git/… . A git client clones/pushes via
 *
 *     git clone https://<host>/api/git/<owner>/<space>.git
 *
 * Pipeline, in order (fail-closed at every step):
 *   1. Parse the path → {owner, space, service}. Unparseable → uniform 404.
 *   2. Authorize: Basic-auth token → space role; gate the service.
 *        - no credentials at all → 401 + WWW-Authenticate (client sends a token)
 *        - any other denial (unknown/revoked token, inactive user, unknown
 *          space, wrong owner, no membership, reader-attempting-push) → uniform
 *          404 (NO existence leak — a private space looks identical to absent)
 *   3. Ensure the bare repo exists on disk (lazily init on first authorized
 *      touch of an indexed space).
 *   4. Spawn the system git-http-backend (CGI) for that one repo + service.
 *   5. On a successful push (receive-pack POST), trigger re-projection
 *      (incremental re-index of changed paths).
 *
 * The repo is NEVER reachable on the share host: middleware 404s everything
 * outside /s/* there. On the hub host CF Access also fronts it in production —
 * but this token gate is the REAL credential for the file transport (CF Access
 * does not understand git), so it stands on its own.
 */
import { authorizeGit } from "@/lib/git/auth";
import { parseGitRequest, segmentsAfterMount } from "@/lib/git/route-parse";
import { runHttpBackend } from "@/lib/git/http-backend";
import { bareRepoPath, initBareRepo, refTip } from "@/lib/git/repo";
import { reindexSpaceByDisk } from "@/lib/git/indexer";
import { getSpaceBySlug } from "@/lib/spaces";
import { enqueueMirror } from "@/lib/mirror";

// Resolve fresh every request — auth must never be cached, and a push must
// re-render immediately.
export const dynamic = "force-dynamic";

/** Uniform 404 — the single shape for EVERY denial/parse-failure (no leak). */
function uniform404(): Response {
  return new Response("Not found", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

/** 401 prompting the git client to send Basic credentials (a token). Only used
 * when NO credentials were supplied at all — once a (wrong) token arrives we
 * 404 instead, so we never confirm a private space exists. */
function promptAuth(): Response {
  return new Response("Authentication required", {
    status: 401,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "www-authenticate": 'Basic realm="Desk Git", charset="UTF-8"',
    },
  });
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const segments = segmentsAfterMount(url.pathname);
  if (segments === null) return uniform404();

  const parsed = parseGitRequest(segments, req.method, url.searchParams);
  if (parsed === null) return uniform404();

  // ── AUTHORIZE (the gate) ──────────────────────────────────────────────────
  const decision = await authorizeGit(
    req.headers.get("authorization"),
    parsed.owner,
    parsed.space,
    parsed.service,
  );
  if (decision.kind === "unauthenticated") return promptAuth();
  if (decision.kind !== "ok") return uniform404();

  // ── Locate / lazily create the bare repo ──────────────────────────────────
  // Use the RESOLVED owner slug (from the space's real owner), not the raw URL
  // segment — authorizeGit already verified they match.
  const repoPath = bareRepoPath(decision.ownerSlug, decision.spaceSlug);
  try {
    await initBareRepo(repoPath);
  } catch {
    // A repo we cannot create/open is indistinguishable from "absent" to the
    // caller — uniform 404 (never a 500 that leaks internal state).
    return uniform404();
  }

  // Capture the pre-push tip so a successful receive-pack can re-index only the
  // changed paths.
  const isPush = parsed.service === "git-receive-pack" && req.method === "POST";
  const beforeSha = isPush ? await refTip(repoPath) : null;

  // E2: resolve the space's push policy so the pre-receive hook can enforce the
  // ref-level write boundary. The pre-receive hook FAILS CLOSED on a missing
  // value, so we pass an explicit policy; default to 'direct' only when the row
  // is somehow unreadable (authorizeGit already proved the space exists, so this
  // is belt-and-suspenders — and 'proposal' would be the conservative default,
  // but the hook itself defaults to 'proposal' when env is absent, so a missing
  // value already errs strict). We resolve the real stored policy here.
  const spaceRow = isPush ? await getSpaceBySlug(decision.spaceSlug) : null;
  const pushPolicy = spaceRow?.pushPolicy ?? "direct";

  // ── Spawn git-http-backend ────────────────────────────────────────────────
  const bodyBuf = Buffer.from(await req.arrayBuffer());
  let backend;
  try {
    backend = await runHttpBackend({
      repoPath,
      method: req.method,
      servicePath: parsed.servicePath,
      query: url.searchParams.toString(),
      contentType: req.headers.get("content-type") ?? "",
      body: bodyBuf,
      remoteUser: String(decision.userId),
      // E2 push-policy enforcement env → the pre-receive hook.
      pusherRole: decision.role,
      pushPolicy,
    });
  } catch {
    return uniform404();
  }

  // ── Re-projection on a successful push ────────────────────────────────────
  if (isPush && backend.status >= 200 && backend.status < 300) {
    try {
      const afterSha = await refTip(repoPath);
      if (afterSha && afterSha !== beforeSha) {
        await reindexSpaceByDisk(decision.spaceSlug, repoPath, {
          fromSha: beforeSha,
          toSha: afterSha,
          actorName: String(decision.userId),
        });
        // Mirror hook (Slice 4b): a push that advanced `main` fans out to the
        // space's GitHub mirror. Fire-and-forget + fail-soft — enqueueMirror
        // no-ops unless the space is `hosted` with a mirror_remote_url, so a
        // MIRRORED space (which RECEIVES its canon via exactly this transport
        // push) is never mirrored back out (no loop), and it never throws into
        // the push response.
        if (spaceRow) enqueueMirror(spaceRow.id);
      }
    } catch (e) {
      // A failed re-index must NOT fail the push (the canon is already in git;
      // the projection can be rebuilt). Log and return the push result.
      console.error("[git] post-receive re-index failed:", (e as Error)?.message);
    }
  }

  // Buffer → Uint8Array for the web Response body (Buffer isn't a BodyInit).
  return new Response(new Uint8Array(backend.body), {
    status: backend.status,
    headers: { ...backend.headers, "cache-control": "no-store" },
  });
}

export async function GET(req: Request): Promise<Response> {
  return handle(req);
}

export async function POST(req: Request): Promise<Response> {
  return handle(req);
}
