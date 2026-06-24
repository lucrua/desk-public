/**
 * POST /api/spaces/[slug]/invites — mint an invite capability link for a space.
 *
 * Body: { role: "writer" | "reader", email?, expiresInDays?, maxUses? }.
 * Allowed for an ADMIN or the space's OWNER (canManageSpace) — the same gate the
 * visibility/members controls use (a non-admin owner must not 403). Returns the
 * one-time invite URL (`<SHARE_BASE_URL>/invite/<rawToken>`); the raw token
 * appears EXACTLY ONCE and is never recoverable.
 *
 * Unknown space → 404. A non-manager → 403. An invalid role/maxUses → 400.
 * Both-channels parity with the MCP `create_invite` tool. Emits
 * space.invite_created (in the service).
 *
 * AUTH-SENSITIVE: an accepted invite creates an account + grants membership, so
 * minting one is owner/admin-only and the link is a sha256-at-rest capability.
 */
import { NextResponse } from "next/server";
import { getPrincipal, isStaff } from "@/lib/auth";
import { resolvePrincipalUserId } from "@/lib/principal-user";
import { canManageSpace, getSpaceBySlug } from "@/lib/spaces";
import { createInvite, INVITE_ROLES, type InviteRole } from "@/lib/invites/invites";

function err(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

type RouteContext = { params: Promise<{ slug: string }> };

export async function POST(req: Request, { params }: RouteContext) {
  const principal = await getPrincipal(req.headers as unknown as Headers);
  if (!isStaff(principal)) return err(403, "Forbidden — staff only");

  const { slug } = await params;
  const space = await getSpaceBySlug(slug);
  if (!space) return err(404, "Not found");
  if (!(await canManageSpace(principal, space))) {
    return err(403, "Forbidden — only an admin or the space owner can create invites");
  }

  const createdByUserId = await resolvePrincipalUserId(principal);
  if (createdByUserId == null) {
    return err(400, "Cannot resolve your user identity");
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err(400, "Invalid JSON body");
  }
  const b = body as Record<string, unknown>;

  if (typeof b.role !== "string" || !INVITE_ROLES.includes(b.role as InviteRole)) {
    return err(400, "Invalid role — must be 'writer' or 'reader'");
  }
  let email: string | undefined;
  if (b.email !== undefined && b.email !== null) {
    if (typeof b.email !== "string") return err(400, "Invalid email");
    email = b.email;
  }
  // expiresInDays: omitted → 7d default; null → never; number → that many days.
  let expiresInDays: number | null | undefined;
  if (b.expiresInDays === null) {
    expiresInDays = null;
  } else if (b.expiresInDays !== undefined) {
    if (typeof b.expiresInDays !== "number" || b.expiresInDays < 0) {
      return err(400, "Invalid expiresInDays — a non-negative number or null");
    }
    expiresInDays = b.expiresInDays === 0 ? null : b.expiresInDays;
  }
  let maxUses: number | undefined;
  if (b.maxUses !== undefined) {
    if (typeof b.maxUses !== "number" || !Number.isInteger(b.maxUses) || b.maxUses < 1) {
      return err(400, "Invalid maxUses — a positive integer");
    }
    maxUses = b.maxUses;
  }

  const out = await createInvite({
    spaceSlug: slug,
    role: b.role as InviteRole,
    createdByUserId,
    email,
    expiresInDays,
    maxUses,
    actorName: principal.name,
  });
  if (!out.ok) {
    if (out.error === "unknown-space") return err(404, "Not found");
    return err(400, out.error);
  }

  return NextResponse.json(
    {
      ok: true,
      id: out.id,
      inviteUrl: out.inviteUrl,
      role: out.role,
      expiresAt: out.expiresAt,
      maxUses: out.maxUses,
    },
    { status: 201 },
  );
}
