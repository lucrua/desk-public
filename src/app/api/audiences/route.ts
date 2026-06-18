import { NextResponse } from "next/server";
import { getPrincipal, isStaff } from "@/lib/auth";
import { listAudiences, createAudience } from "@/lib/audiences";

function err(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

const KEY_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Staff (admin or member) may read the audience list — UploadDoc needs it. */
export async function GET(req: Request) {
  const principal = await getPrincipal(req.headers);
  if (!isStaff(principal)) {
    return err(403, "Forbidden — staff only");
  }
  const audiences = await listAudiences();
  return NextResponse.json({ audiences });
}

/** Only an admin may create an audience. */
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
  const { key, label, memberVisible } = b;

  if (!key || typeof key !== "string" || !KEY_RE.test(key)) {
    return err(400, "Missing or invalid key (must match ^[a-z0-9][a-z0-9-]*$)");
  }
  if (!label || typeof label !== "string" || label.trim().length === 0) {
    return err(400, "Missing or invalid label — must be a non-empty string");
  }
  if (memberVisible !== undefined && typeof memberVisible !== "boolean") {
    return err(400, "memberVisible must be a boolean");
  }

  const audience = await createAudience({
    key,
    label,
    memberVisible: memberVisible === true,
  });

  // createAudience returns null for a duplicate key or an invalid key/label.
  // Key + label were already validated above, so null here means duplicate.
  if (audience === null) {
    return err(409, "An audience with that key already exists");
  }

  return NextResponse.json({ audience });
}
