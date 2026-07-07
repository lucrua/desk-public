import { splitSnippet, type SnippetRun } from "./tree-model";

/**
 * Renders a search-result snippet with matched terms highlighted.
 *
 * Accepts either the raw delimiter-encoded `snippet` string returned by
 * `searchDocs` (STX/ETX markers around matches — see `SNIPPET_START` /
 * `SNIPPET_STOP` in `@/lib/docs`) or pre-split `runs` (e.g. from a caller that
 * already ran `splitSnippet`, such as a test). Exactly one of the two should be
 * passed; `runs` wins if both are given.
 *
 * XSS-safe by construction: this renders `{r.text}` as React children (text
 * nodes) inside plain `<span>`/`<mark>` elements — never
 * `dangerouslySetInnerHTML`. `splitSnippet` only ever returns plain text runs
 * (the delimiters are control characters, not markup), so anything in a doc
 * body that *looks* like HTML — `<img onerror=…>`, script tags, etc. — is
 * escaped by React on render, exactly like any other text content.
 */
export default function SnippetLine({
  snippet,
  runs,
}: {
  snippet?: string;
  runs?: SnippetRun[];
}) {
  const parts = runs ?? splitSnippet(snippet ?? "");
  if (parts.length === 0) return null;

  return (
    <p
      style={{
        margin: 0,
        fontSize: 13,
        lineHeight: 1.55,
        color: "var(--muted)",
        fontFamily: "var(--font-sans)",
      }}
    >
      {parts.map((r, i) =>
        r.match ? (
          <mark
            key={i}
            style={{
              background: "var(--accent-ring)",
              color: "var(--ink)",
              borderRadius: 3,
              padding: "0 2px",
            }}
          >
            {r.text}
          </mark>
        ) : (
          <span key={i}>{r.text}</span>
        ),
      )}
    </p>
  );
}
