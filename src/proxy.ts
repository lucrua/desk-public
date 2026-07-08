// Proxy (Next 16 renamed `middleware` → `proxy`; runs before routes on the Node.js
// runtime, so it can do the DB lookups the legacy-URL resolution below needs).
//
// Two jobs:
//
// 1. Host-based routing. On the share hostname (share.<domain>), only /s/*
//    capability-link pages are reachable. All other paths are silently rewritten
//    to /host-404 (a real HTTP 404). Defense in depth: CF Access is NOT configured
//    on the share hostname, so it would NOT block /admin, /api/…; this is the gate.
//    (design.md §4, §15.) Local dev: SHARE_HOST unset → decideRoute → "pass".
//
// 2. Owner-namespace legacy URLs (S4, decision D5). Canonical space URLs are now
//    owner-qualified (`/spaces/<owner>/<slug>`, `/api/spaces/<owner>/<slug>/…`). The
//    old single-slug links keep working: web `/spaces/<slug>` 301-redirects to the
//    owner-qualified URL; API `/api/spaces/<slug>/…` rewrites IN PLACE (preserving
//    method + body — a redirect would drop a POST). Ambiguous API slug → 409. Only
//    legacy-SHAPED paths reach a DB lookup; canonical requests pass straight through.
import { NextResponse, type NextRequest } from "next/server";
import { decideRoute } from "@/lib/host-routing";
import { planSpaceRoute } from "@/lib/legacy-space-route";

export async function proxy(request: NextRequest) {
  const host = request.headers.get("host");
  const { pathname } = request.nextUrl;
  const shareHost = process.env.SHARE_HOST;

  const decision = decideRoute(host, pathname, shareHost);

  if (decision === "not-found") {
    // Rewrite to the /host-404 route handler, which returns a real HTTP 404
    // with a styled page. A plain NextResponse.next() would 200; a rewrite to
    // the route handler is the only way to get the correct status.
    const url = request.nextUrl.clone();
    url.pathname = "/host-404";
    return NextResponse.rewrite(url);
  }

  // Owner-namespace S4 — legacy single-slug space URLs → owner-qualified. Runs
  // only on the hub host (share-host paths were already 404'd above).
  if (
    pathname === "/spaces" ||
    pathname.startsWith("/spaces/") ||
    pathname.startsWith("/api/spaces/")
  ) {
    const plan = await planSpaceRoute(pathname);
    if (plan.kind === "redirect") {
      // 301 (permanent) — the canonical URL is the new home of every legacy link.
      return NextResponse.redirect(new URL(plan.location, request.url), 301);
    }
    if (plan.kind === "rewrite") {
      const url = request.nextUrl.clone();
      url.pathname = plan.pathname;
      return NextResponse.rewrite(url);
    }
    if (plan.kind === "conflict") {
      return NextResponse.json(
        { error: "Ambiguous space slug — qualify the request with <owner>/<slug>" },
        { status: 409 },
      );
    }
  }

  return NextResponse.next();
}

// Run on every path except static files that can never be operator surfaces
// and that /s/* pages need (fonts, JS chunks, images).
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
