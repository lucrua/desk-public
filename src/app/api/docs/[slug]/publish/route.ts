/**
 * POST /api/docs/[slug]/publish — publish a new version directly (no approval).
 *
 * Enforces canPublishVersion: admin OR the doc's owner. A member who is neither
 * admin nor owner gets a 403. A non-existent slug also returns 403 (uniform —
 * no existence signal for members).
 *
 * Body: { content, title?, path? }
 *   - content: the full new doc body (markdown or html, same format as existing)
 *   - title: optional, updates the title if provided
 *   - path: optional, updates the folder path if provided
 *
 * This is the direct-publish path for the web editor (canPublishDirect === true).
 * The MCP channel uses publish_doc (with relaxed guard).
 */
import { NextResponse } from "next/server";
import { getPrincipal, isStaff } from "@/lib/auth";
import { getDocBySlug, getLiveDocBySpacePath, scopeForPrincipal } from "@/lib/docs";
import { canPublishVersion } from "@/lib/permissions";
import { getSpaceById } from "@/lib/spaces";
import { webAuthorCommit, liveMainTip, type WebAuthorIdentity } from "@/lib/web-author";
import { MAX_CONTENT_CHARS } from "@/lib/limits";

function err(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

type RouteContext = { params: Promise<{ slug: string }> };

/** A stable web-author identity from a reviewer/publisher display name. This
 * direct publish lands on `main` as `owner` (authoritative), so the handle is a
 * label only. */
function identityFromName(name: string): WebAuthorIdentity {
  const handle =
    (name || "owner")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "") || "owner";
  return { name: name || "Desk user", email: `${handle}@desk.localhost`, handle };
}

/**
 * POST /api/docs/[slug]/publish — direct-publish a new version of an EXISTING
 * doc (admin OR the doc's owner). Truth = git: the content is committed to the
 * doc's `(space, sourcePath)` on `main` via `webAuthorCommit` (role forced to
 * `owner` — a direct publish is authoritative) and the reindex projects it. No
 * doc content is written to Postgres here.
 */
export async function POST(req: Request, { params }: RouteContext) {
  const principal = await getPrincipal(req.headers as unknown as Headers);
  if (!isStaff(principal)) return err(403, "Forbidden — staff only");

  const { slug } = await params;

  // Load the doc (admin sees unpublished too; members see scoped).
  const result = await getDocBySlug(slug, {
    includeUnpublished: principal.kind === "admin",
    scope: await scopeForPrincipal(principal),
  });

  // Uniform 403 for missing OR out-of-scope: no existence signal.
  if (!result) return err(403, "Forbidden");

  // Permission check: admin OR owner of this specific doc.
  if (!canPublishVersion(principal, result.doc)) {
    return err(403, "Forbidden — only the doc owner or an admin may publish directly");
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err(400, "Invalid JSON body");
  }

  const b = body as Record<string, unknown>;

  if (!b.content || typeof b.content !== "string") {
    return err(400, "Missing or invalid content — must be a non-empty string");
  }
  if (b.content.length > MAX_CONTENT_CHARS) {
    return err(400, `Content too large (max ${MAX_CONTENT_CHARS} chars)`);
  }

  // Resolve the doc's owning space (its slug is the commit target).
  const space = await getSpaceById(result.doc.spaceId);
  if (!space) return err(500, "Doc has no resolvable space");

  const identity = identityFromName(principal.name);
  const sourcePath = result.doc.sourcePath;

  // Commit the new content on `main` (CAS on the live tip; retry ONCE on stale).
  let committed:
    | Awaited<ReturnType<typeof webAuthorCommit>>
    | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const baseMainTip = await liveMainTip(space.slug);
    const r = await webAuthorCommit(space.slug, {
      role: "owner",
      identity,
      writes: [{ path: sourcePath, bytes: Buffer.from(b.content, "utf8") }],
      baseMainTip,
      message: `publish ${sourcePath}`,
    });
    if (r.ok) {
      committed = r;
      break;
    }
    if (r.reason === "stale") continue; // re-read the tip and retry once
    if (r.reason === "forbidden") return err(403, "Forbidden");
    if (r.reason === "mirrored") return err(409, r.detail ?? "This space mirrors from GitHub — writes are refused.");
    return err(500, r.detail ?? "Could not publish");
  }
  if (!committed || !committed.ok) {
    return err(409, "This doc changed while you were editing — reload and retry.");
  }

  // Re-read the projected doc for the new version id.
  const after = await getLiveDocBySpacePath(result.doc.spaceId, sourcePath);

  return NextResponse.json(
    {
      ok: true,
      slug,
      versionId: after?.currentVersionId ?? null,
      ref: committed.ref,
      ownerUserId: result.doc.ownerUserId ?? null,
    },
    { status: 200 },
  );
}
