/**
 * Spaces REST surface (document-host Phase 1, §14 — both-channels parity with
 * the MCP `list_spaces` / `create_space` tools).
 *
 *   GET  /api/spaces  — list spaces visible to the caller (admins: all;
 *                       members: ones they belong to). Staff only.
 *   POST /api/spaces  — create a space { slug, visibility?, ownerUserId? }.
 *                       Admin only (creating a space is an operator action).
 *
 * Space mutations emit space.* events (in the service). Auth mirrors the rest of
 * the REST API: getPrincipal → isStaff gate, admin checks inline.
 */
import { NextResponse } from "next/server";
import { getPrincipal, isStaff } from "@/lib/auth";
import { resolveMemberUserId } from "@/lib/cards";
import { resolvePrincipalUserId } from "@/lib/principal-user";
import { createSpace, listSpaces, type SpaceVisibility } from "@/lib/spaces";

function err(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

const VISIBILITIES: SpaceVisibility[] = ["private", "unlisted", "public"];

export async function GET(req: Request) {
  const principal = await getPrincipal(req.headers as unknown as Headers);
  if (!isStaff(principal)) return err(403, "Forbidden — staff only");
  const isAdmin = principal.kind === "admin";
  const userId = isAdmin ? null : await resolveMemberUserId(principal);
  const spaces = await listSpaces({ isAdmin, userId });
  return NextResponse.json({ spaces }, { status: 200 });
}

export async function POST(req: Request) {
  const principal = await getPrincipal(req.headers as unknown as Headers);
  if (!isStaff(principal)) return err(403, "Forbidden — staff only");
  if (principal.kind !== "admin") return err(403, "Forbidden — creating a space is admin only");

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err(400, "Invalid JSON body");
  }
  const b = body as Record<string, unknown>;

  if (typeof b.slug !== "string" || b.slug.trim().length === 0) {
    return err(400, "Missing or invalid slug");
  }
  // Visibility defaults to "private" when omitted, but an explicitly-supplied
  // value MUST be one of the three — a bad value (e.g. "banana") is a 400, not a
  // silent coercion to private. (Matches the bad-slug 400 above and PATCH.)
  let visibility: SpaceVisibility = "private";
  if (b.visibility !== undefined) {
    if (typeof b.visibility !== "string" || !VISIBILITIES.includes(b.visibility as SpaceVisibility)) {
      return err(400, "Invalid visibility — must be 'private', 'unlisted', or 'public'");
    }
    visibility = b.visibility as SpaceVisibility;
  }
  // Owner defaults to the creating admin's user id; an explicit ownerUserId is
  // allowed (assigning a space to another user). Resolve the creator's user via
  // resolvePrincipalUserId so this works in dev mode too (principal.userId is
  // only populated on the CF path), matching the token endpoints.
  const ownerUserId =
    typeof b.ownerUserId === "number"
      ? b.ownerUserId
      : await resolvePrincipalUserId(principal);
  if (ownerUserId == null) {
    return err(400, "Cannot resolve an owner for the space (no ownerUserId)");
  }

  const out = await createSpace(b.slug.trim(), ownerUserId, visibility, principal.name);
  if (!out.ok) return err(400, out.error);
  return NextResponse.json(
    { ok: true, space: { slug: out.space.slug, visibility: out.space.visibility, ownerUserId: out.space.ownerUserId } },
    { status: 201 },
  );
}
