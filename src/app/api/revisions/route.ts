/**
 * GET /api/revisions?status=open — central approval queue.
 *
 * Returns open revisions across all docs, newest-first.
 *   - Admin: sees ALL open revisions.
 *   - Owner (member with docs they own): sees only revisions on their docs.
 *   - Plain member (neither admin nor owner of any doc): forbidden.
 *
 * The `status` query parameter is REQUIRED and must equal `open` (the only
 * supported value — this endpoint is the approval queue, not a general index).
 *
 * Each item in the result carries the full revision row PLUS docSlug, docTitle,
 * and docOwnerUserId for display in the queue UI.
 */
import { NextResponse } from "next/server";
import { getPrincipal, isStaff } from "@/lib/auth";
import { listOpenRevisions } from "@/lib/revisions";

function err(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(req: Request) {
  const principal = await getPrincipal(req.headers as unknown as Headers);
  if (!isStaff(principal)) return err(403, "Forbidden — staff only");

  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  if (status !== "open") {
    return err(400, "status=open is required — this endpoint is the approval queue");
  }

  if (principal.kind === "admin") {
    // Admin sees all open revisions.
    const revisions = await listOpenRevisions();
    return NextResponse.json({ revisions });
  }

  // Member path: only see revisions on docs they own (principal.userId must match).
  if (principal.userId == null) {
    // Member with no resolved userId (dev mode or unresolved row) — forbidden.
    return err(403, "Forbidden — you do not own any docs");
  }

  const revisions = await listOpenRevisions({ ownerUserId: principal.userId });
  return NextResponse.json({ revisions });
}
