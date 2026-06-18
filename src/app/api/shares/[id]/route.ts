import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { setShareComments, deleteShare } from "@/lib/shares";

function err(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Admin share management. Currently exposes the `allowComments` toggle for the
 * share-link comment flow. PATCH /api/shares/[id] { allowComments: boolean }.
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
  if (typeof b.allowComments !== "boolean") {
    return err(400, "Missing or invalid allowComments — must be a boolean");
  }

  const ok = await setShareComments(id, b.allowComments);
  if (!ok) return err(404, `Share ${id} not found`);

  return NextResponse.json({ ok: true, allowComments: b.allowComments });
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
