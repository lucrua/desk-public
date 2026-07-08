/**
 * PATCH /api/spaces/[slug] — update a space's listing visibility OR push policy.
 *
 * Body: { visibility?: "private"|"unlisted"|"public", push_policy?: "direct"|
 * "proposal" } — supply EXACTLY ONE of the two fields. Allowed for an ADMIN or
 * the space's OWNER (canManageSpace) — the same owner-or-admin gate both controls
 * the space-detail UI shows share (a non-admin owner must not 403).
 *   - visibility governs DISCOVERY only — never the git ACL (membership-based).
 *   - push_policy is the git-push branch-protection mode (External Collaboration
 *     E1): 'direct' (writers push main) | 'proposal' (non-owner writers push
 *     proposals/* — ENFORCED in E2; E1 stores it + reflects it in the setup
 *     prompt).
 * Unknown space → 404. A non-manager → 403. A missing/invalid value → 400. Emits
 * space.updated (in the service).
 */
import { NextResponse } from "next/server";
import { getPrincipal, isStaff } from "@/lib/auth";
import {
  canManageSpace,
  getSpace,
  setSpaceVisibility,
  setSpacePushPolicy,
  type SpaceVisibility,
  type SpacePushPolicy,
} from "@/lib/spaces";

function err(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

type RouteContext = { params: Promise<{ owner: string; slug: string }> };

const VISIBILITIES: SpaceVisibility[] = ["private", "unlisted", "public"];
const PUSH_POLICIES: SpacePushPolicy[] = ["direct", "proposal"];

export async function PATCH(req: Request, { params }: RouteContext) {
  const principal = await getPrincipal(req.headers as unknown as Headers);
  if (!isStaff(principal)) return err(403, "Forbidden — staff only");

  const { owner, slug } = await params;
  const space = await getSpace(owner, slug);
  if (!space) return err(404, "Not found");
  if (!(await canManageSpace(principal, space))) {
    return err(403, "Forbidden — only an admin or the space owner can manage this space");
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err(400, "Invalid JSON body");
  }
  const b = body as Record<string, unknown>;

  const hasVisibility = b.visibility !== undefined;
  const hasPushPolicy = b.push_policy !== undefined;
  if (hasVisibility === hasPushPolicy) {
    return err(400, "Supply exactly one of 'visibility' or 'push_policy'");
  }

  if (hasPushPolicy) {
    if (typeof b.push_policy !== "string" || !PUSH_POLICIES.includes(b.push_policy as SpacePushPolicy)) {
      return err(400, "Invalid push_policy — must be 'direct' or 'proposal'");
    }
    const ok = await setSpacePushPolicy(space.id, b.push_policy as SpacePushPolicy, principal.name);
    if (!ok) return err(404, "Not found");
    return NextResponse.json({ ok: true, push_policy: b.push_policy }, { status: 200 });
  }

  if (typeof b.visibility !== "string" || !VISIBILITIES.includes(b.visibility as SpaceVisibility)) {
    return err(400, "Invalid visibility — must be 'private', 'unlisted', or 'public'");
  }
  const ok = await setSpaceVisibility(space.id, b.visibility as SpaceVisibility, principal.name);
  if (!ok) return err(404, "Not found");
  return NextResponse.json({ ok: true, visibility: b.visibility }, { status: 200 });
}
