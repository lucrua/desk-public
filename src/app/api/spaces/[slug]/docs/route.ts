/**
 * Web-author write endpoint (Web-author, Slice W1/W2) — a browser SAVE becomes
 * ONE git commit on the space's bare repo. The git-truth replacement for owner
 * doc edits (the legacy DB-revision path stays only for guest propose→accept).
 *
 *   POST /api/spaces/[slug]/docs — CREATE a new doc OR UPLOAD a file.
 *     - new doc (application/json):  { path?, title, content, frontmatter? }
 *     - upload (multipart/form-data): file=<binary> [+ path=<dir>]
 *   PUT  /api/spaces/[slug]/docs — EDIT an existing doc.
 *     - { slug, content, baseCommit }   (baseCommit = docs.currentCommit loaded
 *       by the editor — drives the CAS so a moved main is caught as `stale`).
 *
 * AUTH-SENSITIVE (a server-side write that BYPASSES the git transport, so both
 * boundaries are re-applied here in TypeScript, FAIL-CLOSED):
 *   1. READ/existence boundary (mirrors spaces/[slug]/page.tsx): staff principal,
 *      else a non-member on a private space → UNIFORM 404 (no existence leak).
 *   2. WRITE/ref boundary (push-policy, re-applied off-transport in
 *      lib/web-author.ts): owner/admin → main; a non-owner writer under
 *      `proposal` policy → proposals/<handle>; a reader → forbidden ⇒ 404.
 *
 * On a `main` commit the space reindexes so the doc projects immediately. A CAS
 * loss (the tip moved) returns 409 "changed while editing — reload" and moves no
 * ref (the client preserves its draft).
 */
import { NextResponse } from "next/server";
import { getPrincipal, isStaff } from "@/lib/auth";
import { resolvePrincipalUserId } from "@/lib/principal-user";
import {
  getSpaceBySlug,
  listSpaceMembers,
  type SpaceRole,
} from "@/lib/spaces";
import { getDocBySlug, getLiveDocBySpacePath } from "@/lib/docs";
import { refTip, bareRepoPath, DEFAULT_BRANCH } from "@/lib/git/repo";
import { ownerSlugForUser } from "@/lib/spaces";
import { webAuthorCommit, type WebAuthorIdentity } from "@/lib/web-author";
import { isSafeRepoPath } from "@/lib/git/web-commit";
import { MAX_CONTENT_CHARS } from "@/lib/limits";
import { normalizePath } from "@/lib/path";
import { slugFromFilename } from "@/lib/slug";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

/** A binary upload's max size (bytes). Mirrors the spirit of MAX_CONTENT_CHARS
 * (text) — a coarse storage-DoS guard for the un-projected binary lane. */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MiB

