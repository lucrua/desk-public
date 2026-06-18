// Host-based routing middleware.
//
// Purpose: on the share hostname (share.<domain>), only /s/* capability-link
// pages are reachable. All other paths are silently rewritten to /host-404,
// which returns a real HTTP 404. This is defense in depth: CF Access is NOT
// configured on the share hostname (so it would NOT block /admin, /api/…);
// the middleware is the gate. (design.md §4, §15)
//
// Local dev: SHARE_HOST is unset → decideRoute always returns "pass" →
// middleware is a no-op and the full app is reachable at localhost:3000.
import { NextResponse, type NextRequest } from "next/server";
import { decideRoute } from "@/lib/host-routing";

export function middleware(request: NextRequest) {
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

  return NextResponse.next();
}

// Run on every path except static files that can never be operator surfaces
// and that /s/* pages need (fonts, JS chunks, images).
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
