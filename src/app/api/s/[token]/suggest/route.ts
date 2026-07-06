import { NextResponse } from "next/server";
import { resolveShare } from "@/lib/shares";
import { createShareRevision } from "@/lib/revisions";
import { shareSuggestLimiter } from "@/lib/rate-limit";
import { MAX_CONTENT_CHARS, MAX_REVISION_NOTE_CHARS } from "@/lib/limits";

/**
 * PUBLIC "suggest an edit" endpoint for a DOC share. No principal — the raw
 * token IS the capability, exactly like the share-comment path. A visitor
 * submits a FULL proposed new body that queues as a `revision` the owner reviews
 * (existing diff UI) and accepts (→ a git commit) or rejects. NO account.
 *
 * SECURITY — THE ACCESS BOUNDARY IS SACRED. This is a NEW UNAUTHENTICATED WRITE
 * INGRESS, so it fails closed everywhere and EVERY failure mode returns the SAME
 * uniform 404 (never "edits disabled" or any existence hint):
 *   - resolveShare(token) === null → 404 (unknown / revoked / expired /
 *     unpublished are indistinguishable);
 *   - share.allowEdits === false   → ALSO 404, SAME body (a disabled-edits share
 *     is indistinguishable from a dead token);
 *   - the target doc is html (no editor) → ALSO 404;
 *   - the doc has no current version to anchor against → ALSO 404.
 * Abuse controls on this token-only path: a dedicated limiter (5/hour per share
 * id), a pre-parse content-length guard, and the MAX_CONTENT_CHARS cap.
 *
 * Identity is FORCED server-side (proposer_label = "link:<share label>") — the
 * client can never supply or spoof it. The share is the sole authorization;
 * `createShareRevision` never touches the staff/scope gate, and a visitor can
 * reach NO staff surface through this route.
 */

// Resolve fresh every request (revocation / edits-off must take effect now).
export const dynamic = "force-dynamic";

function err(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

// The single uniform "not available" response — used for every cause that must
// be indistinguishable: bad/revoked/expired token, edits-off, html doc, no version.
function uniform404() {
  return err(404, "Not found");
}

type RouteContext = { params: Promise<{ token: string }> };

export async function POST(req: Request, { params }: RouteContext) {
  const { token } = await params;
  const resolved = await resolveShare(token);
  if (resolved === null) return uniform404();
  if (!resolved.allowEdits) return uniform404();
  // html docs have no editor — a suggestion needs the markdown source. Uniform.
  if (resolved.doc.format !== "md") return uniform404();
  // A share to a doc with no current version can't anchor a suggestion. Uniform.
  if (resolved.version === null) return uniform404();

  // Rate limit per share — the primary abuse control on this unauthenticated path.
  const limit = shareSuggestLimiter.take(String(resolved.shareId));
  if (!limit.ok) {
    return err(429, "Too many suggestions — please wait a while and try again.");
  }

  // Pre-parse size guard: the content cap is post-parse, so without this a
  // token-holding caller could make us buffer + parse a huge JSON body.
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
    baseVersionId: resolved.version.id, // pinned → the pinned version; else current
    shareId: resolved.shareId,
    shareLabel: resolved.label, // forced identity — never client-supplied
    content: b.content,
    note: typeof b.note === "string" ? b.note : undefined,
  });
  if (created === null) {
    return err(400, "Suggestion content or note is invalid");
  }

  // Minimal projection — never leak internals (shareId / version / doc id).
  return NextResponse.json(
    { suggestion: { id: created.id, status: created.status, createdAt: created.createdAt } },
    { status: 201 },
  );
}
