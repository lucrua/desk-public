import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { listUserEmails, addUserEmail } from "@/lib/users";

function err(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/users/[id]/emails — list a user's emails (admin only).
 * Each item carries { id, email, primary, createdAt }; `primary` flags the
 * users.email mirror.
 */
export async function GET(req: Request, { params }: RouteContext) {
  const principal = await getPrincipal(req.headers);
  if (principal.kind !== "admin") return err(403, "Forbidden — admin only");

  const { id: idStr } = await params;
  const id = parseInt(idStr, 10);
  if (Number.isNaN(id)) return err(400, "Invalid id — must be a numeric user id");

  const emails = await listUserEmails(id);
  if (emails === null) return err(404, `User ${id} not found`);
  return NextResponse.json({ emails });
}

/**
 * POST /api/users/[id]/emails — add an email to a user (admin only).
 * Body: { email: string }. The address is normalized (trim + lowercase). A
 * duplicate (already on ANY user) → 409; unknown id → 404; empty email → 400.
 */
export async function POST(req: Request, { params }: RouteContext) {
  const principal = await getPrincipal(req.headers);
  if (principal.kind !== "admin") return err(403, "Forbidden — admin only");

  const { id: idStr } = await params;
  const id = parseInt(idStr, 10);
  if (Number.isNaN(id)) return err(400, "Invalid id — must be a numeric user id");

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err(400, "Invalid JSON body");
  }
  const email = (body as Record<string, unknown>).email;
  if (typeof email !== "string" || email.trim().length === 0) {
    return err(400, "email must be a non-empty string");
  }

  const result = await addUserEmail(id, email, principal.name);
  if (result === "invalid") return err(400, "email must be a non-empty string");
  if (result === "not-found") return err(404, `User ${id} not found`);
  if (result === "duplicate") {
    return err(409, "That email already belongs to a user");
  }
  return NextResponse.json({ ok: true });
}
