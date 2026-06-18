import { NextResponse } from "next/server";
import { getPrincipal, isStaff } from "@/lib/auth";
import {
  getCard,
  getCardActivity,
  updateCard,
  assignCard,
  setCardArchived,
  canEditCard,
  resolveMemberUserId,
} from "@/lib/cards";

function err(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

type RouteContext = { params: Promise<{ id: string }> };

async function parseId(params: RouteContext["params"]): Promise<number | null> {
  const { id } = await params;
  const n = parseInt(id, 10);
  return Number.isNaN(n) ? null : n;
}

/**
 * GET /api/cards/[id] — one card plus its activity trail (staff only). The
 * trail is the card.* events for this card, oldest-first (drives the drawer's
 * Activity section). Mirrors get_card in MCP.
 */
export async function GET(req: Request, { params }: RouteContext) {
  const principal = await getPrincipal(req.headers);
  if (!isStaff(principal)) return err(403, "Forbidden — staff only");

  const id = await parseId(params);
  if (id == null) return err(400, "Invalid id — must be a numeric card id");

  const card = await getCard(id);
  if (!card) return err(404, `Card ${id} not found`);
  const activity = await getCardActivity(id);
  return NextResponse.json({ card, activity });
}

/**
 * PATCH /api/cards/[id] — update fields and/or assign an owner and/or archive.
 *
 *   - title / body / docSlug / checklist : editable by admin OR the card owner.
 *   - ownerUserId                        : admin only (owner reassignment).
 *   - archived (boolean)                 : editable by admin OR the card owner.
 *
 * A member who isn't the owner gets 403 for any of these.
 */
export async function PATCH(req: Request, { params }: RouteContext) {
  const principal = await getPrincipal(req.headers);
  if (!isStaff(principal)) return err(403, "Forbidden — staff only");

  const id = await parseId(params);
  if (id == null) return err(400, "Invalid id — must be a numeric card id");

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err(400, "Invalid JSON body");
  }
  const b = body as Record<string, unknown>;

  const card = await getCard(id);
  if (!card) return err(404, `Card ${id} not found`);

  const memberUserId = principal.kind === "member" ? await resolveMemberUserId(principal) : null;
  const mayEdit = canEditCard(principal, card, memberUserId);

  const wantsAssign = "ownerUserId" in b;
  const wantsArchive = "archived" in b;
  const wantsFields = "title" in b || "body" in b || "docSlug" in b || "checklist" in b;

  // Owner reassignment is admin-only.
  if (wantsAssign && principal.kind !== "admin") {
    return err(403, "Forbidden — owner reassignment is admin only");
  }
  // Field/archive edits require edit rights (admin or owner).
  if ((wantsFields || wantsArchive) && !mayEdit) {
    return err(403, "Forbidden — members may only edit cards they own");
  }

  // Apply assign first (admin-only, already gated), then field edits, then
  // archive — each its own event so the trail reads naturally.
  if (wantsAssign) {
    const v = b.ownerUserId;
    if (v !== null && (typeof v !== "number" || !Number.isInteger(v))) {
      return err(400, "ownerUserId must be an integer or null");
    }
    const r = await assignCard(id, v as number | null, principal.name);
    if (!r.ok) return err(r.error === "owner user not found" ? 404 : 400, r.error);
  }

  if (wantsFields) {
    const r = await updateCard(id, {
      title: "title" in b ? b.title : undefined,
      body: "body" in b ? b.body : undefined,
      docSlug: "docSlug" in b ? (b.docSlug as string | null) : undefined,
      checklist: "checklist" in b ? b.checklist : undefined,
      actorName: principal.name,
    });
    if (!r.ok) return err(r.code === "not-found" ? 404 : 400, r.error);
  }

  if (wantsArchive) {
    if (typeof b.archived !== "boolean") return err(400, "archived must be a boolean");
    const r = await setCardArchived(id, b.archived, principal.name);
    if (!r.ok) return err(r.code === "not-found" ? 404 : 400, r.error);
  }

  if (!wantsAssign && !wantsFields && !wantsArchive) {
    return err(400, "Nothing to update");
  }

  const updated = await getCard(id);
  return NextResponse.json({ card: updated });
}

/**
 * DELETE /api/cards/[id] — archive the card (soft). Same authz as a field edit
 * (admin or owner). "Delete" is an archive, matching the design's archived
 * strip + Restore.
 */
export async function DELETE(req: Request, { params }: RouteContext) {
  const principal = await getPrincipal(req.headers);
  if (!isStaff(principal)) return err(403, "Forbidden — staff only");

  const id = await parseId(params);
  if (id == null) return err(400, "Invalid id — must be a numeric card id");

  const card = await getCard(id);
  if (!card) return err(404, `Card ${id} not found`);

  const memberUserId = principal.kind === "member" ? await resolveMemberUserId(principal) : null;
  if (!canEditCard(principal, card, memberUserId)) {
    return err(403, "Forbidden — members may only archive cards they own");
  }

  const r = await setCardArchived(id, true, principal.name);
  if (!r.ok) return err(r.code === "not-found" ? 404 : 400, r.error);
  return NextResponse.json({ card: r.card });
}
