/**
 * GET /api/spaces/[slug]/proposals — list a space's open proposals (the E2 PR
 * surface). External Collaboration, Slice E2.
 *
 * A proposal is a `proposals/<name>` ref a non-owner writer pushed in `proposal`
 * push-policy mode. Returns `{ proposals: [{ name, ref, tipSha, pusher, subject,
 * createdAt }] }`.
 *
 * AUTHZ (fail-closed, no existence leak):
 *   - admin OR the space OWNER → the full list.
 *   - a non-owner WRITER (a proposer) → the list too (they contribute proposals
 *     to this space; proposals are not hidden from co-writers, and the doc read
 *     boundary is unchanged).
 *   - a READER, a non-member, anonymous → uniform 404 (a private space is
 *     indistinguishable from absent — same shape the git transport uses).
 */
import { getPrincipal, isStaff } from "@/lib/auth";
import { resolvePrincipalUserId } from "@/lib/principal-user";
import {
  getSpaceBySlug,
  listSpaceMembers,
  type SpaceRole,
} from "@/lib/spaces";
import { listProposalsForSpace } from "@/lib/proposals-service";

/** The single 404 shape for every denial — never confirm a space exists. */
function notFound(): Response {
  return new Response(JSON.stringify({ error: "Not found" }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });
}

type RouteContext = { params: Promise<{ slug: string }> };

export async function GET(req: Request, { params }: RouteContext) {
  const principal = await getPrincipal(req.headers as unknown as Headers);
  const { slug } = await params;
  const space = await getSpaceBySlug(slug);
  if (!space) return notFound();

  const isAdmin = principal.kind === "admin";
  // Resolve the caller's role on THIS space (null when not a member).
  let myRole: SpaceRole | null = null;
  if (isStaff(principal)) {
    const myUserId = await resolvePrincipalUserId(principal);
    if (myUserId != null) {
      const members = (await listSpaceMembers(slug)) ?? [];
      myRole = members.find((m) => m.userId === myUserId)?.role ?? null;
    }
  }

  // Fail-closed: only admin / owner / writer may see the proposal list. A
  // reader, non-member, or anonymous → uniform 404 (no existence leak).
  const canSee = isAdmin || myRole === "owner" || myRole === "writer";
  if (!canSee) return notFound();

  const result = await listProposalsForSpace(slug);
  if (!result.ok) return notFound();
  return Response.json({ proposals: result.proposals });
}
