/**
 * Pure parsing of a git smart-HTTP request path → {owner, space, service,
 * servicePath}. Kept dependency-free so the (security-sensitive) parse is
 * unit-testable without the route runtime.
 *
 * Recognized shapes (after the `/api/git/` mount prefix is stripped):
 *
 *   GET  <owner>/<space>.git/info/refs?service=git-upload-pack   → fetch advert
 *   GET  <owner>/<space>.git/info/refs?service=git-receive-pack  → push advert
 *   POST <owner>/<space>.git/git-upload-pack                     → fetch
 *   POST <owner>/<space>.git/git-receive-pack                    → push
 *
 * Anything else (a dumb-HTTP object path, an unknown service, a missing .git
 * suffix, a bad segment) → null. The route maps null to a uniform 404.
 */
import type { GitService } from "./auth";

const SEG_RE = /^[a-z0-9][a-z0-9-]*$/;

export type ParsedGitRequest = {
  owner: string;
  space: string; // without the trailing .git
  service: GitService; // the git operation this request performs
  servicePath: string; // the repo-relative path handed to git-http-backend
};

/**
 * Parse the path segments (already split, mount prefix removed) + query.
 * `method` distinguishes the GET advertisement from the POST RPC.
 */
export function parseGitRequest(
  segments: string[],
  method: string,
  query: URLSearchParams,
): ParsedGitRequest | null {
  // Need at least <owner>/<space>.git/<tail...>
  if (segments.length < 3) return null;

  const owner = segments[0];
  const spaceDotGit = segments[1];
  if (!SEG_RE.test(owner)) return null;
  if (!spaceDotGit.endsWith(".git")) return null;
  const space = spaceDotGit.slice(0, -".git".length);
  if (!SEG_RE.test(space)) return null;

  const tail = segments.slice(2).join("/");

  if (method === "GET" && tail === "info/refs") {
    const svc = query.get("service");
    if (svc === "git-upload-pack" || svc === "git-receive-pack") {
      return { owner, space, service: svc, servicePath: "info/refs" };
    }
    // info/refs without a smart service = dumb HTTP — unsupported.
    return null;
  }

  if (method === "POST" && tail === "git-upload-pack") {
    return { owner, space, service: "git-upload-pack", servicePath: "git-upload-pack" };
  }
  if (method === "POST" && tail === "git-receive-pack") {
    return { owner, space, service: "git-receive-pack", servicePath: "git-receive-pack" };
  }

  return null;
}

/** Strip the `/api/git/` mount prefix from a pathname and return the remaining
 * segments (decoded). Returns null if the prefix is absent. */
export function segmentsAfterMount(pathname: string): string[] | null {
  const MOUNT = "/api/git/";
  if (!pathname.startsWith(MOUNT)) return null;
  const rest = pathname.slice(MOUNT.length);
  if (rest.length === 0) return [];
  return rest.split("/").map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
}
