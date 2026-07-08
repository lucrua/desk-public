/**
 * POST /api/spaces/[slug]/proposals/[name]/reject — reject a proposal (E2).
 *
 * Deletes the `proposals/<name>` ref. `main` is never touched. Emits
 * `proposal.rejected`.
 *
 * AUTHZ: admin OR the space OWNER only (canManageSpace). A reader / non-owner
 * writer / non-member / anonymous → uniform 404 (no existence leak).
 */
import { getPrincipal, isStaff } from "@/lib/auth";
import { canManageSpace, getSpace } from "@/lib/spaces";
import { rejectProposalForSpace } from "@/lib/proposals-service";

function notFound(): Response {
  return new Response(JSON.stringify({ error: "Not found" }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });
}

type RouteContext = { params: Promise<{ owner: string; slug: string; name: string }> };

export async function POST(req: Request, { params }: RouteContext) {
  const principal = await getPrincipal(req.headers as unknown as Headers);
  const { owner, slug, name } = await params;
  const space = await getSpace(owner, slug);
  if (!space) return notFound();

  if (!isStaff(principal) || !(await canManageSpace(principal, space))) {
    return notFound();
  }

  const decoded = decodeURIComponent(name);
  const result = await rejectProposalForSpace(space.id, decoded, principal.name);
  if (!result.ok) return notFound();
  return Response.json({ ok: true });
}
