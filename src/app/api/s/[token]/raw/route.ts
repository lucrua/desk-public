import { resolveShare } from "@/lib/shares";
import { downloadContentType, downloadFilename } from "@/lib/download";

/**
 * PUBLIC raw-content endpoint for a share. No principal — the raw token in the
 * path IS the capability. Backs the Download action on the share reader.
 *
 * SECURITY (mirrors the comment route's discipline exactly):
 *  - resolveShare(token) === null  → uniform 404 (unknown / revoked / expired /
 *    unpublished are indistinguishable; no body distinguishes the cause).
 *  - version === null (published doc with no current version) → SAME uniform 404.
 *  - PINNED shares serve the pinned version's content (resolveShare already
 *    resolves the pinned version), so a recipient downloads exactly what was sent.
 *  - No directory listing, no slug enumeration — only this exact token resolves.
 *
 * Returns the stored content with:
 *  - Content-Type: text/markdown (md) | text/html (html), charset utf-8.
 *  - Content-Disposition: attachment; filename="<slug>.<ext>" — forces a
 *    download (never inline-renders the HTML in this origin).
 */

// Resolve fresh every request — revocation / expiry / unpublish must take effect
// immediately, with no caching layer in front.
export const dynamic = "force-dynamic";

function uniform404() {
  // Plain-text body, matching the "not available" discipline (no JSON shape that
  // could leak structure). Status is the only signal.
  return new Response("Not found", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

type RouteContext = { params: Promise<{ token: string }> };

export async function GET(_req: Request, { params }: RouteContext) {
  const { token } = await params;
  const resolved = await resolveShare(token);
  if (resolved === null) return uniform404();
  if (resolved.version === null) return uniform404();

  const format = resolved.doc.format;
  const contentType = downloadContentType(format);
  // Filename from the doc slug (already a safe [a-z0-9-] token) + format ext.
  const filename = downloadFilename(resolved.doc.slug, format);

  return new Response(resolved.version.content, {
    status: 200,
    headers: {
      "content-type": contentType,
      "content-disposition": `attachment; filename="${filename}"`,
      // Never let a CDN / browser cache a capability response.
      "cache-control": "no-store",
    },
  });
}
