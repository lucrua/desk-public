import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { listViews } from "@/lib/shares";
import { uaLabel } from "@/lib/ua";

function err(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

type RouteContext = { params: Promise<{ id: string }> };

const RAW_UA_TOOLTIP_MAX = 80;

/**
 * GET /api/shares/[id]/views — admin-only view log for one share.
 *
 * Returns each view with:
 *   - viewedAt   (ISO timestamp)
 *   - ip         (raw — this is the admin's own audit data; NOT for HTML sinks)
 *   - uaLabel    (coarse, human label derived by the pure uaLabel())
 *   - rawUa      (raw UA truncated to 80 chars, for a hover tooltip)
 *   - docVersionId
 *
 * ip / rawUa are attacker-controlled strings. The client MUST render them as
 * plain text only (React escapes interpolated text) — never into an HTML sink,
 * href, or src.
 */
export async function GET(req: Request, { params }: RouteContext) {
  const principal = await getPrincipal(req.headers);
  if (principal.kind !== "admin") {
    return err(403, "Forbidden — admin only");
  }

  const { id: idStr } = await params;
  const id = parseInt(idStr, 10);
  if (isNaN(id)) {
    return err(400, "Invalid id — must be a numeric share id");
  }

  // Unknown id → empty list (a share with zero views and a non-existent share
  // are indistinguishable here; no existence signal, and the admin sees the
  // same "never opened" empty state either way).
  const views = await listViews(id);

  return NextResponse.json({
    views: views.map((v) => ({
      viewedAt: v.viewedAt,
      ip: v.ip,
      uaLabel: uaLabel(v.userAgent),
      rawUa: v.userAgent != null ? v.userAgent.slice(0, RAW_UA_TOOLTIP_MAX) : null,
      docVersionId: v.docVersionId,
    })),
  });
}