function err(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

/** The uniform 404 — used for BOTH "no such space" and "not allowed", so the
 * endpoint never reveals a space's existence or a caller's (lack of) rights. */
function notFound() {
  return err(404, "Not found");
}

type RouteContext = { params: Promise<{ slug: string }> };

type Resolved = {
  spaceSlug: string;
  role: SpaceRole;
  identity: WebAuthorIdentity;
  spaceId: number;
};

/**
 * Gate the request (READ/existence boundary) and resolve the caller's space role
 * + commit identity. Returns a NextResponse (404) to short-circuit, or the
 * resolved context. Mirrors spaces/[slug]/page.tsx:54-92 + accept/route.ts:44-48.
 */
async function gate(req: Request, slug: string): Promise<Resolved | NextResponse> {
  const principal = await getPrincipal(req.headers as unknown as Headers);
  // Staff-or-identified; anonymous → uniform 404.
  if (!isStaff(principal)) return notFound();

  const space = await getSpaceBySlug(slug);
  if (!space) return notFound();

  const members = (await listSpaceMembers(slug)) ?? [];
  const myUserId = await resolvePrincipalUserId(principal);
  const myMembership = myUserId != null ? members.find((m) => m.userId === myUserId) : undefined;
  const isAdmin = principal.kind === "admin";

  // READ boundary: an admin sees any space; a non-admin must be a member of THIS
  // space. A non-member on a private space gets the same uniform 404. (Matches
  // the space page; public/unlisted membership-less callers still aren't writers.)
  if (!isAdmin && !myMembership) return notFound();

  // The WRITE role: admin and the space owner act as `owner` (unrestricted);
  // otherwise the membership role. A reader resolves to a role web-author won't
  // let write (forbidden ⇒ 404 downstream).
  let role: SpaceRole;
  if (isAdmin || myMembership?.isOwner) {
    role = "owner";
  } else {
    role = (myMembership?.role as SpaceRole) ?? "reader";
  }

  const handle =
    myMembership?.tokenName ??
    (principal.email ? principal.email.split("@")[0] : undefined) ??
    (myMembership?.email ? myMembership.email.split("@")[0] : undefined) ??
    "web";

  const identity: WebAuthorIdentity = {
    name: principal.name || "Desk user",
    email: principal.email ?? `${handle}@desk.localhost`,
    handle,
  };

  return { spaceSlug: slug, role, identity, spaceId: space.id };
}

/** The live `main` tip for the space's bare repo (null when never pushed). */
async function liveMainTip(spaceSlug: string): Promise<string | null> {
  const space = await getSpaceBySlug(spaceSlug);
  if (!space) return null;
  const owner = await db.query.users.findFirst({ where: eq(users.id, space.ownerUserId) });
  const ownerSlug = ownerSlugForUser(owner ?? null, space.ownerUserId);
  const repoPath = bareRepoPath(ownerSlug, space.slug);
  try {
    return await refTip(repoPath, DEFAULT_BRANCH);
  } catch {
    return null; // repo absent — a never-pushed space.
  }
}

/** Map a web-author failure reason to an HTTP response. forbidden ⇒ uniform
 * 404; stale/conflict ⇒ 409; everything else ⇒ 500. */
function failResponse(reason: string, detail?: string): NextResponse {
  if (reason === "unknown-space" || reason === "forbidden") return notFound();
  if (reason === "stale") {
    return err(409, "This space changed while you were editing — reload and reapply your change.");
  }
  if (reason === "conflict") {
    return err(409, detail ?? "Could not apply the change cleanly.");
  }
  return err(500, detail ?? "Could not save.");
}

// ── POST: create-new-doc | upload ────────────────────────────────────────────

export async function POST(req: Request, { params }: RouteContext) {
  const { slug } = await params;
  const g = await gate(req, slug);
  if (g instanceof NextResponse) return g;

  const contentType = req.headers.get("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    return handleUpload(req, g);
  }
  return handleNewDoc(req, g);
}

async function handleNewDoc(req: Request, g: Resolved): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err(400, "Invalid JSON body");
  }
  const b = body as Record<string, unknown>;

  if (typeof b.content !== "string") return err(400, "Missing or invalid content");
  if (b.content.length > MAX_CONTENT_CHARS) {
    return err(413, `Content exceeds the ${MAX_CONTENT_CHARS}-character limit`);
  }
  const title = typeof b.title === "string" ? b.title.trim() : "";

  // Folder path (optional) — validated against the path alphabet.
  const folder = b.path !== undefined ? normalizePath(b.path) : "";
  if (folder === null) return err(400, "Invalid path");

  // Filename slug: from an explicit slug-y title, else "untitled".
  const baseName = slugFromFilename(title || "untitled") || "untitled";
  const repoPath = folder ? `${folder}/${baseName}.md` : `${baseName}.md`;
  if (!isSafeRepoPath(repoPath)) return err(400, "Invalid document path");

  // Uniqueness against the PROJECTION KEY: at most one live doc per (space,
  // source path). Identity is now the opaque slug, so this must key on the path,
  // not a path-derived slug.
  const existing = await getLiveDocBySpacePath(g.spaceId, repoPath);
  if (existing) {
    return err(409, `A document already exists at that path (${repoPath})`);
  }

  // Prepend an H1 title when the content lacks one (so the projection has a title).
  const content =
    title && !/^#[ \t]+/m.test(b.content) ? `# ${title}\n\n${b.content}` : b.content;

  const baseMainTip = await liveMainTip(g.spaceSlug);
  const result = await webAuthorCommit(g.spaceSlug, {
    role: g.role,
    identity: g.identity,
    writes: [{ path: repoPath, bytes: Buffer.from(content, "utf8") }],
    baseMainTip,
    message: `web: create ${repoPath}`,
  });

  if (!result.ok) return failResponse(result.reason, result.detail);
  // The real opaque slug is minted by the indexer on the main-commit reindex.
  // A proposal write hasn't projected a doc yet → no slug to return.
  const projected =
    result.target === "main" ? await getLiveDocBySpacePath(g.spaceId, repoPath) : null;
  return NextResponse.json(
    {
      ok: true,
      target: result.target,
      ref: result.ref,
      slug: projected?.slug ?? null,
      path: repoPath,
      newSha: result.newSha,
      proposalName: result.proposalName,
    },
    { status: 200 },
  );
}

