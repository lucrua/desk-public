import { NextResponse } from "next/server";
import { resolveShareDoc } from "@/lib/shares";
import { listComments, addComment } from "@/lib/comments";
import { shareCommentLimiter } from "@/lib/rate-limit";
import { MAX_COMMENT_CHARS } from "@/lib/limits";

/**
 * PUBLIC comment endpoints for a doc opened UNDER a directory share. The dir
 * token is the capability; the slug is verified PUBLISHED + UNDER the share's
 * prefix by resolveShareDoc (same guard as the reader/raw routes). The 404
 * discipline is byte-identical to /api/s/[token]/comments.
 *
 * SECURITY:
 *  - resolveShareDoc(token, slug) === null → uniform 404 (every cause —
 *    unknown/revoked/expired token, non-directory share, unknown slug,
 *    slug-outside-prefix, unpublished — indistinguishable).
 *  - share.allowComments === false → ALSO 404, SAME body (no "comments off" leak).
 *  - rate limited per shareId (folder-wide, like the doc-share route).
 *  - body cap; author forced to `link:<label>`, never client-supplied.
 */
export const dynamic = "force-dynamic";

function err(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

function uniform404() {
  return err(404, "Not found");
}

type RouteContext = { params: Promise<{ token: string; slug: string }> };

export async function GET(_req: Request, { params }: RouteContext) {
  const { token, slug } = await params;
  const resolved = await resolveShareDoc(token, slug);
  if (resolved === null) return uniform404();
  if (!resolved.share.allowComments) return uniform404();

  const comments = await listComments(resolved.doc.id, { includeResolved: false });
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
  const { token, slug } = await params;
  const resolved = await resolveShareDoc(token, slug);
  if (resolved === null) return uniform404();
  if (!resolved.share.allowComments) return uniform404();

  // Rate limit per share (folder-wide) — the only abuse control on this path.
  const limit = shareCommentLimiter.take(String(resolved.share.shareId));
  if (!limit.ok) {
    return err(429, "Too many comments — please wait a minute and try again.");
  }

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
    shareId: resolved.share.shareId,
    authorName: resolved.share.label, // forced — never client-supplied
    authorKind: `link:${resolved.share.label}`,
    body: b.body,
  });
  if (created === null) {
    return err(400, "Comment body is empty or too long after trimming");
  }

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
