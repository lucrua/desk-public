/**
 * POST /api/spaces/[slug]/proposals/[name]/accept — accept a proposal (E2).
 *
 * Merges `proposals/<name>` into `main` (fast-forward when possible, else a
 * merge commit authored by the accepting owner), reindexes the space so the
 * merged content projects, deletes the proposal ref, and emits
 * `proposal.accepted`.
 *
 * AUTHZ: admin OR the space OWNER only (canManageSpace) — the same owner-or-admin
 * gate as visibility/push-policy/invites. A reader / non-owner writer / non-
 * member / anonymous → uniform 404 (no existence leak; a 403 would confirm the
 * space exists). A conflicting merge → 409 with no change to `main`.
 */
import { getPrincipal, isStaff } from "@/lib/auth";
import { canManageSpace, getSpace } from "@/lib/spaces";
import { acceptProposalForSpace } from "@/lib/proposals-service";

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
  // Proposal names can contain `/` (proposals/alice/feature) — Next gives a
  // single decoded segment per `[name]`; a multi-segment name would need a
  // catch-all. We support the single-segment form here (the common case) and the
  // service validates the name shape.
  const space = await getSpace(owner, slug);
  if (!space) return notFound();

  // Fail-closed uniform 404 for every non-manager (incl. anonymous / reader /
  // non-owner writer) — never a 403 that would confirm existence.
  if (!isStaff(principal) || !(await canManageSpace(principal, space))) {
    return notFound();
  }

  const decoded = decodeURIComponent(name);
  const email =
    "email" in principal && principal.email ? principal.email : "desk@localhost";
  const result = await acceptProposalForSpace(space.id, decoded, {
    name: principal.name,
    email,
  });

  if (!result.ok) {
    if (result.reason === "not-found" || result.reason === "unknown-space") {
      return notFound();
    }
    if (result.reason === "conflict") {
      return Response.json(
        { error: "merge conflict — resolve and re-push the proposal", detail: result.detail },
        { status: 409 },
      );
    }
    if (result.reason === "mirrored") {
      return Response.json(
        { error: "This space mirrors from GitHub — accepting is refused; apply the change upstream.", detail: result.detail },
        { status: 409 },
      );
    }
    return Response.json({ error: "accept failed", detail: result.detail }, { status: 500 });
  }

  return Response.json({
    ok: true,
    merged: result.merged,
    newMainSha: result.newMainSha,
    reindexed: result.reindexed,
  });
}
