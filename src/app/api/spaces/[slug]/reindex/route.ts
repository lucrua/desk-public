/**
 * POST /api/spaces/[slug]/reindex — full re-projection of a space from its bare
 * repo's current tip (document-host Phase 1, §14 "full-reindex available as a
 * recovery command"). Admin only.
 *
 * Two uses:
 *   - operator recovery: rebuild the projection if the index drifts / is lost
 *     (the canon is the git repo; the projection is always rebuildable, §2).
 *   - the bare repo's post-receive hook curls this so pushes that bypass the
 *     HTTP route (rare; the in-route push path already re-indexes incrementally)
 *     still refresh the projection.
 *
 * Idempotent. Returns the {indexed, skipped, commit} summary.
 */
import { NextResponse } from "next/server";
import { getPrincipal, isStaff } from "@/lib/auth";
import { db } from "@/db";
import { spaces, users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { ownerSlugForUser } from "@/lib/spaces";
import { bareRepoPath } from "@/lib/git/repo";
import { reindexSpaceFull } from "@/lib/git/indexer";

function err(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

type RouteContext = { params: Promise<{ slug: string }> };

export async function POST(req: Request, { params }: RouteContext) {
  const principal = await getPrincipal(req.headers as unknown as Headers);
  if (!isStaff(principal)) return err(403, "Forbidden — staff only");
  if (principal.kind !== "admin") return err(403, "Forbidden — reindex is admin only");

  const { slug } = await params;
  const space = await db.query.spaces.findFirst({ where: eq(spaces.slug, slug) });
  if (!space) return err(404, "Unknown space");

  const owner = await db.query.users.findFirst({ where: eq(users.id, space.ownerUserId) });
  const ownerSlug = ownerSlugForUser(owner ?? null, space.ownerUserId);
  const repoPath = bareRepoPath(ownerSlug, slug);

  try {
    const result = await reindexSpaceFull(slug, repoPath, principal.name);
    return NextResponse.json({ ok: true, ...result }, { status: 200 });
  } catch (e) {
    return err(500, `reindex failed: ${(e as Error)?.message}`);
  }
}
