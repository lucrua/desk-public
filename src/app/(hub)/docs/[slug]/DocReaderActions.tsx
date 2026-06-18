"use client";

import { useState } from "react";
import { downloadContentType, downloadFilename } from "@/lib/download";

/**
 * Copy + Download for the internal (staff) doc reader.
 *
 * No new server route: the current version's content is already rendered on the
 * page, so it's passed in and we build a Blob client-side for Download. Copy
 * writes the same source to the clipboard. Mirrors the share reader's quiet
 * affordances but styled to sit in the doc-page action area.
 *
 * - md docs → .md, text/markdown.
 * - html docs → .html, text/html.
 */
export default function DocReaderActions({
  slug,
  source,
  format,
}: {
  slug: string;
  source: string;
  format: "md" | "html";
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(source);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked — Download is the fallback.
    }
  }

  function download() {
    const blob = new Blob([source], { type: downloadContentType(format) });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = downloadFilename(slug, format);
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoke on the next tick so the click has started the download.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  const btn: React.CSSProperties = {
    fontSize: 12.5,
    fontWeight: 500,
    padding: "6px 12px",
    borderRadius: 7,
    border: "1px solid var(--hairline)",
    background: "var(--surface)",
    color: "var(--ink)",
    cursor: "pointer",
    fontFamily: "var(--font-sans)",
  };

  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <button type="button" onClick={copy} style={btn}>
        {copied ? "Copied!" : "Copy source"}
      </button>
      <button type="button" onClick={download} style={btn}>
        Download
      </button>
    </div>
  );
}
