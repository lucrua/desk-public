import type { Principal } from "./principal";
import { principalFromDevHeaders } from "./dev";
import { principalFromCfJwt } from "./cloudflare";

export type { Principal };
export { isStaff } from "./principal";
export { principalFromDevHeaders } from "./dev";
export { principalFromCfJwt } from "./cloudflare";

/**
 * Resolve the current request's principal.
 *
 * Routing:
 *   AUTH_MODE=dev (default)       → dev role-switcher header/cookie
 *   AUTH_MODE=cloudflare          → Cloudflare Access JWT verification
 *
 * Missing CF_AUD or CF_TEAM_DOMAIN in cloudflare mode → anonymous.
 */
export async function getPrincipal(headers: Headers): Promise<Principal> {
  const mode = process.env.AUTH_MODE ?? "dev";

  if (mode === "cloudflare") {
    const jwt = headers.get("Cf-Access-Jwt-Assertion");
    if (!jwt) return { kind: "anonymous" };

    const audience = process.env.CF_AUD;
    const teamDomain = process.env.CF_TEAM_DOMAIN;
    if (!audience || !teamDomain) return { kind: "anonymous" };

    return principalFromCfJwt(jwt, {
      audience,
      issuer: `https://${teamDomain}`,
    });
  }

  // Default: dev mode
  return principalFromDevHeaders(headers);
}
