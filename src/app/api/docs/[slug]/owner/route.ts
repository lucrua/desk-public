/**
 * PUT /api/docs/[slug]/owner — reassign the doc's owner (admin only).
 *
 * Body: { ownerUserId: number }
 *   - ownerUserId: the target user's id (must be an active users row).
 *
 * Emits a doc.owner_changed event. Returns the updated slug + new ownerUserId.
 */
import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { setDocOwner } from "@/lib/docs";

function err(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

type RouteContext = { params: Promise<{ slug: string }> };

export async function PUT(req: Request, { params }: RouteContext) {
  const principal = await getPrincipal(req.headers as unknown as Headers);
  if (principal.kind !== "admin") return err(403, "Forbidden — admin only");

  const { slug } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err(400, "Invalid JSON body");
  }

  const b = body as Record<string, unknown>;
  if (typeof b.ownerUserId !== "number" || !Number.isInteger(b.ownerUserId) || b.ownerUserId <= 0) {
    return err(400, "Missing or invalid ownerUserId — must be a positive integer");
  }

  const result = await setDocOwner(slug, b.ownerUserId, principal.name);
  if (result === "not-found") return err(404, `Doc '${slug}' not found`);
  if (result === "invalid-user") {
    return err(400, "Target user does not exist or is inactive");
  }

  return NextResponse.json({ ok: true, slug, ownerUserId: b.ownerUserId });
}
