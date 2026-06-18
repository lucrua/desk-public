"use client";

import { useState } from "react";

/**
 * Quiet Copy + Download actions for the share reader's minimal header.
 *
 * - Copy: writes the document SOURCE to the clipboard. For md docs that's the
 *   markdown; for html docs it's the HTML source (we copy what Download would
 *   give you). "Copied!" feedback for ~2s, then reverts.
 * - Download: a plain anchor to the public raw route
 *   (GET /api/s/[token]/raw), which sets Content-Disposition: attachment so the
 *   browser saves the file. No JS needed for the download itself.
 *
 * The full source is passed in from the RSC (already in memory there), so Copy
 * is instant and needs no extra fetch. Kept a tiny client island so the page
 * stays an RSC.
 */
export default function ReaderActions({
  token,
  source,
  slug,
}: {
  token: string;
  source: string;
  /**
   * Set when the reader is a doc opened UNDER a directory share — Download then
   * points at the slug-scoped raw route `/api/s/<token>/<slug>/raw` (same guard).
   * Omitted on a plain doc share → `/api/s/<token>/raw`.
   */
  slug?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(source);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be blocked (insecure context / permissions). Fail quiet —
      // Download is always available as the fallback.
    }
  }

  const actionStyle: React.CSSProperties = {
    fontFamily: "var(--font-mono)",
    fontSize: 11,
    color: "var(--muted)",
    background: "none",
    border: "none",
    padding: 0,
    cursor: "pointer",
    textDecoration: "none",
    whiteSpace: "nowrap",
  };

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 12 }}>
      <button type="button" onClick={copy} style={actionStyle} aria-label="Copy source">
        {copied ? "Copied!" : "Copy"}
      </button>
      <a
        href={
          slug
            ? `/api/s/${encodeURIComponent(token)}/${encodeURIComponent(slug)}/raw`
            : `/api/s/${token}/raw`
        }
        style={actionStyle}
      >
        Download
      </a>
    </span>
  );
}
