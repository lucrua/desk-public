import { NextResponse } from "next/server";
import { getPrincipal, isStaff } from "@/lib/auth";
import { publishDoc, listDocs, searchDocs, scopeForPrincipal } from "@/lib/docs";
import { audienceExists } from "@/lib/audiences";
import { normalizePath } from "@/lib/path";

import { SLUG_RE, MAX_CONTENT_CHARS } from "@/lib/limits";
const VALID_FORMATS = ["md", "html"] as const;
// Hard cap on stored content (covers both CLI and UI upload). Postgres `text`
// has no practical limit, but a runaway paste/upload shouldn't reach the DB.

function err(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(req: Request) {
  const principal = await getPrincipal(req.headers as unknown as Headers);
  if (principal.kind !== "admin") {
    return err(403, "Forbidden — admin only");
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err(400, "Invalid JSON body");
  }

  const b = body as Record<string, unknown>;

  const { slug, title, sourcePath, audience, format, content, path, baseVersionId } = b;

  if (!slug || typeof slug !== "string" || !SLUG_RE.test(slug)) {
    return err(400, "Missing or invalid slug (must match ^[a-z0-9][a-z0-9-]*$)");
  }
  if (!title || typeof title !== "string") {
    return err(400, "Missing title");
  }
  if (!sourcePath || typeof sourcePath !== "string") {
    return err(400, "Missing sourcePath");
  }
  // Audience is OPTIONAL now (Audiences v2): absent → `private` (the default
  // group — only the author/admins + explicitly-added members see it). When
  // provided it must be a string; existence is validated below as before.
  let audienceKey: string;
  if (audience === undefined || audience === null) {
    audienceKey = "private";
  } else if (typeof audience === "string" && audience.trim().length > 0) {
    audienceKey = audience.trim();
  } else {
    return err(400, "audience must be a non-empty string when provided");
  }
  if (!format || !VALID_FORMATS.includes(format as (typeof VALID_FORMATS)[number])) {
    return err(400, "Missing or invalid format (must be 'md' or 'html')");
  }
  if (!content || typeof content !== "string") {
    return err(400, "Missing content");
  }
  if (content.length > MAX_CONTENT_CHARS) {
    return err(413, `Content too large (${content.length} chars; max ${MAX_CONTENT_CHARS})`);
  }
  // Optional folder path — validate + canonicalize. Absent → leave to the
  // service (column default on create, unchanged on existing).
  let normalizedPath: string | undefined;
  if (path !== undefined) {
    const np = normalizePath(path);
    if (np === null) {
      return err(400, "Invalid path — segments must match ^[a-z0-9][a-z0-9-]*$, max depth 6");
    }
    normalizedPath = np;
  }
  // Optional optimistic-concurrency base.
  let base: number | undefined;
  if (baseVersionId !== undefined) {
    if (typeof baseVersionId !== "number" || !Number.isInteger(baseVersionId) || baseVersionId <= 0) {
      return err(400, "baseVersionId must be a positive integer");
    }
    base = baseVersionId;
  }
  // Audiences are data now — the key must already exist (created in /admin).
  // `private` is seeded by migration 0010, so the default always resolves.
  if (!(await audienceExists(audienceKey))) {
    return err(400, "unknown audience — create it in /admin first");
  }

  const result = await publishDoc({
    slug,
    title,
    sourcePath,
    audience: audienceKey,
    format: format as "md" | "html",
    content,
    by: principal.name,
    ...(normalizedPath !== undefined ? { path: normalizedPath } : {}),
    ...(base !== undefined ? { baseVersionId: base } : {}),
    // Set the creator as the owner on initial create (principal.userId may be
    // undefined in dev mode — harmless, owner stays null).
    ...(principal.userId !== undefined ? { ownerUserId: principal.userId } : {}),
  });

  if (!result.ok) {
    // Optimistic-concurrency conflict — the doc moved on under the caller.
    return NextResponse.json(
      {
        error: "Version conflict — the doc has a newer version than your base",
        current_version_id: result.currentVersionId,
        current_content_hash: result.currentContentHash,
      },
      { status: 409 },
    );
  }

  const hubUrl = `${process.env.HUB_BASE_URL ?? "http://localhost:3000"}/docs/${slug}`;

  return NextResponse.json({
    slug: result.slug,
    versionId: result.versionId,
    versionNumber: result.versionNumber,
    isNewDoc: result.isNewDoc,
    isNewVersion: result.isNewVersion,
    hubUrl,
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
