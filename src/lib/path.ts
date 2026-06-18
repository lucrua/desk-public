/**
 * Folder-path validation, shared by the REST routes, the MCP tools, and the
 * docs service so the three surfaces can't drift.
 *
 * A `docs.path` is a slash-joined list of segments. Each segment must match
 * `^[a-z0-9][a-z0-9-]*$` (same alphabet as slugs/audiences); the path is at most
 * `MAX_PATH_DEPTH` segments deep; the empty string is the root. There are no
 * folder entities — a folder "exists" exactly when some doc carries it as a
 * non-empty prefix. Identity stays the slug; the path is organizational only.
 */

export const PATH_SEGMENT_RE = /^[a-z0-9][a-z0-9-]*$/;
export const MAX_PATH_DEPTH = 6;

/**
 * Validate and canonicalize a path value. Returns the canonical path (trimmed of
 * surrounding slashes/whitespace) on success, or null when invalid.
 *
 *   - '' (or '/', or whitespace) → '' (root), valid.
 *   - 'os/canon' → 'os/canon', valid.
 *   - leading/trailing slashes are tolerated and stripped ('/os/' → 'os').
 *   - any empty interior segment ('os//canon'), a segment failing the alphabet,
 *     or more than MAX_PATH_DEPTH segments → null.
 *
 * Non-string input → null.
 */
export function normalizePath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  // Strip surrounding slashes; '' and '/' both mean root.
  const stripped = trimmed.replace(/^\/+/, "").replace(/\/+$/, "");
  if (stripped.length === 0) return "";

  const segments = stripped.split("/");
  if (segments.length > MAX_PATH_DEPTH) return null;
  for (const seg of segments) {
    if (!PATH_SEGMENT_RE.test(seg)) return null;
  }
  return segments.join("/");
}

/** True iff `raw` is a valid path (root included). */
export function isValidPath(raw: unknown): boolean {
  return normalizePath(raw) !== null;
}
