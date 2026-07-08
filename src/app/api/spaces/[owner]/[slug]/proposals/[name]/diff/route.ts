/**
 * GET /api/spaces/[slug]/proposals/[name]/diff — the review diff for one
 * proposal (E2): `merge-base(main, proposal)..proposal` as a unified patch + a
 * per-file name/status list.
 *
 * AUTHZ (same as the list route): admin, the space OWNER, or a WRITER may view
 * it; a reader / non-member / anonymous → uniform 404 (no existence leak).
 */
import { getPrincipal, isStaff } from "@/lib/auth";
import { resolvePrincipalUserId } from "@/lib/principal-user";
import { getSpace, listSpaceMembers, type SpaceRole } from "@/lib/spaces";
import { proposalDiffForSpace } from "@/lib/proposals-service";

function notFound(): Response {
  return new Response(JSON.stringify({ error: "Not found" }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });
}

type RouteContext = { params: Promise<{ owner: string; slug: string; name: string }> };

export async function GET(req: Request, { params }: RouteContext) {
  const principal = await getPrincipal(req.headers as unknown as Headers);
  const { owner, slug, name } = await params;
  const space = await getSpace(owner, slug);
  if (!space) return notFound();

  const isAdmin = principal.kind === "admin";
  let myRole: SpaceRole | null = null;
  if (isStaff(principal)) {
    const myUserId = await resolvePrincipalUserId(principal);
    if (myUserId != null) {
      const members = (await listSpaceMembers(space.id)) ?? [];
      myRole = members.find((m) => m.userId === myUserId)?.role ?? null;
    }
  }
  const canSee = isAdmin || myRole === "owner" || myRole === "writer";
  if (!canSee) return notFound();

  const decoded = decodeURIComponent(name);
  const result = await proposalDiffForSpace(space.id, decoded);
  if (!result.ok) return notFound();
  return Response.json({
    base: result.diff.base,
    tip: result.diff.tip,
    patch: result.diff.patch,
    files: result.diff.files,
  });
}
