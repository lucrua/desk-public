/**
 * Compute the absolute base URL the "Push to this space" snippet should use for
 * the git transport, so the copy-paste `git remote add` works in dev + staging +
 * prod without hardcoding a host.
 *
 * Resolution: prefer the configured `HUB_BASE_URL` (the canonical desk.<domain>
 * origin); fall back to the request's own origin (scheme + host) derived from
 * forwarded headers. Returns an origin with NO trailing slash.
 */

/** Strip any trailing slash so callers can append a path safely. */
function noTrailingSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

/**
 * Best-effort request origin from forwarded headers: `x-forwarded-proto` +
 * `x-forwarded-host` (or `host`). Returns null when no host header is present.
 */
export function originFromHeaders(h: {
  get(name: string): string | null;
}): string | null {
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (!host) return null;
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

/**
 * The base origin for the git transport. `HUB_BASE_URL` wins; else the request
 * origin; else a localhost dev default (so the snippet is never blank).
 */
export function gitRemoteBase(headers?: {
  get(name: string): string | null;
}): string {
  const env = process.env.HUB_BASE_URL?.trim();
  if (env) return noTrailingSlash(env);
  const fromReq = headers ? originFromHeaders(headers) : null;
  if (fromReq) return noTrailingSlash(fromReq);
  return "http://localhost:3000";
}

/**
 * The full clone/push URL for a space: `<base>/api/git/<owner>/<space>.git`.
 */
export function gitRepoUrl(
  ownerSlug: string,
  spaceSlug: string,
  headers?: { get(name: string): string | null },
): string {
  return `${gitRemoteBase(headers)}/api/git/${ownerSlug}/${spaceSlug}.git`;
}
