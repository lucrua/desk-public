/**
 * POST /api/spaces/[slug]/mirror/now — the "Mirror now" button (convergence
 * fix-pass, Slice 4c). Forces an immediate mirror push of a `hosted` space's
 * `main` to its configured GitHub remote via `mirrorNow` (src/lib/mirror.ts) —
 * the SAME service function the (future) scheduled/hook-triggered mirror uses,
 * called synchronously here so the caller sees the recorded `mirror_state`
 * right away instead of waiting on the fire-and-forget queue.
 *
 * AUTHZ: the EXACT SAME owner/admin `canManageSpace` gate as
 * `PATCH /api/spaces/[slug]` and `PATCH /api/spaces/[slug]/mirror`. Unknown
 * space → 404. A non-manager → 403. `not-hosted` (source_mode=mirrored) or
 * `no-remote` (no mirror_remote_url configured) → 400 — nothing to mirror out,
 * not a server error.
 */
import { NextResponse } from "next/server";
import { getPrincipal, isStaff } from "@/lib/auth";
import { canManageSpace, getSpace } from "@/lib/spaces";
import { mirrorNow } from "@/lib/mirror";

function err(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

type RouteContext = { params: Promise<{ owner: string; slug: string }> };

export async function POST(req: Request, { params }: RouteContext) {
  const principal = await getPrincipal(req.headers as unknown as Headers);
  if (!isStaff(principal)) return err(403, "Forbidden — staff only");

  const { owner, slug } = await params;
  const space = await getSpace(owner, slug);
  if (!space) return err(404, "Not found");
  if (!(await canManageSpace(principal, space))) {
    return err(403, "Forbidden — only an admin or the space owner can manage this space");
  }

  const result = await mirrorNow(space.id);
  if (!result.ok) {
    if (result.reason === "unknown-space") return err(404, "Not found");
    if (result.reason === "not-hosted") {
      return err(400, "This space is not hosted (source_mode=mirrored) — nothing to mirror out");
    }
    return err(400, "No mirror_remote_url configured for this space");
  }

  return NextResponse.json({ ok: true, state: result.state });
}
