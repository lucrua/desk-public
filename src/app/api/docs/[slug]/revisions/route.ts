import { NextResponse } from "next/server";
import { getPrincipal, isStaff } from "@/lib/auth";
import type { Principal } from "@/lib/auth";
import { getDocBySlug, scopeForPrincipal } from "@/lib/docs";
import { createRevision, listRevisions } from "@/lib/revisions";
import { MAX_CONTENT_CHARS, MAX_REVISION_NOTE_CHARS } from "@/lib/limits";

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

  const url = new URL(req.url);
  const statusParam = url.searchParams.get("status");
  const status =
    statusParam === "open" || statusParam === "accepted" || statusParam === "rejected"
      ? statusParam
      : undefined;

  const revisions = await listRevisions(result.doc.id, { status });
  return NextResponse.json({ revisions });
}

export async function POST(req: Request, { params }: RouteContext) {
  const principal = await getPrincipal(req.headers);
  if (!isStaff(principal)) return err(403, "Forbidden — staff only");

  const { slug } = await params;
  const result = await scopedDoc(slug, principal);
  if (!result) return err(404, `Doc '${slug}' not found`);

  // html docs get no editor — proposals are markdown-only.
  if (result.doc.format !== "md") {
    return err(400, "Revisions are only supported on markdown docs");
  }
  // A doc with no current version can't anchor a revision.
  if (result.doc.currentVersionId === null || result.version === null) {
    return err(409, "Doc has no published version to propose against");
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
    return err(400, `Content too large (max ${MAX_CONTENT_CHARS} chars)`);
  }
  if (b.note !== undefined && b.note !== null && typeof b.note !== "string") {
    return err(400, "Invalid note — must be a string");
  }
  if (typeof b.note === "string" && b.note.length > MAX_REVISION_NOTE_CHARS) {
    return err(400, `Note too long (max ${MAX_REVISION_NOTE_CHARS} chars)`);
  }

  const created = await createRevision({
    slug,
    authorName: principal.name,
    authorKind: principal.kind, // 'admin' | 'member'
    scope: await scopeForPrincipal(principal),
    content: b.content,
    note: typeof b.note === "string" ? b.note : undefined,
  });
  // createRevision re-checks scope/format/caps — null means a validation miss
  // (the doc/format/scope checks above already passed, so this is empty-content
  // or oversize-note after the early route checks).
  if (created === null) {
    return err(400, "Revision content or note is invalid");
  }

  return NextResponse.json({ revision: created }, { status: 201 });
}
