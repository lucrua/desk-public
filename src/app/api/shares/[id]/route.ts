import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { setShareComments, setShareEdits, deleteShare } from "@/lib/shares";

function err(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Admin share management. Exposes the per-share `allowComments` (comment flow)
 * and `allowEdits` ("suggest an edit" flow, convergence fix-pass Slice 3)
 * toggles. PATCH /api/shares/[id] { allowComments?: boolean, allowEdits?: boolean }.
 * The two flags are INDEPENDENT — a request may set either, or both; at least
 * one boolean is required. REST-only, admin-only (no MCP tool), mirroring how
 * allowComments has always been toggled.
 */
export async function PATCH(req: Request, { params }: RouteContext) {
  const principal = await getPrincipal(req.headers);
  if (principal.kind !== "admin") return err(403, "Forbidden — admin only");

  const { id: idStr } = await params;
  const id = parseInt(idStr, 10);
  if (isNaN(id)) return err(400, "Invalid id — must be a numeric share id");

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err(400, "Invalid JSON body");
  }

  const b = body as Record<string, unknown>;
  const hasComments = "allowComments" in b;
  const hasEdits = "allowEdits" in b;
  if (!hasComments && !hasEdits) {
    return err(400, "Missing allowComments or allowEdits — at least one boolean required");
  }
  if (hasComments && typeof b.allowComments !== "boolean") {
    return err(400, "Invalid allowComments — must be a boolean");
  }
  if (hasEdits && typeof b.allowEdits !== "boolean") {
    return err(400, "Invalid allowEdits — must be a boolean");
  }

  const out: { ok: true; allowComments?: boolean; allowEdits?: boolean } = { ok: true };
  if (hasComments) {
    const ok = await setShareComments(id, b.allowComments as boolean);
    if (!ok) return err(404, `Share ${id} not found`);
    out.allowComments = b.allowComments as boolean;
  }
  if (hasEdits) {
    const ok = await setShareEdits(id, b.allowEdits as boolean);
    if (!ok) return err(404, `Share ${id} not found`);
    out.allowEdits = b.allowEdits as boolean;
  }

  return NextResponse.json(out);
}

/**
 * DELETE /api/shares/[id] — stage-2 delete a share link (admin only).
 *
 * Distinct from PATCH .../revoke (stage 1). Stage 2 sets deleted_at and
 * revokes if not already revoked. The row is KEPT (share_views / comments
 * FK it). The deleted share no longer appears in list views. Idempotent.
 */
export async function DELETE(req: Request, { params }: RouteContext) {
  const principal = await getPrincipal(req.headers);
  if (principal.kind !== "admin") return err(403, "Forbidden — admin only");

  const { id: idStr } = await params;
  const id = parseInt(idStr, 10);
  if (isNaN(id)) return err(400, "Invalid id — must be a numeric share id");

  const done = await deleteShare(id);
  if (!done) return err(404, `Share ${id} not found`);

  return NextResponse.json({ ok: true, id });
}
