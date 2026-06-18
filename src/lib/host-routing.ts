/**
 * Host-based routing guard for the share hostname.
 *
 * Background (design.md §4, §15):
 *   - desk.<domain>   — CF Access-protected; full app.
 *   - share.<domain> — NO CF Access; only /s/* capability-link pages are
 *     reachable. Everything else must return a real HTTP 404 so that the
 *     unauthenticated hostname never accidentally exposes operator surfaces
 *     (defense in depth — CF Access is not on this hostname).
 *
 * SHARE_HOST is unset locally → middleware passes everything through, so
 * local dev is unaffected.
 */

export type RouteDecision = "pass" | "not-found";

/**
 * Decide whether the request should be passed to the Next.js router or
 * short-circuited with a 404.
 *
 * Pure function — no I/O, no Next.js imports — so it can be unit-tested
 * directly without the middleware runtime.
 *
 * Rules:
 *   1. shareHost unset → always pass (local dev / hub hostname).
 *   2. Request host does not match shareHost → pass (hub hostname).
 *   3. Request host matches shareHost:
 *      - /s/*       → pass (capability links — the only public surface).
 *      - /robots.txt → pass (disallow-all; harmless to serve on share host).
 *      - /_next/*   → pass (static assets needed by the /s/* pages).
 *      - everything else → not-found.
 */
export function decideRoute(
  host: string | null,
  pathname: string,
  shareHost: string | undefined,
): RouteDecision {
  // Rule 1: no share hostname configured → pass everything.
  if (!shareHost) return "pass";

  // Strip port from host before comparing.
  const h = (host ?? "").toLowerCase().split(":")[0];

  // Rule 2: not the share hostname → pass (hub host, or unknown).
  if (h !== shareHost.toLowerCase()) return "pass";

  // Rule 3: share hostname — allow only the public surfaces.
  if (pathname === "/robots.txt") return "pass";
  if (pathname.startsWith("/s/")) return "pass";
  if (pathname.startsWith("/_next/")) return "pass";

  return "not-found";
}
