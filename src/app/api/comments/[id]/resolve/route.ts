import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { resolveComment } from "@/lib/comments";

function err(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: RouteContext) {
  const principal = await getPrincipal(req.headers);
  if (principal.kind !== "admin") return err(403, "Forbidden — admin only");

  const { id: idStr } = await params;
  const id = parseInt(idStr, 10);
  if (isNaN(id)) return err(400, "Invalid id — must be a numeric comment id");

  const ok = await resolveComment(id);
  if (!ok) return err(404, `Comment ${id} not found`);

  return NextResponse.json({ ok: true });
}
