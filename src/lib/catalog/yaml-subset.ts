/**
 * A tiny, dependency-free YAML-SUBSET parser for `.desk.collection.yml`.
 *
 * Desk deliberately carries no YAML dependency (see frontmatter.ts). The
 * collection config is small and well-shaped, but — unlike doc frontmatter — it
 * NESTS (a `fields:` map of maps, a `views:` list of maps). This module parses
 * exactly that: indentation-based nested mappings, block + inline lists, inline
 * `{…}` flow maps, and scalars. Anything it can't make sense of is skipped, not
 * thrown: a malformed config must degrade to "no schema" (auto mode), never
 * crash the catalog.
 *
 * Supported:
 *   - `key: scalar`                       → string | number | boolean | null
 *   - `key:` then indented child lines    → nested mapping
 *   - `key: [a, b, c]`                    → inline flow list of scalars
 *   - `key:` then `- item` lines          → block list (scalars OR inline maps)
 *   - `- { type: list }`                  → inline flow map list item
 *   - quoted scalars ("…" / '…')          → unquoted
 *   - `# comments` on their own line      → ignored
 *
 * NOT supported (and not needed): multi-line scalars, anchors/aliases, complex
 * keys, tabs for indentation. Two-space indentation is assumed (any consistent
 * indent width works since we compare relative depth, not absolute columns).
 */

export type YamlValue =
  | string
  | number
  | boolean
  | null
  | YamlValue[]
  | { [k: string]: YamlValue };

type Line = { indent: number; text: string };

function indentOf(raw: string): number {
  let n = 0;
  for (const ch of raw) {
    if (ch === " ") n++;
    else break;
  }
  return n;
}

function unquote(s: string): string {
  const t = s.trim();
  if (
    t.length >= 2 &&
    ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))
  ) {
    return t.slice(1, -1);
  }
  return t;
}

/** Coerce a bare scalar token to string | number | boolean | null. */
function scalar(raw: string): YamlValue {
  const t = raw.trim();
  if (t.length === 0) return "";
  const lower = t.toLowerCase();
  if (lower === "true") return true;
  if (lower === "false") return false;
  if (lower === "null" || lower === "~") return null;
  if ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'"))) {
    return unquote(t);
  }
  if (/^-?\d+$/.test(t)) return parseInt(t, 10);
  if (/^-?\d*\.\d+$/.test(t)) return parseFloat(t);
  return t;
}

/** Split a flow body (`a, b, c` — already stripped of [] / {}) on top-level
 * commas, respecting quotes. */
