/**
 * Raw asset serve (Web-author, Slice W1.3) — GET streams a committed file's
 * bytes from a space's bare repo at `main`. This is how an uploaded NON-doc file
 * (image / PDF / data file) is viewed or shared: it lives as truth in git but is
 * NOT projected as a `docs` row (the projection is markdown/HTML-only), so it
 * has no rendered page — it is served byte-for-byte here.
 *
 * AUTH (the access boundary is sacred — SAME read gate as the space's docs,
 * never looser): a principal sees a file iff admin, OR a member of the space, OR
 * the space's visibility ∈ {public, unlisted}. A non-member on a private space
 * → UNIFORM 404 (no bytes, no existence leak). Mirrors lib/docs.ts
 * `canSeeDocSpace` + `scopeForPrincipal`. Anonymous on a non-public space → 404.
 *
 * The path is the repo-relative path under `[...path]`. It is validated against
 * the traversal guard (isSafeRepoPath) before any git read, and the read is
 * scoped to the `main` tree (`readBlob(main:path)`), so it can only ever surface
 * a committed blob on the hosted branch — never `.git` internals or a sibling
 * space.
 */
import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { scopeForPrincipal, canSeeDocSpace } from "@/lib/docs";
import { getSpaceBySlug, ownerSlugForUser } from "@/lib/spaces";
import { bareRepoPath, refTip, readBlob, DEFAULT_BRANCH } from "@/lib/git/repo";
import { isSafeRepoPath } from "@/lib/git/web-commit";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ slug: string; path: string[] }> };

/** Minimal extension→MIME map for the binary lane. Unknown → octet-stream
 * (the browser downloads). text/html is served as text/plain to avoid serving
 * an attacker-controlled HTML page same-origin (defense in depth). */
const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  json: "application/json; charset=utf-8",
  ico: "image/x-icon",
};

function contentTypeFor(p: string): string {
  const dot = p.lastIndexOf(".");
  const ext = dot >= 0 ? p.slice(dot + 1).toLowerCase() : "";
  return MIME[ext] ?? "application/octet-stream";
}

export async function GET(req: Request, { params }: RouteContext) {
  const { slug, path: segments } = await params;

  const space = await getSpaceBySlug(slug);
  if (!space) return new NextResponse("Not found", { status: 404 });

  // READ gate: same as the space's docs. Resolve the principal's viewer scope,
  // then check space-level visibility/membership. Fail-closed (no existence leak).
  const principal = await getPrincipal(req.headers as unknown as Headers);
  const scope = await scopeForPrincipal(principal);
  const canSee = await canSeeDocSpace(scope.viewer, space.id, scope.userId);
  if (!canSee) return new NextResponse("Not found", { status: 404 });

  // Reconstruct + validate the repo-relative path (no traversal, no absolute,
  // no .git). A bad path is indistinguishable from a missing file → 404.
  const repoRelPath = (segments ?? []).join("/");
  if (!isSafeRepoPath(repoRelPath)) {
    return new NextResponse("Not found", { status: 404 });
  }

  const owner = await db.query.users.findFirst({ where: eq(users.id, space.ownerUserId) });
  const ownerSlug = ownerSlugForUser(owner ?? null, space.ownerUserId);
  const repoPath = bareRepoPath(ownerSlug, space.slug);

  let tip: string | null;
  try {
    tip = await refTip(repoPath, DEFAULT_BRANCH);
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
  if (!tip) return new NextResponse("Not found", { status: 404 });

  const bytes = await readBlob(repoPath, tip, repoRelPath);
  if (bytes === null) return new NextResponse("Not found", { status: 404 });

  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "content-type": contentTypeFor(repoRelPath),
      // nosniff: never let the browser re-interpret octet-stream as HTML/JS.
      "x-content-type-options": "nosniff",
      // The blob is content-addressed by the commit; cache privately.
      "cache-control": "private, max-age=60",
    },
  });
}
