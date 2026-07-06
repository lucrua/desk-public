import { NextResponse } from "next/server";
import { resolveShareDoc } from "@/lib/shares";
import { createShareRevision } from "@/lib/revisions";
import { shareSuggestLimiter } from "@/lib/rate-limit";
import { MAX_CONTENT_CHARS, MAX_REVISION_NOTE_CHARS } from "@/lib/limits";

/**
 * PUBLIC "suggest an edit" endpoint for a doc opened UNDER a DIRECTORY share.
 * The dir token is the capability; the slug is verified PUBLISHED + UNDER the
 * share's prefix AND in the share's space by resolveShareDoc (the same guard as
 * the reader / comment routes — post-Slice-1 it enforces both). The 404
 * discipline is byte-identical to /api/s/[token]/suggest.
 *
 * SECURITY (this NEW unauthenticated write ingress fails closed everywhere):
 *   - resolveShareDoc(token, slug) === null → uniform 404 (every cause —
 *     unknown/revoked/expired token, non-directory share, unknown slug,
 *     slug-outside-prefix, slug-in-another-space, unpublished — indistinguishable);
 *   - share.allowEdits === false → ALSO 404, SAME body (no "edits off" leak);
 *   - the target doc is html (no editor) → ALSO 404.
 * Rate limited per shareId (folder-wide, 5/hour); content-length pre-guard +
 * MAX_CONTENT_CHARS cap. Identity forced to "link:<share label>" — never client
 * input; the share is the sole authorization (no staff surface reachable here).
 */
export const dynamic = "force-dynamic";

function err(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

function uniform404() {
  return err(404, "Not found");
}

type RouteContext = { params: Promise<{ token: string; slug: string }> };

export async function POST(req: Request, { params }: RouteContext) {
  const { token, slug } = await params;
  const resolved = await resolveShareDoc(token, slug);
  if (resolved === null) return uniform404();
  if (!resolved.share.allowEdits) return uniform404();
  // html docs have no editor — uniform (no distinct state leaks).
  if (resolved.doc.format !== "md") return uniform404();

  // Rate limit per share (folder-wide) — the primary abuse control on this path.
  const limit = shareSuggestLimiter.take(String(resolved.share.shareId));
  if (!limit.ok) {
    return err(429, "Too many suggestions — please wait a while and try again.");
  }

  const contentLength = Number(req.headers.get("content-length") ?? 0);
  if (contentLength > MAX_CONTENT_CHARS * 4) {
    return err(413, "Request too large");
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err(400, "Invalid JSON body");
  }

  const b = body as Record<string, unknown>;
  if (!b.content || typeof b.content !== "string") {
    return err(400, "Missing or invalid content — must be a non-empty string");
  }
  if (b.content.length > MAX_CONTENT_CHARS) {
    return err(400, `Suggestion too long (max ${MAX_CONTENT_CHARS} chars)`);
  }
  if (b.note !== undefined && b.note !== null && typeof b.note !== "string") {
    return err(400, "Invalid note — must be a string");
  }
  if (typeof b.note === "string" && b.note.length > MAX_REVISION_NOTE_CHARS) {
    return err(400, `Note too long (max ${MAX_REVISION_NOTE_CHARS} chars)`);
  }

  const created = await createShareRevision({
    docId: resolved.doc.id,
    docSlug: resolved.doc.slug,
    baseVersionId: resolved.version.id, // directory shares are live-only (current)
    shareId: resolved.share.shareId,
    shareLabel: resolved.share.label, // forced identity — never client-supplied
    content: b.content,
    note: typeof b.note === "string" ? b.note : undefined,
  });
  if (created === null) {
    return err(400, "Suggestion content or note is invalid");
  }

  return NextResponse.json(
    { suggestion: { id: created.id, status: created.status, createdAt: created.createdAt } },
    { status: 201 },
  );
}
