import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { revealShareUrl } from "@/lib/shares";

export const dynamic = "force-dynamic";

function err(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/shares/[id]/reveal
 *
 * Admin-only. Decrypts the stored token_enc for a share and returns the full
 * capability-link URL — the same URL that was returned at creation time.
 *
 * Returns:
 *   200 { url: "https://..." }
 *   404 when the share is unknown, deleted, pre-migration (no token_enc), or
 *       the app key is unset/wrong (uniform — no disambiguation).
 */
export async function GET(req: Request, { params }: RouteContext) {
  const principal = await getPrincipal(req.headers);
  if (principal.kind !== "admin") return err(403, "Forbidden — admin only");

  const { id: idStr } = await params;
  const id = parseInt(idStr, 10);
  if (isNaN(id)) return err(400, "Invalid id — must be a numeric share id");

  const url = await revealShareUrl(id);
  if (url === null) return err(404, `Share ${id} not found or link cannot be revealed`);

  return NextResponse.json({ url });
}
