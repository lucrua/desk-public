import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { getDocBySlug, scopeForPrincipal } from "@/lib/docs";
import { listSharesForDoc } from "@/lib/shares";

function err(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

type RouteContext = { params: Promise<{ slug: string }> };

/**
 * GET /api/docs/[slug]/shares — every share for one doc, with view stats.
 *
 * Staff-readable (admin + member); anonymous → 403. Round-2 design: members may
 * SEE the per-doc links table read-only (label / mode / created / expires /
 * views / status) so they know what's out there — creating, revoking and
 * toggling stay admin-only (those are separate routes, each admin-gated). The
 * returned `ShareListItem` carries NO token-ish data (only the sha256 hash is
 * stored, and that is never selected here), so a member read leaks nothing a
 * member couldn't already infer from the doc page.
 *
 * Members are scoped through audience visibility: an unknown OR audience-denied
 * doc returns a UNIFORM 404 (no existence signal), and members never see
 * unpublished docs. Admins resolve unpublished docs too (includeUnpublished),
 * so links remain manageable after a Delete/unpublish. The doc-existence check
 * runs first either way — `listSharesForDoc` never disambiguates "no shares"
 * from "no doc".
 */
export async function GET(req: Request, { params }: RouteContext) {
  const principal = await getPrincipal(req.headers);
  if (principal.kind !== "admin" && principal.kind !== "member") {
    return err(403, "Forbidden — sign in");
  }
  const isAdmin = principal.kind === "admin";

  const { slug } = await params;
  const result = await getDocBySlug(slug, {
    includeUnpublished: isAdmin,
    scope: await scopeForPrincipal(principal),
  });
  if (!result) return err(404, `Doc '${slug}' not found`);

  const shares = await listSharesForDoc(slug);
  return NextResponse.json({ shares });
}
