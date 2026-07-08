/**
 * POST /api/invite/[token]/accept — PUBLIC self-serve invite acceptance.
 *
 * This is the ONE door through which an external (non-CF-Access) user enters
 * Desk, so it lives on the share host (CF-Access-bypassed) and the SHARE_HOST
 * middleware allow-list admits it. The invite LINK is the authorization — no
 * principal is required; the body carries only the accepter's email.
 *
 * Body: { email }. On success (one transaction in acceptInvite): find-or-create
 * the user, grant space membership at the invite's role, consume one use, mint a
 * principal token. Returns { token (raw, once), cloneUrl, setupPrompt }.
 *
 * Fail-closed: a bad/expired/over-cap/revoked/unknown token → UNIFORM 404. NO
 * email-existence leak — the response is identical whether the email already had
 * an account or not. A missing/invalid email → 400.
 *
 * `export const dynamic = "force-dynamic"` so expiry/revocation/use-cap take
 * effect immediately with no caching in front.
 */
import { NextResponse } from "next/server";
import { acceptInvite, gitHostBase } from "@/lib/invites/invites";
import { getSpaceById } from "@/lib/spaces";
import {
  renderSetupPrompt,
  tokenCloneUrl,
} from "@/lib/invites/setup-prompt";

export const dynamic = "force-dynamic";

function err(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

type RouteContext = { params: Promise<{ token: string }> };

export async function POST(req: Request, { params }: RouteContext) {
  const { token } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err(400, "Invalid JSON body");
  }
  const b = body as Record<string, unknown>;
  if (typeof b.email !== "string" || b.email.trim().length === 0) {
    return err(400, "Missing or invalid email");
  }

  const out = await acceptInvite(token, b.email);
  if (!out.ok) {
    if (out.error === "invalid-email") return err(400, "Missing or invalid email");
    // Uniform 404 for unknown/expired/over-cap/revoked — no existence leak.
    return err(404, "Not found");
  }

  // Read the space's current push policy to switch the setup-prompt push line.
  const space = await getSpaceById(out.spaceId);
  const pushPolicy = space?.pushPolicy ?? "direct";

  // Resolve the git transport host from the request's own headers (works in a
  // unit-test calling the handler directly; HUB_BASE_URL wins when configured).
  const hostBase = gitHostBase(req.headers);

  const cloneUrl = tokenCloneUrl({
    gitHostBase: hostBase,
    token: out.token,
    ownerSlug: out.ownerSlug,
    spaceSlug: out.spaceSlug,
  });
  const setupPrompt = renderSetupPrompt({
    ownerSlug: out.ownerSlug,
    spaceSlug: out.spaceSlug,
    gitHostBase: hostBase,
    token: out.token,
    pushPolicy,
    handle: out.handle,
  });

  return NextResponse.json(
    {
      ok: true,
      token: out.token,
      cloneUrl,
      setupPrompt,
      space: out.spaceSlug,
      role: out.role,
    },
    { status: 200 },
  );
}
