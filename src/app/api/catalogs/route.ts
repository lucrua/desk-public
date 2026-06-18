import { NextResponse } from "next/server";
import { getPrincipal, isStaff } from "@/lib/auth";
import { listKinds, upsertSchema } from "@/lib/catalogs";

function err(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

/**
 * GET /api/catalogs — list every catalog kind (schema-as-data registries), each
 * with an item count. Staff only (catalogs are an internal coordination surface;
 * members read but never write).
 */
export async function GET(req: Request) {
  const principal = await getPrincipal(req.headers);
  if (!isStaff(principal)) return err(403, "Forbidden — staff only");
  const kinds = await listKinds();
  return NextResponse.json({ kinds });
}

/**
 * POST /api/catalogs — create (or upsert) a kind (admin only).
 * Body: { kind, label, idPattern, schema }. Validates the slug, a compilable
 * idPattern, and a compilable JSON Schema. Emits catalog.schema.created/updated.
 */
export async function POST(req: Request) {
  const principal = await getPrincipal(req.headers);
  if (principal.kind !== "admin") return err(403, "Forbidden — admin only");

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err(400, "Invalid JSON body");
  }
  const b = body as Record<string, unknown>;
  if (typeof b.kind !== "string") return err(400, "kind must be a string");
  if (typeof b.label !== "string") return err(400, "label must be a string");
  if (typeof b.idPattern !== "string") return err(400, "idPattern must be a string");

  const result = await upsertSchema({
    kind: b.kind,
    label: b.label,
    idPattern: b.idPattern,
    schema: b.schema ?? {},
    actorName: principal.name,
  });
  if (!result.ok) return err(result.code === "invalid" ? 400 : 400, result.error);
  return NextResponse.json({ kind: result.value });
}
