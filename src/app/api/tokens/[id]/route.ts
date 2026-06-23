/**
 * DELETE /api/tokens/[id] — revoke a principal token. AUTH-SENSITIVE.
 *
 * Scoping: a member may revoke only a token they OWN; an admin may revoke any.
 * The owner check resolves the token's user and compares it to the caller's
 * resolved user id — a member revoking another user's token gets a 404 (uniform
 * with "unknown token": never confirm someone else's token exists).
 *
 * Idempotent: revoking an already-revoked (or already-resolved-as-owned) token
 * returns ok. Both-channels parity with the MCP `revoke_token` tool.
 */
import { NextResponse } from "next/server";
import { getPrincipal, isStaff } from "@/lib/auth";
import { resolvePrincipalUserId } from "@/lib/principal-user";
import { revokePrincipalToken, tokenOwnerUserId } from "@/lib/spaces";

export const dynamic = "force-dynamic";

function err(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

type RouteContext = { params: Promise<{ id: string }> };

export async function DELETE(req: Request, { params }: RouteContext) {
  const principal = await getPrincipal(req.headers as unknown as Headers);
  if (!isStaff(principal)) return err(403, "Forbidden — staff only");

  const { id: idStr } = await params;
  const id = Number(idStr);
  if (!Number.isInteger(id) || id <= 0) return err(400, "Invalid token id");

  const owner = await tokenOwnerUserId(id);
  if (owner == null) return err(404, "Not found"); // unknown token → uniform 404

  if (principal.kind !== "admin") {
    const me = await resolvePrincipalUserId(principal);
    // A member may only revoke their own token; another's token is "not found"
    // (no existence leak) rather than a 403 that confirms it exists.
    if (me == null || me !== owner) return err(404, "Not found");
  }

  await revokePrincipalToken(id);
  return NextResponse.json({ ok: true }, { status: 200 });
}
