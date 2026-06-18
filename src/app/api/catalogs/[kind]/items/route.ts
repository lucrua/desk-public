import { NextResponse } from "next/server";
import { getPrincipal, isStaff } from "@/lib/auth";
import { getSchema, listItems, upsertItem } from "@/lib/catalogs";

function err(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

type RouteContext = { params: Promise<{ kind: string }> };

/**
 * GET /api/catalogs/[kind]/items — list items in a kind (staff only). Optional
 * ?status= exact filter and ?q= substring match over itemId/title.
 */
export async function GET(req: Request, { params }: RouteContext) {
  const principal = await getPrincipal(req.headers);
  if (!isStaff(principal)) return err(403, "Forbidden — staff only");
  const { kind } = await params;

  const schema = await getSchema(kind);
  if (!schema) return err(404, `Kind '${kind}' not found`);

  const url = new URL(req.url);
  const status = url.searchParams.get("status") ?? undefined;
  const q = url.searchParams.get("q") ?? undefined;
  const items = await listItems({ kind, status, q });
  return NextResponse.json({ items });
}

/**
 * POST /api/catalogs/[kind]/items — create or update an item (admin only). The
 * id is CLIENT-PROPOSED: body.itemId is validated against the kind's idPattern.
 * Body: { itemId, title, body?, status?, data?, sourceHash? }. `data` is
 * validated against the kind's JSON Schema; links are derived. Emits
 * catalog.item.created/updated.
 */
export async function POST(req: Request, { params }: RouteContext) {
  const principal = await getPrincipal(req.headers);
  if (principal.kind !== "admin") return err(403, "Forbidden — admin only");
  const { kind } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err(400, "Invalid JSON body");
  }
  const b = body as Record<string, unknown>;
  if (typeof b.itemId !== "string") return err(400, "itemId must be a string");
  if (typeof b.title !== "string") return err(400, "title must be a string");

  const result = await upsertItem({
    kind,
    itemId: b.itemId,
    title: b.title,
    body: typeof b.body === "string" ? b.body : undefined,
    status: typeof b.status === "string" ? b.status : undefined,
    data: "data" in b ? b.data : undefined,
    sourceHash: typeof b.sourceHash === "string" ? b.sourceHash : undefined,
    actorName: principal.name,
  });
  if (!result.ok) {
    return err(result.code === "not-found" ? 404 : 400, result.error);
  }
  return NextResponse.json({ item: result.value });
}
