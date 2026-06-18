/**
 * Catalog auto-linking — the generalized `F-NNN`-style reference linker.
 *
 * Given the active { kind, idPattern } set, find occurrences of any kind's id
 * inside a text run and turn them into navigable refs to /catalog/[kind]/[id].
 * Used by the staff Markdown renderer (doc + card bodies). On share pages the
 * caller simply does NOT pass the patterns, so refs stay plain text — the
 * existing "share refs are plain text" rule.
 *
 * This module is pure (no React) so the segmentation is unit-testable and the
 * same logic backs both the rehype plugin and any future consumer.
 */

export type CatalogPattern = { kind: string; idPattern: string };

export type RefSegment =
  | { type: "text"; value: string }
  | { type: "ref"; kind: string; itemId: string; href: string };

// ── idPattern safety guard ───────────────────────────────────────────────────
//
// idPatterns are admin-supplied regex SOURCES that run against every doc/card
// body on every staff render. JS regexes backtrack, so a pattern shaped like
// `(a+)+` is a ReDoS: it compiles fine but takes minutes against a ~40-char
// input, wedging SSR for ALL staff. The guard below is a static check applied
// at schema-upsert time (reject at write) AND at match time (skip defensively,
// in case a bad pattern predates the guard):
//
//   - source length cap (an id pattern is short — F-\d+, RFC-\d+, …),
//   - reject any QUANTIFIED GROUP whose content itself contains a quantifier
//     (the (a+)+ / (a*)* / (?:\d+){2,} family — the classic catastrophic shape).
//
// This is deliberately conservative, not a complete ReDoS analysis (overlapping
// alternation like (a|aa)+ slips through); the patterns we expect are simple
// prefixed-counter ids, and anything fancier should use a linear-time engine.

/** Max length of an idPattern regex source. */
export const MAX_ID_PATTERN_CHARS = 200;

/** Does `content` (a group body) contain an unescaped quantifier? `[...]`
 * classes and `\`-escapes are skipped (a literal `+` in a class is harmless). */
function contentHasQuantifier(content: string): boolean {
  let inClass = false;
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") {
      inClass = true;
      continue;
    }
    if (c === "+" || c === "*") return true;
    if (c === "{" && /^\{\d+(,\d*)?\}/.test(content.slice(i))) return true;
  }
  return false;
}

/** True iff the source contains a quantified group whose body has a quantifier
 * — the catastrophic-backtracking shape ((a+)+ etc.). */
function hasNestedQuantifier(src: string): boolean {
  const stack: number[] = [];
  let inClass = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") {
      inClass = true;
      continue;
    }
    if (c === "(") {
      stack.push(i);
      continue;
    }
    if (c === ")") {
      const start = stack.pop();
      if (start == null) continue;
      const next = src[i + 1];
      const quantified =
        next === "+" || next === "*" || (next === "{" && /^\{\d+(,\d*)?\}/.test(src.slice(i + 1)));
      if (quantified && contentHasQuantifier(src.slice(start + 1, i))) return true;
    }
  }
  return false;
}

/**
 * Static safety check for an idPattern source. Returns ok or the reason it was
 * rejected. Used by upsertSchema (write-time rejection) and by the matchers
 * (defensive skip of any pre-existing unsafe pattern).
 */
export function idPatternGuard(source: string): { ok: true } | { ok: false; error: string } {
  if (source.trim().length === 0) {
    return { ok: false, error: "idPattern must be non-empty" };
  }
  if (source.length > MAX_ID_PATTERN_CHARS) {
    return { ok: false, error: `idPattern too long (max ${MAX_ID_PATTERN_CHARS} chars)` };
  }
  if (hasNestedQuantifier(source)) {
    return {
      ok: false,
      error:
        "idPattern contains a nested quantifier (e.g. (a+)+) — this backtracks catastrophically; use a simple id shape like F-\\d+",
    };
  }
  return { ok: true };
}

/**
 * Build a single combined matcher over all patterns. Each pattern becomes a
 * named-ish alternative; we track which kind produced a match by testing the
 * matched substring against each pattern's anchored form (cheap, and avoids
 * fragile named-group bookkeeping across arbitrary user regexes).
 *
 * A bad/uncompilable/unsafe pattern is skipped (it can't break — or wedge —
 * the whole linker). Returns null when there are no usable patterns.
 */
function buildMatcher(patterns: CatalogPattern[]): {
  combined: RegExp;
  anchored: Array<{ kind: string; re: RegExp }>;
} | null {
  const usable: Array<{ kind: string; idPattern: string; anchored: RegExp }> = [];
  for (const p of patterns) {
    if (!idPatternGuard(p.idPattern).ok) continue; // defensive ReDoS skip
    try {
      const anchored = new RegExp(`^(?:${p.idPattern})$`);
      usable.push({ kind: p.kind, idPattern: p.idPattern, anchored });
    } catch {
      // skip invalid pattern
    }
  }
  if (usable.length === 0) return null;
  // Combined global matcher with word-ish boundaries so `F-12` doesn't match
  // inside `XF-123` or `F-123`. Longer ids win naturally because the regex is
  // greedy within each alternative; we order alternatives as given.
  const union = usable.map((u) => `(?:${u.idPattern})`).join("|");
  let combined: RegExp;
  try {
    combined = new RegExp(`(?<![\\w-])(?:${union})(?![\\w-])`, "g");
  } catch {
    return null;
  }
  return { combined, anchored: usable.map((u) => ({ kind: u.kind, re: u.anchored })) };
}

/**
 * Split a text run into alternating text / ref segments. When `patterns` is
 * empty or null, returns a single text segment (no linking — the share-page
 * behavior). The `kind` assigned to a match is the FIRST pattern (in the given
 * order) whose anchored form matches the substring — so callers should pass
 * patterns in a stable, deterministic order.
 */
export function segmentRefs(
  text: string,
  patterns: CatalogPattern[] | null | undefined,
): RefSegment[] {
  if (!patterns || patterns.length === 0) return [{ type: "text", value: text }];
  const matcher = buildMatcher(patterns);
  if (!matcher) return [{ type: "text", value: text }];

  const segments: RefSegment[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  const re = matcher.combined;
  re.lastIndex = 0;
  while ((m = re.exec(text)) !== null) {
    const matched = m[0];
    const kind = matcher.anchored.find((a) => a.re.test(matched))?.kind;
    if (kind === undefined) {
      // Shouldn't happen (combined ⊆ union of anchored), but be safe.
      if (m.index === re.lastIndex) re.lastIndex++;
      continue;
    }
    if (m.index > last) segments.push({ type: "text", value: text.slice(last, m.index) });
    segments.push({
      type: "ref",
      kind,
      itemId: matched,
      href: `/catalog/${encodeURIComponent(kind)}/${encodeURIComponent(matched)}`,
    });
    last = m.index + matched.length;
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  if (last < text.length) segments.push({ type: "text", value: text.slice(last) });
  return segments.length > 0 ? segments : [{ type: "text", value: text }];
}

/** True iff the text contains at least one catalog ref under these patterns. */
export function hasRef(text: string, patterns: CatalogPattern[] | null | undefined): boolean {
  return segmentRefs(text, patterns).some((s) => s.type === "ref");
}
