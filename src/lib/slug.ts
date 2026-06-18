/**
 * Slug + title derivation for the manual upload flow.
 *
 * Pure and dependency-free so it is safe to import in client components
 * (the upload island prefills slug/title from the chosen file in the browser).
 *
 * NOTE: The UI now defaults the slug field to a random value (randomSlug);
 * the CLI keeps its filename-derived idempotent slug (slugFromFilename). This
 * is intentional divergence — the UI/CLI parity claim in the original header
 * no longer holds. The CLI keeps its own sibling copy on purpose — it is a
 * zero-dependency Node script and must not import from the app bundle.
 */

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Strip the last dot-extension from a filename, returning the stem. */
function stem(name: string): string {
  const dot = name.lastIndexOf(".");
  // No dot, or a leading dot (dotfile like ".env") → no extension to strip.
  if (dot <= 0) return name;
  return name.slice(0, dot);
}

/**
 * Derive a URL-safe slug from an arbitrary filename.
 *
 * Filename minus extension, lowercased, every run of non-[a-z0-9] characters
 * collapsed to a single '-', with edge dashes trimmed.
 *
 *   "My File.MD"        → "my-file"
 *   "Relatório Q2.html" → "relat-rio-q2"
 *
 * Returns "" when nothing slug-like remains (e.g. "   .md", "___"); callers
 * should treat empty as "needs a manual slug".
 */
export function slugFromFilename(name: string): string {
  return stem(name)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** True when a string is a valid doc slug (matches the API/CLI contract). */
export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}

/**
 * Derive a title from markdown content: the text of the first `# heading`,
 * stripped. Falls back to `fallback` when there is no level-1 heading (e.g.
 * HTML artifacts, or markdown that opens without one).
 */
export function titleFromContent(content: string, fallback: string): string {
  const match = content.match(/^#[ \t]+(.+)$/m);
  if (!match) return fallback;
  const title = match[1].trim();
  return title || fallback;
}

/**
 * Generate a random 9-character slug from [a-z0-9], always matching SLUG_RE.
 * Uses crypto.getRandomValues — pure, client-safe.
 *
 * NOTE: The UI now defaults the slug field to a random value; the CLI
 * keeps its filename-derived idempotent slug. This is intentional divergence —
 * the UI/CLI parity claim in the original header no longer holds.
 */
export function randomSlug(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}
