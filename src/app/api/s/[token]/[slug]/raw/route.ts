import { resolveShareDoc } from "@/lib/shares";
import { downloadContentType, downloadFilename } from "@/lib/download";

/**
 * PUBLIC raw-content endpoint for a doc opened UNDER a directory share. The dir
 * token in the path is the capability; the slug names a doc, but resolveShareDoc
 * verifies it is PUBLISHED and UNDER the share's prefix — so a foreign slug can
 * never download an arbitrary doc.
 *
 * SECURITY (byte-identical 404 discipline to /api/s/[token]/raw):
 *  - resolveShareDoc(token, slug) === null → uniform 404 (unknown/revoked/expired
 *    token, non-directory share, unknown slug, slug-outside-prefix, unpublished,
 *    or no current version — ALL indistinguishable; status is the only signal).
 *  - No directory listing, no slug enumeration beyond the shared prefix.
 */
export const dynamic = "force-dynamic";

function uniform404() {
  return new Response("Not found", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

type RouteContext = { params: Promise<{ token: string; slug: string }> };

export async function GET(_req: Request, { params }: RouteContext) {
  const { token, slug } = await params;
  const resolved = await resolveShareDoc(token, slug);
  if (resolved === null) return uniform404();

  const format = resolved.doc.format;
  const contentType = downloadContentType(format);
  const filename = downloadFilename(resolved.doc.slug, format);

  return new Response(resolved.version.content, {
    status: 200,
    headers: {
      "content-type": contentType,
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
}
