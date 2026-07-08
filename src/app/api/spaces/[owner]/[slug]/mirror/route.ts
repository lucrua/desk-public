/**
 * PATCH /api/spaces/[slug]/mirror — set a space's GitHub mirror configuration
 * (convergence fix-pass, Slice 4c; decisions D-C3/D-C4).
 *
 * Body: { source_mode?: "hosted"|"mirrored", mirror_remote_url?: string|null } —
 * supply at least one field. `mirror_remote_url: null` (or `""`) clears the
 * remote. Allowed for an ADMIN or the space's OWNER — the EXACT SAME
 * `canManageSpace` gate `PATCH /api/spaces/[slug]` uses for visibility/
 * push_policy (`src/app/api/spaces/[slug]/route.ts`), so this is data-egress
 * config gated identically to the other owner/admin-only mutations.
 *
 * Unknown space → 404. A non-manager (member/reader/anonymous) → 403 (matching
 * the sibling route's posture — never a uniform 404 here, since this route sits
 * right next to visibility/push_policy which already use 403). A missing/
 * invalid value → 400. Delegates to `setMirrorConfig` (src/lib/mirror.ts) — the
 * mechanism itself (encryption, push, refusal) is NOT reimplemented here.
 */
import { NextResponse } from "next/server";
import { getPrincipal, isStaff } from "@/lib/auth";
import { canManageSpace, getSpace } from "@/lib/spaces";
import { setMirrorConfig } from "@/lib/mirror";

function err(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

type RouteContext = { params: Promise<{ owner: string; slug: string }> };

const SOURCE_MODES = ["hosted", "mirrored"] as const;

export async function PATCH(req: Request, { params }: RouteContext) {
  const principal = await getPrincipal(req.headers as unknown as Headers);
  if (!isStaff(principal)) return err(403, "Forbidden — staff only");

  const { owner, slug } = await params;
  const space = await getSpace(owner, slug);
  if (!space) return err(404, "Not found");
  if (!(await canManageSpace(principal, space))) {
    return err(403, "Forbidden — only an admin or the space owner can manage this space");
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err(400, "Invalid JSON body");
  }
  const b = body as Record<string, unknown>;

  const hasSourceMode = b.source_mode !== undefined;
  const hasRemoteUrl = b.mirror_remote_url !== undefined;
  if (!hasSourceMode && !hasRemoteUrl) {
    return err(400, "Supply at least one of 'source_mode' or 'mirror_remote_url'");
  }

  if (hasSourceMode && (typeof b.source_mode !== "string" || !SOURCE_MODES.includes(b.source_mode as (typeof SOURCE_MODES)[number]))) {
    return err(400, "Invalid source_mode — must be 'hosted' or 'mirrored'");
  }
  if (hasRemoteUrl && b.mirror_remote_url !== null && typeof b.mirror_remote_url !== "string") {
    return err(400, "Invalid mirror_remote_url — must be a string or null");
  }

  const result = await setMirrorConfig(space.id, {
    sourceMode: hasSourceMode ? (b.source_mode as "hosted" | "mirrored") : undefined,
    mirrorRemoteUrl: hasRemoteUrl ? (b.mirror_remote_url as string | null) : undefined,
  });
  if (!result.ok) return err(404, "Not found");

  return NextResponse.json({
    ok: true,
    sourceMode: result.space.sourceMode,
    mirrorRemoteUrl: result.space.mirrorRemoteUrl,
    mirrorState: result.space.mirrorState,
  });
}
