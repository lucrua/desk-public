/**
 * Thin wrapper over the SYSTEM `git http-backend` (the CGI that speaks git's
 * smart-HTTP protocol). We do NOT embed a git server or run Gitea (§13.5,
 * §14) — the auth gate (lib/git/auth.ts) runs FIRST in the route, and only an
 * AUTHORIZED request reaches here. This module's sole job is to spawn
 * git-http-backend as a CGI process for one already-authorized repo + service,
 * feed it the request body on stdin, and parse its CGI stdout (status line +
 * headers + body) back into a web Response.
 *
 * git-http-backend handles: ref advertisement (info/refs), upload-pack (fetch),
 * receive-pack (push), and pack negotiation. We pin GIT_PROJECT_ROOT to the
 * single authorized repo's PARENT and PATH_INFO to `/<repo>.git/<service>` so
 * the backend can only ever touch that one repo — defense in depth against any
 * path confusion (the route already validated the segments).
 */
import { spawn } from "node:child_process";
import path from "node:path";

/** Absolute path to git-http-backend. Overridable via env for unusual installs;
 * defaults to the standard git-core location, with a PATH fallback. */
function httpBackendBin(): string {
  return process.env.GIT_HTTP_BACKEND_BIN ?? "/usr/lib/git-core/git-http-backend";
}

export type BackendRequest = {
  /** The bare repo's absolute path (…/<owner>/<space>.git). */
  repoPath: string;
  /** "GET" (info/refs) or "POST" (upload-pack / receive-pack). */
  method: string;
  /** The service-relative path within the repo, e.g. "info/refs" or
   * "git-upload-pack". No leading slash. */
  servicePath: string;
  /** Raw query string (without '?'), e.g. "service=git-upload-pack". */
  query: string;
  /** Request Content-Type (for POSTs); "" for GET. */
  contentType: string;
  /** Request body bytes (empty for GET). */
  body: Buffer;
  /** The authenticated principal's id, surfaced to the backend as REMOTE_USER
   * (git records it; useful for audit). */
  remoteUser: string;
  /** The pusher's resolved space role (owner|writer|reader). Passed to the
   * pre-receive policy hook as DESK_PUSHER_ROLE for the E2 write-boundary
   * enforcement (push-policy.ts). Verified to propagate git-http-backend →
   * git-receive-pack → hook. Only meaningful for receive-pack; harmless on
   * upload-pack. */
  pusherRole?: string;
  /** The target space's push policy (direct|proposal). Passed to the pre-receive
   * hook as DESK_PUSH_POLICY (E2). */
  pushPolicy?: string;
};

export type BackendResponse = {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
};

/**
 * Run git-http-backend for one request and return the parsed CGI response.
 *
 * CGI contract: the program reads the request body on stdin and writes
 * `Header: value\r\n` lines, a blank line, then the body to stdout. A `Status:`
 * header (when present) sets the HTTP status; otherwise 200. We translate that
 * into a web Response shape.
 */
export function runHttpBackend(req: BackendRequest): Promise<BackendResponse> {
  return new Promise((resolve, reject) => {
    // GIT_PROJECT_ROOT is the PARENT of the .git dir; PATH_INFO is
    // /<repo-dir>/<service>. This pins the backend to exactly one repo.
    const projectRoot = path.dirname(req.repoPath);
    const repoDir = path.basename(req.repoPath); // "<space>.git"
    const pathInfo = `/${repoDir}/${req.servicePath}`;

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_PROJECT_ROOT: projectRoot,
      GIT_HTTP_EXPORT_ALL: "1", // export without a git-daemon-export-ok marker
      PATH_INFO: pathInfo,
      REQUEST_METHOD: req.method,
      QUERY_STRING: req.query,
      CONTENT_TYPE: req.contentType,
      REMOTE_USER: req.remoteUser,
      // Advertise both services; the auth gate already decided which is allowed,
      // and PATH_INFO scopes the actual operation.
      GIT_HTTP_RECEIVE_PACK: "1",
      // E2 push-policy enforcement: surface the pusher's role + the space policy
      // to the pre-receive hook (push-policy.ts). These propagate through
      // git-http-backend → git-receive-pack → the hook (probed + tested). The
      // hook FAILS CLOSED on an unset value, so always set them on a push.
      ...(req.pusherRole != null ? { DESK_PUSHER_ROLE: req.pusherRole } : {}),
      ...(req.pushPolicy != null ? { DESK_PUSH_POLICY: req.pushPolicy } : {}),
    };

    const child = spawn(httpBackendBin(), [], { env });
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0 && chunks.length === 0) {
        reject(new Error(`git-http-backend exited ${code}: ${stderr}`));
        return;
      }
      resolve(parseCgi(Buffer.concat(chunks)));
    });

    if (req.body.length > 0) child.stdin.write(req.body);
    child.stdin.end();
  });
}

/**
 * Parse a CGI response buffer (headers, blank line, body) into status/headers/
 * body. A `Status: 404 Not Found` header maps to HTTP 404; absent → 200.
 */
function parseCgi(buf: Buffer): BackendResponse {
  // Find the header/body boundary (CRLF CRLF, or LF LF as a fallback).
  let sep = buf.indexOf("\r\n\r\n");
  let sepLen = 4;
  if (sep < 0) {
    sep = buf.indexOf("\n\n");
    sepLen = 2;
  }
  const headerBlock = sep < 0 ? buf.toString("utf8") : buf.subarray(0, sep).toString("utf8");
  const body = sep < 0 ? Buffer.alloc(0) : buf.subarray(sep + sepLen);

  const headers: Record<string, string> = {};
  let status = 200;
  for (const line of headerBlock.split(/\r?\n/)) {
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const name = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (name.toLowerCase() === "status") {
      const code = parseInt(value, 10);
      if (!Number.isNaN(code)) status = code;
      continue; // don't echo Status as a response header
    }
    headers[name] = value;
  }
  return { status, headers, body };
}
