/**
 * POST /api/revisions/[id]/accept — accept a revision (admin OR doc owner).
 *
 * Guard relaxed from admin-only to canDecideRevision (admin || owner of the
 * doc this revision belongs to). The revision row carries docId; we load the
 * doc to check ownership.
 */
import { NextResponse } from "next/server";
import { getPrincipal, isStaff } from "@/lib/auth";
import { getRevision, acceptRevision } from "@/lib/revisions";
import { db } from "@/db";
import { docs } from "@/db/schema";
import { eq } from "drizzle-orm";
import { canDecideRevision } from "@/lib/permissions";

function err(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: RouteContext) {
  const principal = await getPrincipal(req.headers as unknown as Headers);
  if (!isStaff(principal)) return err(403, "Forbidden — staff only");

  const { id: idStr } = await params;
  const id = parseInt(idStr, 10);
  if (isNaN(id)) return err(400, "Invalid id — must be a numeric revision id");

  // Load revision first to get docId for ownership check.
  const rev = await getRevision(id);
  if (!rev) return err(404, `Revision ${id} not found`);

  // Load the doc to check ownership.
  const [doc] = await db
    .select({ id: docs.id, ownerUserId: docs.ownerUserId })
    .from(docs)
    .where(eq(docs.id, rev.docId))
    .limit(1);
  if (!doc) return err(404, `Doc for revision ${id} not found`);

  if (!canDecideRevision(principal, doc)) {
    return err(403, "Forbidden — only the doc owner or an admin may decide revisions");
  }

  const res = await acceptRevision(id, { by: principal.name });
  if (!res.ok) {
    if (res.reason === "not-found") return err(404, `Revision ${id} not found`);
    if (res.reason === "stale") {
      return err(409, "This doc changed while you were reviewing — reload and re-accept.");
    }
    if (res.reason === "mirrored") {
      return err(409, "This space mirrors from GitHub — accepting is refused; apply the change upstream.");
    }
    if (res.reason === "error") return err(500, "Could not apply the revision.");
    return err(409, "Revision already decided");
  }

  return NextResponse.json({
    ok: true,
    versionId: res.versionId,
    isNewVersion: res.isNewVersion,
    staleBase: res.staleBase,
  });
}
