import { NextResponse } from "next/server";
import { getPrincipal, isStaff } from "@/lib/auth";
import { getCard, moveCard, canEditCard, resolveMemberUserId } from "@/lib/cards";

function err(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/cards/[id]/move — move a card to a bucket at a slot.
 * Body: { bucketId, index? } (index = 0-based slot; omit for end).
 *
 * Authz: admin OR the card owner (members move only their own cards). A member
 * may reorder their own card within any bucket — reorder is just a move.
 */
export async function POST(req: Request, { params }: RouteContext) {
  const principal = await getPrincipal(req.headers);
  if (!isStaff(principal)) return err(403, "Forbidden — staff only");

  const { id: idStr } = await params;
  const id = parseInt(idStr, 10);
  if (Number.isNaN(id)) return err(400, "Invalid id — must be a numeric card id");

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err(400, "Invalid JSON body");
  }
  const b = body as Record<string, unknown>;

  if (typeof b.bucketId !== "number" || !Number.isInteger(b.bucketId)) {
    return err(400, "bucketId must be an integer");
  }
  let index: number | null = null;
  if (b.index !== undefined && b.index !== null) {
    if (typeof b.index !== "number" || !Number.isInteger(b.index) || b.index < 0) {
      return err(400, "index must be a non-negative integer");
    }
    index = b.index;
  }

  const card = await getCard(id);
  if (!card) return err(404, `Card ${id} not found`);

  const memberUserId = principal.kind === "member" ? await resolveMemberUserId(principal) : null;
  if (!canEditCard(principal, card, memberUserId)) {
    return err(403, "Forbidden — members may only move cards they own");
  }

  const r = await moveCard(id, b.bucketId, index, principal.name);
  if (!r.ok) return err(r.code === "not-found" ? 404 : (r.error === "bucket not found" ? 404 : 400), r.error);
  return NextResponse.json({ card: r.card });
}
