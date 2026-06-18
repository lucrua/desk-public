import { NextResponse } from "next/server";
import { getPrincipal, isStaff } from "@/lib/auth";
import { getItem, upsertItem, deleteItem } from "@/lib/catalogs";

function err(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

type RouteContext = { params: Promise<{ kind: string; itemId: string }> };

/**
 * GET /api/catalogs/[kind]/items/[itemId] — one item plus its outbound +
 * inbound typed links (staff only). 404 if unknown.
 */
export async function GET(req: Request, { params }: RouteContext) {
  const principal = await getPrincipal(req.headers);
  if (!isStaff(principal)) return err(403, "Forbidden — staff only");
  const { kind, itemId } = await params;
  const result = await getItem(kind, decodeURIComponent(itemId));
  if (!result) return err(404, `Item '${itemId}' not found in '${kind}'`);
  return NextResponse.json(result);
}

/**
 * PATCH /api/catalogs/[kind]/items/[itemId] — update an item in place (admin
 * only). The itemId in the URL is authoritative (id is immutable per item).
 * Body: { title?, body?, status?, data? }. Re-validates data + re-derives
 * links. Emits catalog.item.updated.
 */
export async function PATCH(req: Request, { params }: RouteContext) {
  const principal = await getPrincipal(req.headers);
  if (principal.kind !== "admin") return err(403, "Forbidden — admin only");
  const { kind, itemId: rawItemId } = await params;
  const itemId = decodeURIComponent(rawItemId);

  const existing = await getItem(kind, itemId);
  if (!existing) return err(404, `Item '${itemId}' not found in '${kind}'`);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err(400, "Invalid JSON body");
  }
  const b = body as Record<string, unknown>;

  const result = await upsertItem({
    kind,
    itemId,
    title: typeof b.title === "string" ? b.title : existing.item.title,
    body: typeof b.body === "string" ? b.body : existing.item.body,
    status: typeof b.status === "string" ? b.status : existing.item.status,
    data: "data" in b ? b.data : existing.item.data,
    actorName: principal.name,
  });
  if (!result.ok) {
    return err(result.code === "not-found" ? 404 : 400, result.error);
  }
  return NextResponse.json({ item: result.value });
}

/**
 * DELETE /api/catalogs/[kind]/items/[itemId] — hard-delete an item (admin
 * only). Cascades its links (from + to). Emits catalog.item.deleted.
 */
export async function DELETE(req: Request, { params }: RouteContext) {
  const principal = await getPrincipal(req.headers);
  if (principal.kind !== "admin") return err(403, "Forbidden — admin only");
  const { kind, itemId: rawItemId } = await params;
  const itemId = decodeURIComponent(rawItemId);
  const result = await deleteItem(kind, itemId, principal.name);
  if (!result.ok) return err(404, result.error);
  return NextResponse.json({ ok: true, kind, itemId });
}
