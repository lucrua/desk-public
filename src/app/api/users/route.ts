import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { listUsers, createUser } from "@/lib/users";

function err(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(req: Request) {
  const principal = await getPrincipal(req.headers);
  if (principal.kind !== "admin") {
    return err(403, "Forbidden — admin only");
  }

  const users = await listUsers();
  return NextResponse.json({ users });
}

export async function POST(req: Request) {
  const principal = await getPrincipal(req.headers);
  if (principal.kind !== "admin") {
    return err(403, "Forbidden — admin only");
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err(400, "Invalid JSON body");
  }

  const b = body as Record<string, unknown>;
  const { email, tokenName, displayName } = b;

  if (!displayName || typeof displayName !== "string" || displayName.trim().length === 0) {
    return err(400, "Missing or invalid displayName — must be a non-empty string");
  }
  if (email !== undefined && typeof email !== "string") {
    return err(400, "email must be a string");
  }
  if (tokenName !== undefined && typeof tokenName !== "string") {
    return err(400, "tokenName must be a string");
  }

  // Role is not accepted — every new row is a member; admin is derived from
  // ADMIN_EMAIL at auth time (single-admin model).
  const user = await createUser({
    email: email as string | undefined,
    tokenName: tokenName as string | undefined,
    displayName: displayName.trim(),
  });

  // createUser returns null for: no identifier (400) OR duplicate (409).
  // Re-derive which case to return the right status — both produced null, so
  // distinguish by whether an identifier was actually present.
  if (user === null) {
    const hasIdentifier =
      (typeof email === "string" && email.trim().length > 0) ||
      (typeof tokenName === "string" && tokenName.trim().length > 0);
    if (!hasIdentifier) {
      return err(400, "Provide at least one of email or service-token Client ID");
    }
    return err(409, "A user with that email or token name already exists");
  }

  return NextResponse.json({ user });
}
