import { NextResponse } from "next/server";
import { getPrincipal, isStaff } from "@/lib/auth";
import { getDocBySlug, getVersionContent, scopeForPrincipal } from "@/lib/docs";

function err(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

type RouteContext = { params: Promise<{ slug: string; id: string }> };

/**
 * GET /api/docs/[slug]/versions/[id] — raw content of one version (staff only).
 *
 * REST mirror of the `get_version` MCP tool. Audience-scoped exactly like
 * GET /api/docs/[slug]: the doc is resolved with the caller's scope first, so a
 * member on a hidden audience gets a uniform 404 and never reaches the version
 * lookup. The version id must belong to the named doc — cross-doc access is
 * rejected as not-found (the guard lives in getVersionContent). This is the
 * endpoint the `desk sync` client uses to fetch the common-base content for a
 * 3-way merge.
 */
export async function GET(req: Request, { params }: RouteContext) {
  const principal = await getPrincipal(req.headers as unknown as Headers);
  if (!isStaff(principal)) return err(403, "Forbidden — staff only");

  const { slug, id } = await params;

  const versionId = Number(id);
  if (!Number.isInteger(versionId) || versionId <= 0) {
    return err(400, "Invalid version id — must be a positive integer");
  }

  // Audience-scope the doc first (same as get_doc / the MCP tool) so a member on
  // a hidden doc gets a uniform not-found and never reaches the version lookup.
  const result = await getDocBySlug(slug, {
    includeUnpublished: principal.kind === "admin",
    scope: await scopeForPrincipal(principal),
  });
  if (!result) return err(404, `Doc '${slug}' not found`);

  const content = await getVersionContent(slug, versionId);
  if (content === null) {
    return err(404, `Version ${versionId} not found for doc '${slug}'`);
  }

  return NextResponse.json({ slug, versionId, content });
}
