/**
 * Derivation for downloading a doc's source — shared by the public share raw
 * route, the share-reader island, and the internal doc-reader island so the
 * three surfaces can't drift on extension or MIME type.
 *
 * `format` is the doc's stored format ("md" | "html"). The returned `filename`
 * uses the slug (already a safe [a-z0-9-] token) + the matching extension; the
 * `contentType` is the matching text/* MIME with a utf-8 charset.
 */
export type DocFormat = "md" | "html";

export function downloadExt(format: DocFormat): "md" | "html" {
  return format === "html" ? "html" : "md";
}

export function downloadContentType(format: DocFormat): string {
  return format === "html"
    ? "text/html; charset=utf-8"
    : "text/markdown; charset=utf-8";
}

export function downloadFilename(slug: string, format: DocFormat): string {
  return `${slug}.${downloadExt(format)}`;
}