async function handleUpload(req: Request, g: Resolved): Promise<NextResponse> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return err(400, "Invalid multipart body");
  }
  const file = form.get("file");
  if (!(file instanceof File)) return err(400, "Missing file");
  if (file.size > MAX_UPLOAD_BYTES) {
    return err(413, `File exceeds the ${MAX_UPLOAD_BYTES}-byte limit`);
  }

  const rawFolder = form.get("path");
  const folder = rawFolder != null ? normalizePath(String(rawFolder)) : "";
  if (folder === null) return err(400, "Invalid path");

  // Derive a safe filename: slugify the stem, keep the original extension.
  const dot = file.name.lastIndexOf(".");
  const ext = dot > 0 ? file.name.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, "") : "";
  const stem = slugFromFilename(file.name) || "file";
  const filename = ext ? `${stem}.${ext}` : stem;
  const repoPath = folder ? `${folder}/${filename}` : filename;
  if (!isSafeRepoPath(repoPath)) return err(400, "Invalid upload path");

  const bytes = Buffer.from(await file.arrayBuffer());

  const baseMainTip = await liveMainTip(g.spaceSlug);
  const result = await webAuthorCommit(g.spaceSlug, {
    role: g.role,
    identity: g.identity,
    writes: [{ path: repoPath, bytes }],
    baseMainTip,
    message: `web: upload ${repoPath}`,
  });

  if (!result.ok) return failResponse(result.reason, result.detail);
  return NextResponse.json(
    {
      ok: true,
      target: result.target,
      ref: result.ref,
      path: repoPath,
      newSha: result.newSha,
      proposalName: result.proposalName,
    },
    { status: 200 },
  );
}

// ── PUT: edit an existing doc ────────────────────────────────────────────────

export async function PUT(req: Request, { params }: RouteContext) {
  const { slug } = await params;
  const g = await gate(req, slug);
  if (g instanceof NextResponse) return g;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err(400, "Invalid JSON body");
  }
  const b = body as Record<string, unknown>;

  if (typeof b.slug !== "string" || b.slug.length === 0) {
    return err(400, "Missing or invalid slug");
  }
  if (typeof b.content !== "string") return err(400, "Missing or invalid content");
  if (b.content.length > MAX_CONTENT_CHARS) {
    return err(413, `Content exceeds the ${MAX_CONTENT_CHARS}-character limit`);
  }

  // Resolve the doc's repo path from the projection. The doc MUST belong to THIS
  // space (a cross-space slug would otherwise write the wrong repo).
  const found = await getDocBySlug(b.slug, { includeUnpublished: true });
  if (!found || found.doc.spaceId !== g.spaceId) return err(404, "Document not found");
  const repoPath = found.doc.sourcePath;
  if (!isSafeRepoPath(repoPath)) return err(400, "Document has an unsafe source path");

  // CAS base: the commit the editor loaded (docs.currentCommit at load), passed
  // back as baseCommit. Fall back to the doc's recorded currentCommit. A moved
  // main since ⇒ stale.
  const baseCommit =
    typeof b.baseCommit === "string" && b.baseCommit.length > 0
      ? b.baseCommit
      : found.doc.currentCommit;

  const result = await webAuthorCommit(g.spaceSlug, {
    role: g.role,
    identity: g.identity,
    writes: [{ path: repoPath, bytes: Buffer.from(b.content, "utf8") }],
    baseMainTip: baseCommit ?? null,
    message: `web: edit ${repoPath}`,
  });

  if (!result.ok) return failResponse(result.reason, result.detail);
  return NextResponse.json(
    {
      ok: true,
      target: result.target,
      ref: result.ref,
      slug: b.slug,
      path: repoPath,
      newSha: result.newSha,
      proposalName: result.proposalName,
    },
    { status: 200 },
  );
}
