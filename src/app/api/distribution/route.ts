import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import {
  distributionByAudience,
  distributionByUser,
  distributionLinks,
} from "@/lib/distribution";

export const dynamic = "force-dynamic";

function err(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

/**
 * GET /api/distribution
 *
 * Admin-only. Returns the full distribution overview in three lenses:
 *   byAudience — per-audience: members + docs.
 *   byUser     — per-active-user: visible audiences + doc count.
 *   links      — all live share links (doc + directory) with status/copy.
 *
 * All three exclude deleted docs (docs.deleted_at IS NOT NULL).
 */
export async function GET(req: Request) {
  const principal = await getPrincipal(req.headers);
  if (principal.kind !== "admin") return err(403, "Forbidden — admin only");

  const [byAudience, byUser, links] = await Promise.all([
    distributionByAudience(),
    distributionByUser(),
    distributionLinks(),
  ]);

  return NextResponse.json({ byAudience, byUser, links });
}
