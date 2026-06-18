import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { renameBucket, deleteBucket } from "@/lib/buckets";

function err(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

type RouteContext = { params: Promise<{ id: string }> };

/** PATCH /api/buckets/[id] — rename a bucket (admin only). Body: { label }. */
export async function PATCH(req: Request, { params }: RouteContext) {
  const principal = await getPrincipal(req.headers);
  if (principal.kind !== "admin") return err(403, "Forbidden — admin only");

  const { id: idStr } = await params;
  const id = parseInt(idStr, 10);
  if (Number.isNaN(id)) return err(400, "Invalid id — must be a numeric bucket id");

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err(400, "Invalid JSON body");
  }
  const b = body as Record<string, unknown>;
  if (typeof b.label !== "string" || b.label.trim().length === 0) {
    return err(400, "label must be a non-empty string");
  }

  const result = await renameBucket(id, b.label, principal.name);
  if (result === "not-found") return err(404, `Bucket ${id} not found`);
  if (result === "invalid") return err(400, "label must be a non-empty string");
  return NextResponse.json({ ok: true });
}

/**
 * DELETE /api/buckets/[id] — delete a bucket (admin only). Refuses (409) when
 * ANY card (live or archived) still references it — re-point or archive-restore
 * those first.
 */
export async function DELETE(req: Request, { params }: RouteContext) {
  const principal = await getPrincipal(req.headers);
  if (principal.kind !== "admin") return err(403, "Forbidden — admin only");

  const { id: idStr } = await params;
  const id = parseInt(idStr, 10);
  if (Number.isNaN(id)) return err(400, "Invalid id — must be a numeric bucket id");

  const result = await deleteBucket(id, principal.name);
  if (result === "not-found") return err(404, `Bucket ${id} not found`);
  if (result === "in-use") {
    return err(409, "Bucket is not empty — move or archive its cards before deleting");
  }
  return NextResponse.json({ ok: true });
}
