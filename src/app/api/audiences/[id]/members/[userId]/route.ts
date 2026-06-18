import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { removeAudienceMember } from "@/lib/audiences";

function err(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

type RouteContext = { params: Promise<{ id: string; userId: string }> };

/**
 * DELETE /api/audiences/[id]/members/[userId] — remove a user from the audience
 * (admin only). 404 on an unknown audience id OR a user who isn't a member (both
 * map to "nothing to remove" — no existence signal beyond that). Emits
 * audience.member_removed on a real delete.
 */
export async function DELETE(req: Request, { params }: RouteContext) {
  const principal = await getPrincipal(req.headers);
  if (principal.kind !== "admin") return err(403, "Forbidden — admin only");

  const { id: idStr, userId: userIdStr } = await params;
  const id = parseInt(idStr, 10);
  const userId = parseInt(userIdStr, 10);
  if (Number.isNaN(id)) {
    return err(400, "Invalid id — must be a numeric audience id");
  }
  if (Number.isNaN(userId)) {
    return err(400, "Invalid userId — must be a numeric user id");
  }

  const result = await removeAudienceMember(id, userId, principal.name);
  if (result === "audience-not-found") {
    return err(404, `Audience ${id} not found`);
  }
  if (result === "not-a-member") {
    return err(404, `User ${userId} is not a member of audience ${id}`);
  }
  return NextResponse.json({ ok: true });
}
