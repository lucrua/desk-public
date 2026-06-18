import { NextResponse } from "next/server";
import { getPrincipal, isStaff } from "@/lib/auth";
import { getCard, getCardActivity } from "@/lib/cards";

function err(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/cards/[id]/events — the card's activity trail (staff only): every
 * card.* event for this card, oldest-first. This is the dedicated trail surface
 * the drawer fetches; get_card also bundles it.
 */
export async function GET(req: Request, { params }: RouteContext) {
  const principal = await getPrincipal(req.headers);
  if (!isStaff(principal)) return err(403, "Forbidden — staff only");

  const { id: idStr } = await params;
  const id = parseInt(idStr, 10);
  if (Number.isNaN(id)) return err(400, "Invalid id — must be a numeric card id");

  const card = await getCard(id);
  if (!card) return err(404, `Card ${id} not found`);

  const events = await getCardActivity(id);
  return NextResponse.json({ events });
}
