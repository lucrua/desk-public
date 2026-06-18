import { NextResponse } from "next/server";
import { getPrincipal, isStaff } from "@/lib/auth";
import type { Principal } from "@/lib/auth";
import { getDocBySlug, scopeForPrincipal } from "@/lib/docs";
import { listComments, addComment } from "@/lib/comments";
import { MAX_COMMENT_CHARS } from "@/lib/limits";

function err(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

type RouteContext = { params: Promise<{ slug: string }> };

/**
 * Resolve the doc for this request, audience-scoped to the caller. Returns null
 * (→ uniform 404 at the call site) when the doc is missing OR the member can't
 * see its audience — no existence signal leaks. Admins see unpublished too.
 */
async function scopedDoc(slug: string, principal: Principal) {
  return getDocBySlug(slug, {
    includeUnpublished: principal.kind === "admin",
    scope: await scopeForPrincipal(principal),
  });
}

export async function GET(req: Request, { params }: RouteContext) {
  const principal = await getPrincipal(req.headers);
  if (!isStaff(principal)) return err(403, "Forbidden — staff only");

  const { slug } = await params;
  const result = await scopedDoc(slug, principal);
  if (!result) return err(404, `Doc '${slug}' not found`);

  // Staff pages see the whole thread (resolved included).
  const comments = await listComments(result.doc.id, { includeResolved: true });
  return NextResponse.json({ comments });
}

export async function POST(req: Request, { params }: RouteContext) {
  const principal = await getPrincipal(req.headers);
  if (!isStaff(principal)) return err(403, "Forbidden — staff only");

  const { slug } = await params;
  const result = await scopedDoc(slug, principal);
  if (!result) return err(404, `Doc '${slug}' not found`);

  // A doc with no current version can't anchor a comment (versionId is notNull).
  if (result.doc.currentVersionId === null || result.version === null) {
    return err(409, "Doc has no published version to comment on");
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
    docId: result.doc.id,
    versionId: result.version.id,
    authorName: principal.name,
    authorKind: principal.kind, // 'admin' | 'member'
    body: b.body,
  });
  // addComment trims then re-checks empty/oversize — null means the trimmed body
  // was empty or over the cap.
  if (created === null) {
    return err(400, "Comment body is empty or too long after trimming");
  }

  return NextResponse.json({ comment: created }, { status: 201 });
}
