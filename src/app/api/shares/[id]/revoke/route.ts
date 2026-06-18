import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { revokeShare } from "@/lib/shares";

function err(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: RouteContext) {
  const principal = await getPrincipal(req.headers);
  if (principal.kind !== "admin") {
    return err(403, "Forbidden — admin only");
  }

  const { id: idStr } = await params;
  const id = parseInt(idStr, 10);
  if (isNaN(id)) {
    return err(400, "Invalid id — must be a numeric share id");
  }

  const ok = await revokeShare(id);
  if (!ok) {
    return err(404, `Share ${id} not found or already revoked`);
  }

  return NextResponse.json({ ok: true });
}
