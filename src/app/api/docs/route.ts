import { NextResponse } from "next/server";
import { getPrincipal, isStaff } from "@/lib/auth";
import { listDocs, searchDocs, getLiveDocBySpacePath, scopeForPrincipal } from "@/lib/docs";
import {
  webAuthorCommit,
  liveMainTip,
  resolveWebAuthorAccess,
} from "@/lib/web-author";
import { resolveSpaceArg } from "@/lib/spaces";
import { isSafeRepoPath } from "@/lib/git/web-commit";
import { normalizePath } from "@/lib/path";

import { MAX_CONTENT_CHARS } from "@/lib/limits";

function err(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

/**
 * POST /api/docs — publish a file into a SPACE by committing it to git (truth =
 * git; the indexer projects it — no doc content is written to Postgres here).
 * REQUIRES `space` (slug) + `path` (repo-relative file path). Content is
 * committed via `webAuthorCommit`, honoring the space's push_policy: owner/admin
 * (and writers under `direct`) → `main`; a non-owner writer under `proposal` →
 * a `proposals/<handle>` ref. Returns { slug, url, ref } (slug/url null for a
 * proposal write — no projection until it is accepted).
 */
export async function POST(req: Request) {
  const principal = await getPrincipal(req.headers as unknown as Headers);
  if (!isStaff(principal)) return err(403, "Forbidden — staff only");

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err(400, "Invalid JSON body");
  }

  const b = body as Record<string, unknown>;
  const { space, path, content, title, message } = b;

  if (!space || typeof space !== "string") {
    return err(400, "Missing or invalid space (owner-qualified `handle/slug`, or a bare slug when unambiguous)");
  }
  if (!path || typeof path !== "string" || !isSafeRepoPath(path)) {
    return err(400, "Missing or invalid path (repo-relative file path; no leading slash, no '..')");
  }
  if (!content || typeof content !== "string") {
    return err(400, "Missing content");
  }
  if (content.length > MAX_CONTENT_CHARS) {
    return err(413, `Content too large (${content.length} chars; max ${MAX_CONTENT_CHARS})`);
  }

  // Owner-qualify the space arg (handle/slug, or an unambiguous bare slug — D6).
  // Unknown/ambiguous resolves to the SAME 403 as no write authority (no leak).
  const resolvedSpace = await resolveSpaceArg(space.trim());
  if (!resolvedSpace.ok) {
    return err(403, "Forbidden — you may not write to this space");
  }
  // READ/existence boundary + resolve space role (owner|writer|reader), FAIL-CLOSED.
  const access = await resolveWebAuthorAccess(principal, resolvedSpace.space);
  if (!access.ok) {
    // A non-member / reader → 403 (no space-write authority).
    return err(403, "Forbidden — you may not write to this space");
  }

  // Prepend an H1 for a markdown file with no heading when a title is given.
  const lower = path.toLowerCase();
  const isMd = lower.endsWith(".md") || lower.endsWith(".markdown");
  const titleStr = typeof title === "string" ? title.trim() : "";
  const finalContent =
    titleStr && isMd && !/^#[ \t]+/m.test(content) ? `# ${titleStr}\n\n${content}` : content;

  const baseMainTip = await liveMainTip(access.spaceId);
  const result = await webAuthorCommit(access.spaceId, {
    role: access.role,
    identity: access.identity,
    writes: [{ path, bytes: Buffer.from(finalContent, "utf8") }],
    baseMainTip,
    message: typeof message === "string" && message.trim() ? message.trim() : `publish ${path}`,
  });

  if (!result.ok) {
    if (result.reason === "forbidden") return err(403, "Forbidden — you may not write to this space");
    if (result.reason === "mirrored") return err(409, result.detail ?? "This space mirrors from GitHub — writes are refused.");
    if (result.reason === "stale") {
      return err(409, "The space changed while publishing — reload and retry.");
    }
    return err(500, result.detail ?? "Could not publish");
  }

  const projected =
    result.target === "main" ? await getLiveDocBySpacePath(access.spaceId, path) : null;
  const slug = projected?.slug ?? null;
  const url = slug
    ? `${process.env.HUB_BASE_URL ?? "http://localhost:3000"}/docs/${slug}`
    : null;

  return NextResponse.json({
    ok: true,
    slug,
    url,
    ref: result.ref,
    target: result.target,
    path,
    newSha: result.newSha,
    proposalName: result.proposalName ?? null,
  });
}

export async function GET(req: Request) {
  const principal = await getPrincipal(req.headers as unknown as Headers);
  if (!isStaff(principal)) {
    return err(403, "Forbidden — staff only");
  }

  const url = new URL(req.url);
  // Optional folder-path prefix filter. An invalid path → 400 (don't silently
  // ignore garbage). Absent/empty → no filter.
  const rawPath = url.searchParams.get("path");
  let pathPrefix: string | undefined;
  if (rawPath !== null && rawPath.trim().length > 0) {
    const np = normalizePath(rawPath);
    if (np === null) {
      return err(400, "Invalid path — segments must match ^[a-z0-9][a-z0-9-]*$, max depth 6");
    }
    pathPrefix = np;
  }

  // When `q` is present, switch to full-text search (ranked, with a snippet
  // per row). Same list shape as listDocs plus a `snippet` field (and `rank`).
  // Audience scoping + unpublished handling are identical (enforced in the
  // service). Empty/whitespace q → falls through to the plain list.
  const scope = await scopeForPrincipal(principal);

  const rawQ = url.searchParams.get("q");
  const q = rawQ?.trim();
  if (q && q.length > 0) {
    const docs = await searchDocs(q, {
      includeUnpublished: principal.kind === "admin",
      scope,
      ...(pathPrefix !== undefined ? { path: pathPrefix } : {}),
    });
    return NextResponse.json({ docs });
  }

  const docs = await listDocs({
    includeUnpublished: principal.kind === "admin",
    scope,
    ...(pathPrefix !== undefined ? { path: pathPrefix } : {}),
  });
  return NextResponse.json({ docs });
}