function splitFlow(inner: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (const ch of inner) {
    if (quote) {
      if (ch === quote) quote = null;
      cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === ",") {
      parts.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim().length > 0 || parts.length > 0) parts.push(cur);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

function parseInlineList(raw: string): YamlValue[] {
  const inner = raw.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (inner.trim().length === 0) return [];
  return splitFlow(inner).map((p) => parseFlowValue(p));
}

function parseInlineMap(raw: string): { [k: string]: YamlValue } {
  const inner = raw.trim().replace(/^\{/, "").replace(/\}$/, "");
  const out: { [k: string]: YamlValue } = {};
  for (const part of splitFlow(inner)) {
    const colon = part.indexOf(":");
    if (colon < 0) continue;
    const key = part.slice(0, colon).trim();
    const val = part.slice(colon + 1).trim();
    if (key.length > 0) out[key] = parseFlowValue(val);
  }
  return out;
}

/** A scalar or a flow collection (`[…]` / `{…}`). */
function parseFlowValue(raw: string): YamlValue {
  const t = raw.trim();
  if (t.startsWith("[")) return parseInlineList(t);
  if (t.startsWith("{")) return parseInlineMap(t);
  return scalar(t);
}

/** Collect the contiguous block of lines more-indented than `parentIndent`. */
function childBlock(lines: Line[], start: number, parentIndent: number): { block: Line[]; next: number } {
  const block: Line[] = [];
  let i = start;
  while (i < lines.length && lines[i].indent > parentIndent) {
    block.push(lines[i]);
    i++;
  }
  return { block, next: i };
}

/** Parse a block of equally-or-more-indented lines as a mapping or a list. */
function parseBlock(lines: Line[]): YamlValue {
  if (lines.length === 0) return {};
  const baseIndent = lines[0].indent;
  const isList = lines[0].text.startsWith("- ") || lines[0].text === "-";

  if (isList) {
    const out: YamlValue[] = [];
    let i = 0;
    while (i < lines.length) {
      const ln = lines[i];
      if (ln.indent !== baseIndent || !(ln.text.startsWith("- ") || ln.text === "-")) {
        i++;
        continue;
      }
      const itemHead = ln.text === "-" ? "" : ln.text.slice(2).trim();
      const { block, next } = childBlock(lines, i + 1, baseIndent);

      if (itemHead.length === 0) {
        // The item's content is the indented child block (a nested map/list).
        out.push(block.length > 0 ? parseBlock(reindent(block)) : null);
      } else if (itemHead.startsWith("{") || itemHead.startsWith("[")) {
        out.push(parseFlowValue(itemHead));
      } else if (itemHead.includes(":") && !looksLikeScalarWithColon(itemHead)) {
        // `- key: value` — the dash introduces a one-key (or multi-key via the
        // child block) inline mapping. The head key and any sibling keys in the
        // child block must land at the SAME synthetic indent so parseBlock reads
        // them as one mapping. The child lines are indented to align past the
        // "- " marker (≈ baseIndent + 2); flatten them to the head's level.
        const synthetic: Line[] = [
          { indent: 0, text: itemHead },
          ...reindent(block).map((b) => ({ indent: b.indent, text: b.text })),
        ];
        out.push(parseBlock(reindent(synthetic)));
      } else {
        out.push(scalar(itemHead));
      }
      i = next;
    }
    return out;
  }

  // Mapping.
  const out: { [k: string]: YamlValue } = {};
  let i = 0;
  while (i < lines.length) {
    const ln = lines[i];
    if (ln.indent !== baseIndent) {
      i++;
      continue;
    }
    const colon = colonSplit(ln.text);
    if (colon < 0) {
      i++;
      continue;
    }
    const key = ln.text.slice(0, colon).trim();
    const rest = ln.text.slice(colon + 1).trim();
    const { block, next } = childBlock(lines, i + 1, baseIndent);

    if (rest.length > 0) {
      out[key] = parseFlowValue(rest);
      i = next; // skip any (unexpected) deeper lines under a scalar
    } else if (block.length > 0) {
      out[key] = parseBlock(reindent(block));
      i = next;
    } else {
      out[key] = null;
      i = next;
    }
  }
  return out;
}

/** True when a `key: value` head's colon is actually inside a quoted/flow scalar
 * (so it should be treated as a plain scalar, not a mapping). */
function looksLikeScalarWithColon(s: string): boolean {
  const t = s.trim();
  return t.startsWith('"') || t.startsWith("'") || t.startsWith("[") || t.startsWith("{");
}

/** Index of the key/value colon in a mapping line, or -1. Ignores colons inside
 * quotes and a trailing flow value. */
function colonSplit(text: string): number {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ":") {
      // a real key: value colon is followed by EOL or whitespace
      if (i + 1 >= text.length || text[i + 1] === " ") return i;
    }
  }
  return -1;
}

/** Shift a child block's indentation so its shallowest line is at column 0,
 * preserving RELATIVE nesting. Lets parseBlock recurse without absolute columns. */
function reindent(block: Line[]): Line[] {
  if (block.length === 0) return block;
  const min = Math.min(...block.map((l) => l.indent));
  return block.map((l) => ({ indent: l.indent - min, text: l.text }));
}

/**
 * Parse a YAML-subset document into a YamlValue (typically a mapping). Comments
 * and blank lines are stripped first. Never throws.
 */
export function parseYamlSubset(text: string): YamlValue {
  const lines: Line[] = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((raw) => ({ indent: indentOf(raw), text: raw.trim() }))
    .filter((l) => l.text.length > 0 && !l.text.startsWith("#") && l.text !== "---");
  if (lines.length === 0) return {};
  return parseBlock(reindent(lines));
}
