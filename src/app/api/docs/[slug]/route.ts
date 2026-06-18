import { NextResponse } from "next/server";
import { getPrincipal, isStaff } from "@/lib/auth";
import { getDocBySlug, listVersions, unpublishDoc, deleteDoc, setDocPath, setDocAudience, scopeForPrincipal } from "@/lib/docs";
import { audienceExists } from "@/lib/audiences";
import { normalizePath } from "@/lib/path";

function err(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

type RouteContext = { params: Promise<{ slug: string }> };

export async function GET(req: Request, { params }: RouteContext) {
  const principal = await getPrincipal(req.headers as unknown as Headers);
  if (!isStaff(principal)) {
    return err(403, "Forbidden — staff only");
  }

  const { slug } = await params;
  const includeUnpublished = principal.kind === "admin";

  const result = await getDocBySlug(slug, {
    includeUnpublished,
    scope: await scopeForPrincipal(principal),
  });
  if (!result) {
    return err(404, `Doc '${slug}' not found`);
  }

  const versions = await listVersions(slug);

  return NextResponse.json({
    doc: result.doc,
    versions,
    currentVersion: result.version,
  });
}

/**
 * PATCH /api/docs/[slug] — admin-only mutable-metadata edits. Supports two
 * mutually-exclusive shapes:
 *   - { path: "<canonical path>" }  — the folder-path "Move…" action (orga-
 *     nizational only; visibility untouched).
 *   - { audience: "<key>" }         — the Sharing-panel visibility control
 *     (Audiences v2). The key must already exist.
 */
export async function PATCH(req: Request, { params }: RouteContext) {
  const principal = await getPrincipal(req.headers as unknown as Headers);
  if (principal.kind !== "admin") {
    return err(403, "Forbidden — admin only");
  }

  const { slug } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err(400, "Invalid JSON body");
  }
  const b = body as Record<string, unknown>;

  // Audience change (Sharing panel). Validate the key exists before applying.
  if ("audience" in b) {
    if (typeof b.audience !== "string" || b.audience.trim().length === 0) {
      return err(400, "audience must be a non-empty string");
    }
    const key = b.audience.trim();
    if (!(await audienceExists(key))) {
      return err(400, "unknown audience — create it in /admin first");
    }
    const result = await setDocAudience(slug, key, principal.name);
    if (result === "not-found") {
      return err(404, `Doc '${slug}' not found`);
    }
    return NextResponse.json({ ok: true, slug, audience: key, changed: result === "ok" });
  }

  if (!("path" in b)) {
    return err(400, "Missing path or audience — PATCH supports { path } or { audience }");
  }
  const np = normalizePath(b.path);
  if (np === null) {
    return err(400, "Invalid path — segments must match ^[a-z0-9][a-z0-9-]*$, max depth 6");
  }

  const result = await setDocPath(slug, np, principal.name);
  if (result === "not-found") {
    return err(404, `Doc '${slug}' not found`);
  }
  return NextResponse.json({ ok: true, slug, path: np, moved: result === "ok" });
}

/**
 * DELETE /api/docs/[slug] — stage-2 complete deletion (admin only).
 *
 * Distinct from "unpublish" (stage 1, reversible). This is DESTRUCTIVE:
 * - Sets docs.deleted_at (tombstone)
 * - Purges all version content (not recoverable)
 * - Stage-2 deletes every share link for this doc
 * - Frees the slug for reuse (partial-unique index)
 * - Emits doc.deleted event
 *
 * The existing unpublish_doc MCP tool remains the stage-1 reversible de-list.
 */
export async function DELETE(req: Request, { params }: RouteContext) {
  const principal = await getPrincipal(req.headers as unknown as Headers);
  if (principal.kind !== "admin") {
    return err(403, "Forbidden — admin only");
  }

  const { slug } = await params;
  const done = await deleteDoc(slug, principal.name);
  if (!done) {
    return err(404, `Doc '${slug}' not found`);
  }

  return NextResponse.json({ ok: true });
}
