import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { removeUserEmail } from "@/lib/users";

function err(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

type RouteContext = { params: Promise<{ id: string; email: string }> };

/**
 * DELETE /api/users/[id]/emails/[email] — remove an email from a user (admin
 * only). The [email] path segment is URL-encoded; it's decoded and matched
 * normalized. Removing the last email of a token-less (human) user → 409
 * (last-email guard). Unknown user/email → 404.
 */
export async function DELETE(req: Request, { params }: RouteContext) {
  const principal = await getPrincipal(req.headers);
  if (principal.kind !== "admin") return err(403, "Forbidden — admin only");

  const { id: idStr, email: emailRaw } = await params;
  const id = parseInt(idStr, 10);
  if (Number.isNaN(id)) return err(400, "Invalid id — must be a numeric user id");

  let email: string;
  try {
    email = decodeURIComponent(emailRaw);
  } catch {
    return err(400, "Invalid email path segment");
  }

  const result = await removeUserEmail(id, email, principal.name);
  if (result === "not-found") {
    return err(404, `Email not found on user ${id}`);
  }
  if (result === "last-email") {
    return err(
      409,
      "Can't remove the last email of a user without a service token — they'd have no way to sign in.",
    );
  }
  return NextResponse.json({ ok: true });
}
