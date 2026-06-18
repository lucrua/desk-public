import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { approveAccessRequest } from "@/lib/access-requests";

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
  if (Number.isNaN(id)) {
    return err(400, "Invalid id — must be a numeric access-request id");
  }

  // displayName + aliasOfUserId are optional. An empty body is fine (defaults
  // apply: create a new user). aliasOfUserId attaches the request's email to an
  // existing user instead of creating an account.
  let displayName: string | undefined;
  let aliasOfUserId: number | undefined;
  const raw = await req.text();
  if (raw.trim().length > 0) {
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return err(400, "Invalid JSON body");
    }
    const b = body as Record<string, unknown>;
    if ("displayName" in b && b.displayName !== undefined) {
      if (typeof b.displayName !== "string") {
        return err(400, "displayName must be a string");
      }
      displayName = b.displayName;
    }
    if ("aliasOfUserId" in b && b.aliasOfUserId !== undefined && b.aliasOfUserId !== null) {
      if (typeof b.aliasOfUserId !== "number" || !Number.isInteger(b.aliasOfUserId)) {
        return err(400, "aliasOfUserId must be an integer user id");
      }
      aliasOfUserId = b.aliasOfUserId;
    }
  }

  const result = await approveAccessRequest(id, {
    displayName,
    aliasOfUserId,
    by: principal.name,
  });

  if (result.status === "not-found") {
    return err(404, `Access request ${id} not found`);
  }
  if (result.status === "alias-not-found") {
    return err(404, `Alias target user ${aliasOfUserId} not found`);
  }
  if (result.status === "duplicate") {
    // A users row / user_emails row with that email already existed — the
    // request was satisfied and removed. Surface as a conflict so the UI can
    // explain it.
    return err(409, "A user with that email already exists — request cleared");
  }

  return NextResponse.json({ ok: true, userId: result.userId });
}
