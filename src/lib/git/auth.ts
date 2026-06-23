/**
 * Git smart-HTTP authorization — THE write boundary (design-document-host.md
 * §13.5, §14, §15). AUTH-SENSITIVE; fail-closed by construction.
 *
 * The transport is HTTPS smart-HTTP. The credential is a PRINCIPAL TOKEN carried
 * as the HTTP Basic-auth PASSWORD (the username is ignored — `git clone` always
 * sends one, but it carries no meaning here). This middleware resolves
 *   token → users row → space_members.role on the target space
 * and decides whether the requested git service is permitted:
 *
 *   service              git op          required role
 *   ───────────────────  ──────────────  ─────────────
 *   git-upload-pack      clone / fetch    reader+   (reader|writer|owner)
 *   git-receive-pack     push             writer+   (writer|owner)
 *
 * EVERY denial — no/blank credentials, unknown/revoked token, inactive user,
 * unknown space, wrong owner segment, no membership, or a reader attempting a
 * push — collapses to ONE outcome the route renders identically: a uniform 404
 * (no existence leak; a private space is indistinguishable from "doesn't
 * exist"). The ONLY case that returns 401-with-WWW-Authenticate is "no
 * credentials at all on a request that needs them," so a git client knows to
 * prompt for / send a token; once a (wrong) token is supplied, we 404 rather
 * than 403 to avoid confirming the space exists.
 */
import type { SpaceRole } from "@/lib/spaces";
import { resolveSpaceRole, roleSatisfies } from "@/lib/spaces";

export type GitService = "git-upload-pack" | "git-receive-pack";

/** Map a git service to the minimum space role that may invoke it. */
export function requiredRoleFor(service: GitService): SpaceRole {
  return service === "git-receive-pack" ? "writer" : "reader";
}

/**
 * Parse an `Authorization: Basic <base64(user:pass)>` header into its password
 * (the principal token). Returns null when the header is absent or not Basic.
 * The username half is discarded.
 */
export function tokenFromBasicAuth(header: string | null | undefined): string | null {
  if (!header) return null;
  const m = /^Basic\s+(.+)$/i.exec(header.trim());
  if (!m) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(m[1], "base64").toString("utf8");
  } catch {
    return null;
  }
  // `user:password` — the password is everything after the FIRST colon (a token
  // is base64url so it has no colon, but be defensive).
  const colon = decoded.indexOf(":");
  if (colon < 0) return null;
  const pass = decoded.slice(colon + 1);
  return pass.length > 0 ? pass : null;
}

export type AuthDecision =
  | { kind: "ok"; userId: number; role: SpaceRole; ownerSlug: string; spaceSlug: string }
  | { kind: "unauthenticated" } // no credentials supplied — prompt (401)
  | { kind: "denied" }; // anything else — uniform 404 (no leak)

/**
 * The authorization decision for one git request.
 *
 * @param authHeader  the raw Authorization header (Basic <b64>) or null
 * @param ownerSegment the `<owner>` URL segment
 * @param spaceSlug    the `<space>` URL segment (without the .git suffix)
 * @param service      the requested git service
 *
 * Returns:
 *   - { kind: "unauthenticated" } ONLY when no credentials were sent at all
 *     (the route answers 401 + WWW-Authenticate so the client sends a token).
 *   - { kind: "denied" } for every authenticated-but-unauthorized case AND for
 *     a reader attempting a push (the route answers a uniform 404).
 *   - { kind: "ok", role } when permitted.
 */
export async function authorizeGit(
  authHeader: string | null | undefined,
  ownerSegment: string,
  spaceSlug: string,
  service: GitService,
): Promise<AuthDecision> {
  const token = tokenFromBasicAuth(authHeader);
  // No credentials at all → prompt. (A blank/garbage Authorization header that
  // isn't Basic also yields null here → treat as unauthenticated so a client
  // gets a chance to send a real token.)
  if (token === null) return { kind: "unauthenticated" };

  const resolved = await resolveSpaceRole(token, ownerSegment, spaceSlug);
  if (resolved === null) return { kind: "denied" }; // fail-closed, uniform 404

  const need = requiredRoleFor(service);
  if (!roleSatisfies(resolved.role, need)) {
    // Authenticated but under-privileged (e.g. reader trying to push). Deny
    // uniformly — we do NOT 403 (that would confirm the space + the caller's
    // read access). The reader already proved read access, but the §13 rule is
    // uniform-404 for the write boundary; a 403 here is acceptable too, but we
    // keep ONE shape for the whole matrix to minimize signal.
    return { kind: "denied" };
  }

  return {
    kind: "ok",
    userId: resolved.userId,
    role: resolved.role,
    ownerSlug: resolved.ownerSlug,
    spaceSlug,
  };
}
