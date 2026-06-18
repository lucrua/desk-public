import { NextResponse } from "next/server";
import { getPrincipal, isStaff } from "@/lib/auth";
import { getSchema, upsertSchema, deleteSchema } from "@/lib/catalogs";

function err(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

type RouteContext = { params: Promise<{ kind: string }> };

/**
 * GET /api/catalogs/[kind] — one kind's schema + item count (staff only).
 */
export async function GET(req: Request, { params }: RouteContext) {
  const principal = await getPrincipal(req.headers);
  if (!isStaff(principal)) return err(403, "Forbidden — staff only");
  const { kind } = await params;
  const schema = await getSchema(kind);
  if (!schema) return err(404, `Kind '${kind}' not found`);
  return NextResponse.json({ kind: schema });
}

/**
 * PATCH /api/catalogs/[kind] — update a kind's label / idPattern / schema
 * (admin only). The kind slug itself is immutable (it keys items + event
 * payloads). Body: { label?, idPattern?, schema? } — omitted fields keep their
 * current value. Emits catalog.schema.updated.
 */
export async function PATCH(req: Request, { params }: RouteContext) {
  const principal = await getPrincipal(req.headers);
  if (principal.kind !== "admin") return err(403, "Forbidden — admin only");
  const { kind } = await params;

  const existing = await getSchema(kind);
  if (!existing) return err(404, `Kind '${kind}' not found`);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err(400, "Invalid JSON body");
  }
  const b = body as Record<string, unknown>;

  const result = await upsertSchema({
    kind,
    label: typeof b.label === "string" ? b.label : existing.label,
    idPattern: typeof b.idPattern === "string" ? b.idPattern : existing.idPattern,
    schema: "schema" in b ? b.schema : existing.schema,
    actorName: principal.name,
  });
  if (!result.ok) return err(400, result.error);
  return NextResponse.json({ kind: result.value });
}

/**
 * DELETE /api/catalogs/[kind] — delete a kind (admin only). Refuses with 409 if
 * the kind still has items — delete them first. Emits catalog.schema.deleted.
 */
export async function DELETE(req: Request, { params }: RouteContext) {
  const principal = await getPrincipal(req.headers);
  if (principal.kind !== "admin") return err(403, "Forbidden — admin only");
  const { kind } = await params;
  const result = await deleteSchema(kind, principal.name);
  if (!result.ok) {
    if (result.code === "not-found") return err(404, result.error);
    return err(409, result.error);
  }
  return NextResponse.json({ ok: true, kind });
}
