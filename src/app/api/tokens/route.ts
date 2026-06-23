/**
 * Principal-token REST surface (document-host Phase 2, Slice 1) — the missing
 * piece that makes a git push credential SELF-SERVE. AUTH-SENSITIVE: this mints
 * the Basic-auth credential the git transport (`/api/git/...`) honours, bound to
 * the CURRENT principal's user.
 *
 *   POST /api/tokens  { label }     → mint a token for the caller's user.
 *                                     Returns the RAW token ONCE (never re-shown,
 *                                     never stored — only its sha256 hash is).
 *   GET  /api/tokens  [?all=1]      → list the caller's tokens (safe projection:
 *                                     id, label, lastUsedAt, createdAt, revokedAt
 *                                     — never the raw token or hash). `?all=1` is
 *                                     admin-only and lists every user's tokens.
 *
 * Both reject anonymous (staff only). A member sees/mints only their OWN tokens.
 * Both-channels parity with the MCP `create_token` / `list_tokens` tools.
 */
import { NextResponse } from "next/server";
import { getPrincipal, isStaff } from "@/lib/auth";
import { resolvePrincipalUserId } from "@/lib/principal-user";
import {
  mintPrincipalToken,
  listTokensForUser,
  listAllTokens,
  type TokenListItem,
} from "@/lib/spaces";

export const dynamic = "force-dynamic";

function err(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

const MAX_LABEL_CHARS = 120;

/**
 * The documented safe wire projection for a token: { id, label, lastUsedAt,
 * createdAt, revokedAt }. `ownerUserId` is INTERNAL (used to scope server-side)
 * and is NOT exposed over the API — including the admin ?all=1 view.
 */
function toWire(t: TokenListItem) {
  return {
    id: t.id,
    label: t.label,
    lastUsedAt: t.lastUsedAt,
    createdAt: t.createdAt,
    revokedAt: t.revokedAt,
  };
}

export async function GET(req: Request) {
  const principal = await getPrincipal(req.headers as unknown as Headers);
  if (!isStaff(principal)) return err(403, "Forbidden — staff only");

  const url = new URL(req.url);
  const all = url.searchParams.get("all") === "1";
  if (all) {
    if (principal.kind !== "admin") {
      return err(403, "Forbidden — listing all tokens is admin only");
    }
    return NextResponse.json(
      { tokens: (await listAllTokens()).map(toWire) },
      { status: 200 },
    );
  }

  const userId = await resolvePrincipalUserId(principal);
  if (userId == null) return err(400, "Cannot resolve your user identity");
  return NextResponse.json(
    { tokens: (await listTokensForUser(userId)).map(toWire) },
    { status: 200 },
  );
}

export async function POST(req: Request) {
  const principal = await getPrincipal(req.headers as unknown as Headers);
  if (!isStaff(principal)) return err(403, "Forbidden — staff only");

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err(400, "Invalid JSON body");
  }
  const b = body as Record<string, unknown>;
  if (typeof b.label !== "string" || b.label.trim().length === 0) {
    return err(400, "Missing or invalid label");
  }
  const label = b.label.trim();
  if (label.length > MAX_LABEL_CHARS) {
    return err(400, `Label too long (max ${MAX_LABEL_CHARS} chars)`);
  }

  const userId = await resolvePrincipalUserId(principal);
  if (userId == null) return err(400, "Cannot resolve your user identity");

  const minted = await mintPrincipalToken(userId, label);
  // The RAW token is returned here and NOWHERE ELSE — never persisted, never
  // re-shown. The caller must surface it once and warn the operator to store it.
  return NextResponse.json(
    { id: minted.id, label: minted.label, token: minted.token },
    { status: 201 },
  );
}
