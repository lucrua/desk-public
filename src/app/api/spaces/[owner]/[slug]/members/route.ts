/**
 * Space membership REST surface.
 *
 *   GET  /api/spaces/[slug]/members — list the space's members (userId, role,
 *        display label, isOwner). Visible to admins and to members OF that space
 *        (read-only). Unknown space → 404.
 *   POST /api/spaces/[slug]/members — set (or remove) a member's space role.
 *        Body: { userId, role: "writer" | "reader" | null }. Allowed for an
 *        ADMIN or the space's OWNER (canManageSpace) — mirrors the members panel
 *        the space-detail UI shows to admins and owners. add-role stays
 *        writer|reader (no owner transfer). The space owner cannot be demoted/
 *        removed here (guarded in the service). Unknown space → 404; a
 *        non-manager → 403.
 *
 * Both-channels parity with the MCP `set_space_member` tool. Mutations emit
 * space.member_added / space.member_removed.
 */
import { NextResponse } from "next/server";
import { getPrincipal, isStaff } from "@/lib/auth";
import { resolvePrincipalUserId } from "@/lib/principal-user";
import {
  canManageSpace,
  getSpace,
  setSpaceMemberRole,
  listSpaceMembers,
  type SpaceRole,
} from "@/lib/spaces";

function err(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

type RouteContext = { params: Promise<{ owner: string; slug: string }> };

const SETTABLE: SpaceRole[] = ["writer", "reader"];

export async function GET(req: Request, { params }: RouteContext) {
  const principal = await getPrincipal(req.headers as unknown as Headers);
  if (!isStaff(principal)) return err(403, "Forbidden — staff only");

  const { owner, slug } = await params;
  const space = await getSpace(owner, slug);
  if (!space) return err(404, "Not found");
  const members = (await listSpaceMembers(slug)) ?? [];

  // Admins see any space's members; a non-admin must be a member of THIS space.
  if (principal.kind !== "admin") {
    const me = await resolvePrincipalUserId(principal);
    const isMember = me != null && members.some((m) => m.userId === me);
    if (!isMember) return err(404, "Not found");
  }
  return NextResponse.json({ members }, { status: 200 });
}

export async function POST(req: Request, { params }: RouteContext) {
  const principal = await getPrincipal(req.headers as unknown as Headers);
  if (!isStaff(principal)) return err(403, "Forbidden — staff only");

  const { owner, slug } = await params;
  const space = await getSpace(owner, slug);
  if (!space) return err(404, "Not found");
  if (!(await canManageSpace(principal, space))) {
    return err(403, "Forbidden — only an admin or the space owner can manage members");
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err(400, "Invalid JSON body");
  }
  const b = body as Record<string, unknown>;

  if (typeof b.userId !== "number") return err(400, "Missing or invalid userId");
  let role: SpaceRole | null;
  if (b.role === null) {
    role = null;
  } else if (typeof b.role === "string" && SETTABLE.includes(b.role as SpaceRole)) {
    role = b.role as SpaceRole;
  } else {
    return err(400, "Invalid role — must be 'writer', 'reader', or null");
  }

  const out = await setSpaceMemberRole(slug, b.userId, role, principal.name);
  if (!out.ok) return err(400, out.error);
  return NextResponse.json({ ok: true, role: out.role }, { status: 200 });
}
