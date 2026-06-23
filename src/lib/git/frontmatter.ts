/**
 * Minimal, dependency-free frontmatter parser for the projection indexer.
 *
 * Desk has no YAML dependency (it renders markdown client-side via
 * react-markdown). The indexer only needs to project a doc's leading `---`
 * frontmatter block into a jsonb object for catalog/board views (Phase 2) and
 * to strip it from the rendered body. We therefore parse a pragmatic SUBSET of
 * YAML — exactly what doc frontmatter uses in practice:
 *
 *   - `key: scalar`        → string | number | boolean | null
 *   - `key: [a, b, c]`     → inline flow array of scalars
 *   - `key:` then `- item` lines → block array of scalars
 *   - quoted scalars ("…" / '…') are unquoted
 *   - `#` comments on their own line are ignored
 *
 * Anything more exotic (nested maps, anchors, multi-line scalars) is preserved
 * as a raw string value rather than throwing — projection must never fail on a
 * surprising doc. The body (everything after the closing `---`) is returned
 * separately so callers can render/cache it without the frontmatter.
 */

export type Frontmatter = Record<string, unknown>;

export type ParsedDoc = {
  frontmatter: Frontmatter;
  body: string;
  /** True when a frontmatter block was present and closed. */
  hasFrontmatter: boolean;
};

function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

/** Coerce a bare scalar token to string | number | boolean | null. */
function scalar(raw: string): unknown {
  const t = raw.trim();
  if (t.length === 0) return "";
  const lower = t.toLowerCase();
  if (lower === "true") return true;
  if (lower === "false") return false;
  if (lower === "null" || lower === "~") return null;
  // Quoted → always a string.
  if ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'"))) {
    return unquote(t);
  }
  // Numeric (int or float), but not things like "1.2.3" or "01-02".
  if (/^-?\d+$/.test(t)) return parseInt(t, 10);
  if (/^-?\d*\.\d+$/.test(t)) return parseFloat(t);
  return t;
}

function parseInlineArray(raw: string): unknown[] {
  const inner = raw.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (inner.trim().length === 0) return [];
  return inner.split(",").map((part) => scalar(part));
}

/**
 * Split a document into its frontmatter object + body. A frontmatter block is a
 * leading `---` line, key/value lines, and a closing `---` line. No block →
 * `{ frontmatter: {}, body: <whole>, hasFrontmatter: false }`.
 */
export function parseFrontmatter(content: string): ParsedDoc {
  // Normalize CRLF so the line scan is uniform.
  const text = content.replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n") && text !== "---") {
    return { frontmatter: {}, body: content, hasFrontmatter: false };
  }
  const lines = text.split("\n");
  // First line is the opening '---'. Find the closing '---'.
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      close = i;
      break;
    }
  }
  if (close < 0) {
    // Unclosed block — treat as no frontmatter (don't swallow the body).
    return { frontmatter: {}, body: content, hasFrontmatter: false };
  }

  const fmLines = lines.slice(1, close);
  const body = lines.slice(close + 1).join("\n").replace(/^\n/, "");

  const fm: Frontmatter = {};
  let i = 0;
  while (i < fmLines.length) {
    const line = fmLines[i];
    const trimmed = line.trim();
    i++;
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;

    const colon = line.indexOf(":");
    if (colon < 0) continue; // not a key: value line — skip (defensive)
    const key = line.slice(0, colon).trim();
    if (key.length === 0) continue;
    const rest = line.slice(colon + 1).trim();

    if (rest.length === 0) {
      // Either an empty value or a block array following on `- ` lines.
      const items: unknown[] = [];
      while (i < fmLines.length && fmLines[i].trim().startsWith("- ")) {
        items.push(scalar(fmLines[i].trim().slice(2)));
        i++;
      }
      fm[key] = items.length > 0 ? items : null;
    } else if (rest.startsWith("[")) {
      fm[key] = parseInlineArray(rest);
    } else {
      fm[key] = scalar(rest);
    }
  }

  return { frontmatter: fm, body, hasFrontmatter: true };
}
