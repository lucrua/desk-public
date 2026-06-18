import { NextResponse } from "next/server";
import { getPrincipal, isStaff } from "@/lib/auth";
import { listCards, createCard, resolveMemberUserId } from "@/lib/cards";

function err(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

/**
 * GET /api/cards — list cards (staff only; the board is internal, not
 * audience-scoped). Optional filters: ?bucketId=, ?ownerUserId= (or owner=me),
 * ?includeArchived=1.
 */
export async function GET(req: Request) {
  const principal = await getPrincipal(req.headers);
  if (!isStaff(principal)) return err(403, "Forbidden — staff only");

  const url = new URL(req.url);

  let bucketId: number | undefined;
  const rawBucket = url.searchParams.get("bucketId");
  if (rawBucket !== null && rawBucket.trim().length > 0) {
    const n = Number(rawBucket);
    if (!Number.isInteger(n) || n <= 0) return err(400, "bucketId must be a positive integer");
    bucketId = n;
  }

  let ownerUserId: number | undefined;
  const rawOwner = url.searchParams.get("ownerUserId");
  const ownerSugar = url.searchParams.get("owner");
  if (ownerSugar === "me") {
    const me = await resolveMemberUserId(principal);
    // No users row → owner=me matches nothing; return [] rather than all cards.
    if (me == null) return NextResponse.json({ cards: [] });
    ownerUserId = me;
  } else if (rawOwner !== null && rawOwner.trim().length > 0) {
    const n = Number(rawOwner);
    if (!Number.isInteger(n) || n <= 0) return err(400, "ownerUserId must be a positive integer");
    ownerUserId = n;
  }

  const includeArchived = url.searchParams.get("includeArchived") === "1";

  const cards = await listCards({ bucketId, ownerUserId, includeArchived });
  return NextResponse.json({ cards });
}

/**
 * POST /api/cards — create a card (any staff principal; members may create).
 * Body: { title, body?, bucketId? | bucketKey?, ownerUserId?, docSlug?,
 * checklist? }. A member-created card defaults its owner to the member (so they
 * can keep editing it); admins may pass an explicit ownerUserId.
 */
export async function POST(req: Request) {
  const principal = await getPrincipal(req.headers);
  if (!isStaff(principal)) return err(403, "Forbidden — staff only");

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err(400, "Invalid JSON body");
  }
  const b = body as Record<string, unknown>;

  // Owner default: a member creating a card owns it (so they retain edit
  // rights). Admins may set ownerUserId explicitly; if they omit it the card is
  // unowned. A member may NOT assign someone else on create — force it to self.
  let ownerUserId: number | null | undefined = undefined;
  if (principal.kind === "member") {
    ownerUserId = await resolveMemberUserId(principal);
  } else if ("ownerUserId" in b) {
    const v = b.ownerUserId;
    if (v !== null && (typeof v !== "number" || !Number.isInteger(v))) {
      return err(400, "ownerUserId must be an integer or null");
    }
    ownerUserId = v as number | null;
  }

  const result = await createCard({
    title: b.title,
    body: b.body,
    bucketId: typeof b.bucketId === "number" ? b.bucketId : undefined,
    bucketKey: typeof b.bucketKey === "string" ? b.bucketKey : undefined,
    ownerUserId,
    docSlug: typeof b.docSlug === "string" ? b.docSlug : null,
    checklist: b.checklist,
    actorName: principal.name,
  });

  if (!result.ok) {
    const status = result.error === "bucket not found" || result.error === "owner user not found" ? 404 : 400;
    return err(status, result.error);
  }
  return NextResponse.json({ card: result.card });
}
