import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { dismissAccessRequest } from "@/lib/access-requests";

function err(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

type RouteContext = { params: Promise<{ id: string }> };

export async function DELETE(req: Request, { params }: RouteContext) {
  const principal = await getPrincipal(req.headers);
  if (principal.kind !== "admin") {
    return err(403, "Forbidden — admin only");
  }

  const { id: idStr } = await params;
  const id = parseInt(idStr, 10);
  if (Number.isNaN(id)) {
    return err(400, "Invalid id — must be a numeric access-request id");
  }

  const result = await dismissAccessRequest(id);
  if (result === "not-found") {
    return err(404, `Access request ${id} not found`);
  }

  return NextResponse.json({ ok: true });
}
