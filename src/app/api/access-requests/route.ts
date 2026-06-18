import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { listAccessRequests } from "@/lib/access-requests";

function err(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(req: Request) {
  const principal = await getPrincipal(req.headers);
  if (principal.kind !== "admin") {
    return err(403, "Forbidden — admin only");
  }

  const accessRequests = await listAccessRequests();
  return NextResponse.json({ accessRequests });
}
