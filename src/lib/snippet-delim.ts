/**
 * Search-snippet delimiters — the control characters wrapped around matched
 * terms in a `ts_headline` snippet. Kept in their OWN tiny, dependency-free
 * module (no DB, no node imports) so client components and pure view-models can
 * split snippets without dragging the DB layer (`@/lib/docs`) into the browser
 * bundle. `@/lib/docs` re-exports these as its public surface for callers that
 * already import them from there.
 *
 * They are control chars (STX / ETX), never present in real text, so splitting
 * on them is unambiguous.
 */
export const SNIPPET_START = "\x02";
export const SNIPPET_STOP = "\x03";
