import { NextResponse } from "next/server";
import { getPrincipal, isStaff } from "@/lib/auth";
import { listEvents, parseKindsParam } from "@/lib/events";
import { resolvePrincipalUserId } from "@/lib/principal-user";

/**
 * GET /api/events?since=<id>&kinds=a,b&limit=n — the event-log read surface
 * (staff only). The change-cursor the sync client (S2+) and any observer polls.
 *
 * Space scoping is enforced in the service: a member only receives events for
 * docs in a space they can see (member-of ∪ public/unlisted), and never
 * user.approved. Payloads carry references only (ids/slugs/version ids), never
 * document content.
 *
 * Response: { events: [...], nextCursor } where nextCursor is the largest id in
 * this page (or the requested `since`/0 when empty) — the client advances
 * `?since=` to it to page forward.
 */
function err(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(req: Request) {
  const principal = await getPrincipal(req.headers as unknown as Headers);
  if (!isStaff(principal)) {
    return err(403, "Forbidden — staff only");
  }

  const url = new URL(req.url);

  // since — optional non-negative integer cursor.
  let since: number | undefined;
  const rawSince = url.searchParams.get("since");
  if (rawSince !== null && rawSince.trim().length > 0) {
    const n = Number(rawSince);
    if (!Number.isInteger(n) || n < 0) {
      return err(400, "since must be a non-negative integer");
    }
    since = n;
  }

  // kinds — optional comma-separated filter; unknown kind → 400.
  const parsedKinds = parseKindsParam(url.searchParams.get("kinds"));
  if (parsedKinds === null) {
    return err(400, "kinds contains an unknown event kind");
  }

  // limit — optional positive integer (clamped in the service).
  let limit: number | undefined;
  const rawLimit = url.searchParams.get("limit");
  if (rawLimit !== null && rawLimit.trim().length > 0) {
    const n = Number(rawLimit);
    if (!Number.isInteger(n) || n <= 0) {
      return err(400, "limit must be a positive integer");
    }
    limit = n;
  }

  // Resolve the member's users-row id so the feed can include events for docs in
  // spaces they belong to. Uses the SAME resolver as the doc read path
  // (scopeForPrincipal → resolvePrincipalUserId, dev-stub aware) so the events
  // feed and the docs list agree on which spaces a member can see. Admins ignore
  // it (see everything).
  const userId =
    principal.kind === "member" ? await resolvePrincipalUserId(principal) : null;

  const events = await listEvents({
    since,
    kinds: parsedKinds.length > 0 ? parsedKinds : undefined,
    limit,
    viewer: principal.kind,
    userId,
  });

  const nextCursor = events.length > 0 ? events[events.length - 1].id : since ?? 0;

  return NextResponse.json({ events, nextCursor });
}
