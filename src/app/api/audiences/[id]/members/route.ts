import { NextResponse } from "next/server";
import { getPrincipal, isStaff } from "@/lib/auth";
import { listAudienceMembers, addAudienceMember } from "@/lib/audiences";

function err(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/audiences/[id]/members — list the members of an audience (the users
 * who see its docs via membership, on top of the member_visible flag). Staff-
 * readable (the admin UI's member chips); a member can read the group roster.
 * 404 when the audience id is unknown.
 */
export async function GET(req: Request, { params }: RouteContext) {
  const principal = await getPrincipal(req.headers);
  if (!isStaff(principal)) return err(403, "Forbidden — staff only");

  const { id: idStr } = await params;
  const id = parseInt(idStr, 10);
  if (Number.isNaN(id)) {
    return err(400, "Invalid id — must be a numeric audience id");
  }

  const members = await listAudienceMembers(id);
  if (members === null) return err(404, `Audience ${id} not found`);
  return NextResponse.json({ members });
}

/**
 * POST /api/audiences/[id]/members — add a user to the audience (admin only).
 * Body: { userId: number }. Idempotent (re-adding an existing member → 200,
 * added:false, no event). 404 on unknown audience or user. Emits
 * audience.member_added on a real insert.
 */
export async function POST(req: Request, { params }: RouteContext) {
  const principal = await getPrincipal(req.headers);
  if (principal.kind !== "admin") return err(403, "Forbidden — admin only");

  const { id: idStr } = await params;
  const id = parseInt(idStr, 10);
  if (Number.isNaN(id)) {
    return err(400, "Invalid id — must be a numeric audience id");
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err(400, "Invalid JSON body");
  }
  const b = body as Record<string, unknown>;
  if (
    typeof b.userId !== "number" ||
    !Number.isInteger(b.userId) ||
    b.userId <= 0
  ) {
    return err(400, "userId must be a positive integer");
  }

  const result = await addAudienceMember(id, b.userId, principal.name);
  if (!result.ok) {
    if (result.reason === "audience-not-found") {
      return err(404, `Audience ${id} not found`);
    }
    return err(404, `User ${b.userId} not found`);
  }

  return NextResponse.json(
    { ok: true, added: result.added, member: result.item },
    { status: result.added ? 201 : 200 },
  );
}
