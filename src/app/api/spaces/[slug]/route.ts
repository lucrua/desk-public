/**
 * PATCH /api/spaces/[slug] — update a space's listing visibility.
 *
 * Body: { visibility: "private" | "unlisted" | "public" }. Allowed for an ADMIN
 * or the space's OWNER (canManageSpace) — matching the controls the space-detail
 * UI shows (a non-admin owner sees the visibility control and it must not 403).
 * Visibility governs DISCOVERY only — never the git ACL, which is membership-
 * based. Unknown space → 404. A non-manager (non-admin, non-owner) → 403. An
 * invalid visibility value → 400. Emits space.updated (in the service).
 */
import { NextResponse } from "next/server";
import { getPrincipal, isStaff } from "@/lib/auth";
import {
  canManageSpace,
  getSpaceBySlug,
  setSpaceVisibility,
  type SpaceVisibility,
} from "@/lib/spaces";

function err(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

type RouteContext = { params: Promise<{ slug: string }> };

const VISIBILITIES: SpaceVisibility[] = ["private", "unlisted", "public"];

export async function PATCH(req: Request, { params }: RouteContext) {
  const principal = await getPrincipal(req.headers as unknown as Headers);
  if (!isStaff(principal)) return err(403, "Forbidden — staff only");

  const { slug } = await params;
  const space = await getSpaceBySlug(slug);
  if (!space) return err(404, "Not found");
  if (!(await canManageSpace(principal, space))) {
    return err(403, "Forbidden — only an admin or the space owner can change visibility");
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err(400, "Invalid JSON body");
  }
  const b = body as Record<string, unknown>;
  if (typeof b.visibility !== "string" || !VISIBILITIES.includes(b.visibility as SpaceVisibility)) {
    return err(400, "Invalid visibility — must be 'private', 'unlisted', or 'public'");
  }

  const ok = await setSpaceVisibility(slug, b.visibility as SpaceVisibility, principal.name);
  if (!ok) return err(404, "Not found");
  return NextResponse.json({ ok: true, visibility: b.visibility }, { status: 200 });
}
