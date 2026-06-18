import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { unpublishDoc } from "@/lib/docs";

export const dynamic = "force-dynamic";

function err(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

type RouteContext = { params: Promise<{ slug: string }> };

/**
 * POST /api/docs/[slug]/unpublish — stage-1 reversible de-list (admin only).
 *
 * Distinct from DELETE /api/docs/[slug] (stage-2 DESTRUCTIVE delete).
 * This is reversible: version history and content are retained; re-publishing
 * the same slug restores the doc. All share links 404 while unpublished.
 */
export async function POST(req: Request, { params }: RouteContext) {
  const principal = await getPrincipal(req.headers as unknown as Headers);
  if (principal.kind !== "admin") {
    return err(403, "Forbidden — admin only");
  }

  const { slug } = await params;
  const done = await unpublishDoc(slug);
  if (!done) {
    return err(404, `Doc '${slug}' not found or already unpublished`);
  }

  return NextResponse.json({ ok: true });
}
