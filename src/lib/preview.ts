/**
 * Link-preview description helper (Open Graph / Twitter card `description`).
 *
 * Pure and dependency-free — no I/O, no DB — so it is trivially unit-testable and
 * safe to import from a Server Component's `generateMetadata`. It turns a
 * projected doc row into a short plain-text blurb for WhatsApp / Slack / iMessage
 * link cards.
 *
 * Precedence:
 *   1. Frontmatter `description`, else `summary`, when a non-empty string.
 *   2. Otherwise a plain-text snippet of the rendered body (`renderedCache`):
 *      markdown syntax and HTML tags/entities stripped, whitespace collapsed,
 *      trimmed to ≤ MAX_LEN chars with a trailing ellipsis when truncated.
 *
 * `renderedCache` is the body with frontmatter already stripped (see the indexer:
 * md → the markdown body, html → the raw html), so both formats flow through the
 * same stripper.
 */

/** Max length of the emitted description, inclusive of the ellipsis. */
const MAX_LEN = 200;

/**
 * The fields this helper reads. A projected `docs` row (`typeof docs.$inferSelect`)
 * structurally satisfies it — both `getDocBySlug(...).doc` and
 * `resolveShareDoc(...).doc` can be passed directly.
 */
export type DocPreviewInput = {
  /** Parsed YAML frontmatter (jsonb on the row — typed `unknown`). */
  parsedFrontmatter?: unknown;
  /** Pre-rendered body for the current commit (markdown body / raw html). */
  renderedCache?: string | null;
};

/** Read a non-empty trimmed string value from a frontmatter-like object. */
function frontmatterString(fm: unknown, key: string): string | null {
  if (fm !== null && typeof fm === "object" && key in fm) {
    const value = (fm as Record<string, unknown>)[key];
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length > 0) return trimmed;
    }
  }
  return null;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Decode common HTML entities; unknown named entities collapse to a space. */
function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (_m, code: string) => {
    if (code[0] === "#") {
      const cp =
        code[1] === "x" || code[1] === "X"
          ? parseInt(code.slice(2), 16)
          : parseInt(code.slice(1), 10);
      return Number.isNaN(cp) ? " " : String.fromCodePoint(cp);
    }
    const named = NAMED_ENTITIES[code.toLowerCase()];
    return named !== undefined ? named : " ";
  });
}

/** Reduce markdown/HTML body text to a single line of plain text. */
function stripToPlainText(input: string): string {
  let s = input;
  // Fenced code blocks and HTML comments — drop entirely.
  s = s.replace(/```[\s\S]*?```/g, " ");
  s = s.replace(/~~~[\s\S]*?~~~/g, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  // Images ![alt](url) → alt, links [text](url) → text.
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  // HTML tags → space (a space keeps adjacent words apart; tidied below).
  s = s.replace(/<[^>]+>/g, " ");
  // Line-start structural markers: headings, blockquotes, list bullets, rules.
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  s = s.replace(/^\s{0,3}>\s?/gm, "");
  s = s.replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/gm, "");
  s = s.replace(/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/gm, " ");
  // Inline code, then emphasis/strikethrough markers.
  s = s.replace(/`([^`]*)`/g, "$1");
  s = s.replace(/(\*\*\*|\*\*|\*|___|__|_|~~)/g, "");
  // Decode entities, collapse whitespace, tidy stray spaces before punctuation.
  s = decodeEntities(s);
  s = s.replace(/\s+/g, " ").trim();
  s = s.replace(/\s+([.,;:!?)])/g, "$1");
  return s;
}

/** Truncate to MAX_LEN (inclusive of the ellipsis), preferring a word boundary. */
function clip(text: string): string {
  if (text.length <= MAX_LEN) return text;
  let cut = text.slice(0, MAX_LEN - 1);
  const lastSpace = cut.lastIndexOf(" ");
  // Prefer a word boundary, but only if it doesn't chop off too much.
  if (lastSpace > MAX_LEN - 40) cut = cut.slice(0, lastSpace);
  return cut.trimEnd() + "…";
}

/**
 * Best link-preview description for a projected doc: frontmatter
 * `description`/`summary` if authored, else a trimmed plain-text body snippet.
 * Returns "" when neither is available (a neutral, leak-free default).
 */
export function docPreviewDescription(doc: DocPreviewInput): string {
  const authored =
    frontmatterString(doc.parsedFrontmatter, "description") ??
    frontmatterString(doc.parsedFrontmatter, "summary");
  if (authored !== null) return clip(authored);

  const body = doc.renderedCache;
  if (typeof body !== "string" || body.length === 0) return "";
  return clip(stripToPlainText(body));
}
