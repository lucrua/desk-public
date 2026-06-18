import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { setAudienceMemberVisible, deleteAudience } from "@/lib/audiences";

function err(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

type RouteContext = { params: Promise<{ id: string }> };

/** PATCH — admin only. Currently toggles memberVisible. */
export async function PATCH(req: Request, { params }: RouteContext) {
  const principal = await getPrincipal(req.headers);
  if (principal.kind !== "admin") {
    return err(403, "Forbidden — admin only");
  }

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
  if (!("memberVisible" in b)) {
    return err(400, "Provide memberVisible (boolean)");
  }
  if (typeof b.memberVisible !== "boolean") {
    return err(400, "memberVisible must be a boolean");
  }

  const ok = await setAudienceMemberVisible(id, b.memberVisible);
  if (!ok) {
    return err(404, `Audience ${id} not found`);
  }

  return NextResponse.json({ ok: true });
}

/** DELETE — admin only. Refuses to delete an audience still used by any doc. */
export async function DELETE(req: Request, { params }: RouteContext) {
  const principal = await getPrincipal(req.headers);
  if (principal.kind !== "admin") {
    return err(403, "Forbidden — admin only");
  }

  const { id: idStr } = await params;
  const id = parseInt(idStr, 10);
  if (Number.isNaN(id)) {
    return err(400, "Invalid id — must be a numeric audience id");
  }

  const result = await deleteAudience(id);
  if (result === "not-found") {
    return err(404, `Audience ${id} not found`);
  }
  if (result === "in-use") {
    return err(409, "Audience is in use — re-point its docs before deleting");
  }

  return NextResponse.json({ ok: true });
}
