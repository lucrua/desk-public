import { NextResponse } from "next/server";
import { getPrincipal, isStaff } from "@/lib/auth";
import { listBuckets, createBucket, reorderBuckets } from "@/lib/buckets";

function err(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

/** GET /api/buckets — list buckets (staff only), ordered by column position. */
export async function GET(req: Request) {
  const principal = await getPrincipal(req.headers);
  if (!isStaff(principal)) return err(403, "Forbidden — staff only");
  const buckets = await listBuckets();
  return NextResponse.json({ buckets });
}

/**
 * POST /api/buckets — create a bucket at the end of the column order (admin
 * only). Body: { label, key? }. Key is derived from the label when omitted.
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

  if (typeof b.label !== "string" || b.label.trim().length === 0) {
    return err(400, "Missing or invalid label — must be a non-empty string");
  }
  if (b.key !== undefined && typeof b.key !== "string") {
    return err(400, "key must be a string");
  }

  const bucket = await createBucket({
    label: b.label,
    key: typeof b.key === "string" ? b.key : undefined,
    actorName: principal.name,
  });
  // null = invalid key (after derivation) or a duplicate key.
  if (bucket === null) {
    return err(409, "Could not create bucket — invalid or duplicate key");
  }
  return NextResponse.json({ bucket });
}

/**
 * PATCH /api/buckets — reorder the columns (admin only). Body: { orderedIds }
 * = the FULL set of bucket ids in their new left-to-right order. This backs the
 * board's "move left" / "move right" (the client computes the new order) and
 * any column drag-reorder. A partial order (missing or unknown id) → 400.
 */
export async function PATCH(req: Request) {
  const principal = await getPrincipal(req.headers);
  if (principal.kind !== "admin") return err(403, "Forbidden — admin only");

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err(400, "Invalid JSON body");
  }
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.orderedIds) || b.orderedIds.some((x) => typeof x !== "number" || !Number.isInteger(x))) {
    return err(400, "orderedIds must be an array of integer bucket ids");
  }

  const result = await reorderBuckets(b.orderedIds as number[], principal.name);
  if (result === "not-found") {
    return err(400, "orderedIds must list every existing bucket exactly once");
  }
  return NextResponse.json({ ok: true });
}
