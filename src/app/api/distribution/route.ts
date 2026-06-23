import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import {
  distributionBySpace,
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
 * Admin-only. Returns the full distribution overview in three lenses (Gen-2,
 * space-scoped — audiences are retired):
 *   bySpace — per-space: members (name + role) + docs in it.
 *   byUser  — per-active-user: visible spaces + visible-doc count.
 *   links   — all live share links (doc + directory) with status/copy.
 *
 * All three exclude deleted docs (docs.deleted_at IS NOT NULL).
 */
export async function GET(req: Request) {
  const principal = await getPrincipal(req.headers);
  if (principal.kind !== "admin") return err(403, "Forbidden — admin only");

  const [bySpace, byUser, links] = await Promise.all([
    distributionBySpace(),
    distributionByUser(),
    distributionLinks(),
  ]);

  return NextResponse.json({ bySpace, byUser, links });
}
