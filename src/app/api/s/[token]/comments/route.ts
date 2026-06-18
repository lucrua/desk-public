import { NextResponse } from "next/server";
import { resolveShare } from "@/lib/shares";
import { listComments, addComment } from "@/lib/comments";
import { shareCommentLimiter } from "@/lib/rate-limit";
import { MAX_COMMENT_CHARS } from "@/lib/limits";

/**
 * PUBLIC share-comment endpoints. No principal — capability is the raw token.
 *
 * SECURITY (the review probes these):
 *  - resolveShare(token) === null  → uniform 404 (unknown / revoked / expired /
 *    unpublished are indistinguishable).
 *  - share.allowComments === false → ALSO 404, with the SAME body, so an
 *    attacker can't distinguish "token exists, comments off" from "no token".
 *  - rate limit per shareId (10/min) → 429 on exceed.
 *  - body cap (MAX_COMMENT_CHARS); author is forced to the share's own label
 *    (`link:<label>`), never client-supplied.
 *  - bodies render through the escaped Markdown component downstream; author
 *    strings are plain-text data.
 */

// Resolve fresh every request (revocation / comments-off must take effect now).
export const dynamic = "force-dynamic";

function err(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

// The single uniform "not available" response. Used for every cause that must be
// indistinguishable: bad/revoked/expired token AND comments-off.
function uniform404() {
  return err(404, "Not found");
}

type RouteContext = { params: Promise<{ token: string }> };

export async function GET(req: Request, { params }: RouteContext) {
  const { token } = await params;
  const resolved = await resolveShare(token);
  if (resolved === null) return uniform404();
  if (!resolved.allowComments) return uniform404();

  // Public share view: only unresolved comments are visible.
  const comments = await listComments(resolved.doc.id, { includeResolved: false });

  // Project to a minimal, safe shape — never leak shareId / version internals.
  const items = comments.map((c) => ({
    id: c.id,
    authorName: c.authorName,
    authorKind: c.authorKind,
    body: c.body,
    createdAt: c.createdAt,
  }));
  return NextResponse.json({ comments: items });
}

export async function POST(req: Request, { params }: RouteContext) {
  const { token } = await params;
  const resolved = await resolveShare(token);
  if (resolved === null) return uniform404();
  if (!resolved.allowComments) return uniform404();

  // A share to a doc with no current version can't anchor a comment. Treat as
  // not-available (uniform) rather than leaking a distinct state.
  if (resolved.version === null) return uniform404();

  // Rate limit per share — the only abuse control on this unauthenticated path.
  const limit = shareCommentLimiter.take(String(resolved.shareId));
  if (!limit.ok) {
    return err(429, "Too many comments — please wait a minute and try again.");
  }

  // Pre-parse size guard: the comment cap is post-parse, so without this an
  // unauthenticated (token-holding) caller could make us buffer+parse huge JSON.
  const contentLength = Number(req.headers.get("content-length") ?? 0);
  if (contentLength > MAX_COMMENT_CHARS * 4) {
    return err(413, "Request too large");
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err(400, "Invalid JSON body");
  }

  const b = body as Record<string, unknown>;
  if (!b.body || typeof b.body !== "string") {
    return err(400, "Missing or invalid body — must be a non-empty string");
  }
  if (b.body.length > MAX_COMMENT_CHARS) {
    return err(400, `Comment too long (max ${MAX_COMMENT_CHARS} chars)`);
  }

  const created = await addComment({
    docId: resolved.doc.id,
    versionId: resolved.version.id,
    shareId: resolved.shareId,
    authorName: resolved.label, // forced — never client-supplied
    authorKind: `link:${resolved.label}`,
    body: b.body,
  });
  if (created === null) {
    return err(400, "Comment body is empty or too long after trimming");
  }

  // Mirror the GET projection — no internals leak back.
  return NextResponse.json(
    {
      comment: {
        id: created.id,
        authorName: created.authorName,
        authorKind: created.authorKind,
        body: created.body,
        createdAt: created.createdAt,
      },
    },
    { status: 201 },
  );
}
