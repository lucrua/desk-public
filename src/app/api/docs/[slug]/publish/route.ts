/**
 * POST /api/docs/[slug]/publish — publish a new version directly (no approval).
 *
 * Enforces canPublishVersion: admin OR the doc's owner. A member who is neither
 * admin nor owner gets a 403. A non-existent slug also returns 403 (uniform —
 * no existence signal for members).
 *
 * Body: { content, title?, path? }
 *   - content: the full new doc body (markdown or html, same format as existing)
 *   - title: optional, updates the title if provided
 *   - path: optional, updates the folder path if provided
 *
 * This is the direct-publish path for the web editor (canPublishDirect === true).
 * The MCP channel uses publish_doc (with relaxed guard).
 */
import { NextResponse } from "next/server";
import { getPrincipal, isStaff } from "@/lib/auth";
import { getDocBySlug, publishDoc, scopeForPrincipal } from "@/lib/docs";
import { canPublishVersion } from "@/lib/permissions";
import { normalizePath } from "@/lib/path";
import { MAX_CONTENT_CHARS } from "@/lib/limits";

function err(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

type RouteContext = { params: Promise<{ slug: string }> };

export async function POST(req: Request, { params }: RouteContext) {
  const principal = await getPrincipal(req.headers as unknown as Headers);
  if (!isStaff(principal)) return err(403, "Forbidden — staff only");

  const { slug } = await params;

  // Load the doc (admin sees unpublished too; members see scoped).
  const result = await getDocBySlug(slug, {
    includeUnpublished: principal.kind === "admin",
    scope: await scopeForPrincipal(principal),
  });

  // Uniform 403 for missing OR out-of-scope: no existence signal.
  if (!result) return err(403, "Forbidden");

  // Permission check: admin OR owner of this specific doc.
  if (!canPublishVersion(principal, result.doc)) {
    return err(403, "Forbidden — only the doc owner or an admin may publish directly");
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

  // Title: optional; fall back to existing doc title.
  const title =
    typeof b.title === "string" && b.title.trim().length > 0
      ? b.title.trim()
      : result.doc.title;

  // Path: optional; fall back to existing doc path.
  let path: string | undefined;
  if (typeof b.path === "string") {
    const np = normalizePath(b.path);
    if (np === null) {
      return err(400, "Invalid path — segments must match ^[a-z0-9][a-z0-9-]*$, max depth 6");
    }
    path = np;
  }

  const published = await publishDoc({
    slug,
    title,
    sourcePath: result.doc.sourcePath,
    audience: result.doc.audience,
    format: result.doc.format,
    content: b.content,
    by: principal.name,
    ...(path !== undefined ? { path } : {}),
  });

  if (!published.ok) {
    return err(409, `Version conflict — current version is ${published.currentVersionId}; re-base and retry`);
  }

  return NextResponse.json({
    ok: true,
    slug: published.slug,
    versionId: published.versionId,
    isNewVersion: published.isNewVersion,
    ownerUserId: published.ownerUserId,
  }, { status: 200 });
}
