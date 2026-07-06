import { NextResponse } from "next/server";
import { getPrincipal, isStaff } from "@/lib/auth";
import { listEventsWaiting, parseKindsParam } from "@/lib/events";
import { resolvePrincipalUserId } from "@/lib/principal-user";

/**
 * GET /api/events?since=<id>&kinds=a,b&limit=n&wait_seconds=<0-55> — the
 * event-log read surface (staff only). The change-cursor the sync client (S2+)
 * and any observer / agent polls.
 *
 * Space scoping is enforced in the service: a member only receives events for
 * docs in a space they can see (member-of ∪ public/unlisted), and never
 * user.approved. Payloads carry references only (ids/slugs/version ids), never
 * document content.
 *
 * `wait_seconds` (optional, default 0 = the immediate behaviour) turns the read
 * into a near-real-time long-poll: when it is >0 AND no events match `since`,
 * the request PARKS server-side (clamped to [0, 55] s) until an event arrives or
 * the timeout elapses, then returns the same `{ events, nextCursor }` shape
 * (possibly empty). The park re-queries on an interval holding NO DB connection
 * between polls, and honours client disconnect via `req.signal` — see
 * `listEventsWaiting`.
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

  // wait_seconds — optional long-poll. Must be an integer; the value itself is
  // range-clamped to [0, 55] in the service (a negative or over-cap number is
  // clamped, not rejected — only a non-integer is a 400).
  let waitSeconds = 0;
  const rawWait = url.searchParams.get("wait_seconds");
  if (rawWait !== null && rawWait.trim().length > 0) {
    const n = Number(rawWait);
    if (!Number.isInteger(n)) {
      return err(400, "wait_seconds must be an integer (0-55)");
    }
    waitSeconds = n;
  }

  // Resolve the member's users-row id so the feed can include events for docs in
  // spaces they belong to. Uses the SAME resolver as the doc read path
  // (scopeForPrincipal → resolvePrincipalUserId, dev-stub aware) so the events
  // feed and the docs list agree on which spaces a member can see. Admins ignore
  // it (see everything).
  const userId =
    principal.kind === "member" ? await resolvePrincipalUserId(principal) : null;

  const events = await listEventsWaiting(
    {
      since,
      kinds: parsedKinds.length > 0 ? parsedKinds : undefined,
      limit,
      viewer: principal.kind,
      userId,
    },
    waitSeconds,
    // Wire client-disconnect: a parked request ends promptly when the caller
    // goes away (standard Web Request signal, aborts on disconnect).
    req.signal,
  );

  const nextCursor = events.length > 0 ? events[events.length - 1].id : since ?? 0;

  return NextResponse.json({ events, nextCursor });
}
