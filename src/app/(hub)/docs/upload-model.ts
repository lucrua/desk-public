/**
 * Pure helpers for the upload island (UploadDoc.tsx).
 *
 * Extracted so the validation / format-derivation logic is unit-testable
 * without jsdom-mounting the component. No React, no DOM, no node imports —
 * same client-safety constraint as src/lib/slug.ts.
 */

import { isValidSlug } from "@/lib/slug";

/** Max upload size enforced client-side. Mirrors the server's char cap as a
 *  byte ceiling — the server (MAX_CONTENT_CHARS) is the real backstop. */
export const MAX_UPLOAD_BYTES = 2_000_000;

/** Accepted upload extensions → stored doc format. */
const EXT_FORMAT: Record<string, "md" | "html"> = {
  md: "md",
  markdown: "md",
  html: "html",
  htm: "html",
};

/** The `accept` attribute for the file input. */
export const ACCEPT_EXTENSIONS = ".md,.markdown,.html,.htm";

/** Lowercased final extension of a filename, or "" if none. */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

/** Format for a filename, or null if the extension isn't accepted. */
export function formatFromFilename(name: string): "md" | "html" | null {
  return EXT_FORMAT[extensionOf(name)] ?? null;
}

/**
 * Accept a dragged filename: returns the format if accepted, null if not.
 * Pure function — no DOM, no side-effects — so it's fully unit-testable.
 */
export function acceptFile(name: string): "md" | "html" | null {
  return formatFromFilename(name);
}

export type UploadValidation =
  | { ok: true; format: "md" | "html" }
  | { ok: false; error: string };

/**
 * Validate a fully-filled upload form. Returns the derived `format` on success,
 * or the first blocking error message.
 *
 * Audiences v2: upload no longer asks for an audience. A new doc lands in
 * `private` (set the audience afterwards from the doc page's Sharing panel), so
 * there is no audience field here to validate.
 */
export function validateUpload(input: {
  filename: string;
  byteSize: number;
  slug: string;
  title: string;
}): UploadValidation {
  const format = formatFromFilename(input.filename);
  if (format === null) {
    return { ok: false, error: "Unsupported file type — upload .md, .markdown, .html, or .htm." };
  }
  if (input.byteSize > MAX_UPLOAD_BYTES) {
    return { ok: false, error: "File too large — the limit is 2 MB." };
  }
  if (!isValidSlug(input.slug)) {
    return { ok: false, error: "Slug must match ^[a-z0-9][a-z0-9-]*$ (lowercase letters, digits, dashes; no leading dash)." };
  }
  if (!input.title.trim()) {
    return { ok: false, error: "Title is required." };
  }
  return { ok: true, format };
}
