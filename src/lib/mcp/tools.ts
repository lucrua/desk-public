/**
 * MCP tool registry for Desk.
 *
 * The registry is deliberately decoupled from the transport: each tool is a
 * pure-ish handler `(principal, args) => Promise<ToolResult>` plus a zod input
 * schema and a description. `src/lib/mcp/server.ts` wires these into an
 * `McpServer`; the route owns the HTTP/JSON-RPC plumbing. Splitting it this way
 * means the authorization + behaviour of every tool is unit-testable without
 * standing up a transport.
 *
 * MCP is the AGENT surface, REST is the UI surface — deliberately NOT 1:1.
 * MCP exposes what a headless agent drives (docs, versions, events, shares +
 * distribution, comments, revisions/approvals, board cards, spaces,
 * tokens, whoami). Pure web-UI admin actions (user/email CRUD, access-request
 * triage, board-bucket lifecycle, per-share view-log/comment-toggle) are
 * REST-only and have no MCP tool. See the "MCP surface policy" note next to the
 * TOOLS registry at the bottom of this file.
 *
 * Authorization mirrors the matching REST route for each tool:
 *   - reads (list_docs, get_doc, whoami) → any staff principal; members are
 *     viewer-scoped by SPACE membership/visibility the same way GET routes do.
 *   - mutations + share management (publish_doc, unpublish_doc, create_share,
 *     list_shares, revoke_share) → admin only (a doc's owner may also publish
 *     versions to / decide revisions on their own doc).
 *
 * A principal that fails the authz check gets a tool *error result*
 * (`isError: true`) rather than a thrown exception — MCP clients render that as
 * a failed tool call, which is the right UX and keeps a member's misuse from
 * crashing the request.
 */
import { z } from "zod";
import type { ZodRawShape } from "zod";
import type { Principal } from "@/lib/auth";
import { isStaff } from "@/lib/auth";
import {
  listDocs,
  searchDocs,
  getDocBySlug,
  listVersions,
  publishDoc,
  unpublishDoc,
  getVersionContent,
  setDocPath,
  setDocOwner,
  scopeForPrincipal,
} from "@/lib/docs";
import { snippetToMarkdown } from "@/app/(hub)/docs/view-model";
import { listEvents, EVENT_KINDS } from "@/lib/events";
import { normalizePath } from "@/lib/path";
import {
  createShare,
  createDirectoryShare,
  listShares,
  revokeShare,
  revealShareUrl,
  deleteShare,
  listSharesForDoc,
} from "@/lib/shares";
import { deleteDoc } from "@/lib/docs";
import {
  distributionBySpace,
  distributionByUser,
  distributionLinks,
} from "@/lib/distribution";
import {
  listComments,
  addComment,
  resolveComment,
  deleteComment,
} from "@/lib/comments";
import {
  createRevision,
  listRevisions,
  acceptRevision,
  rejectRevision,
  getRevision,
  listOpenRevisions,
} from "@/lib/revisions";
import { db } from "@/db";
import { docs } from "@/db/schema";
import { eq } from "drizzle-orm";
import { canPublishVersion, canDecideRevision } from "@/lib/permissions";
// User CRUD, access-request triage, and board-bucket lifecycle are web-UI-only
// (REST), so their service helpers are no longer imported here — see the MCP
// surface policy note at the bottom of this file.
import { listBuckets } from "@/lib/buckets";
import {
  listCards,
  getCard,
  getCardActivity,
  createCard,
  updateCard,
  moveCard,
  assignCard,
  setCardArchived,
  canEditCard,
  resolveMemberUserId,
} from "@/lib/cards";
import {
  listSpaces,
  createSpace,
  setSpaceMemberRole,
  canManageSpace,
  getSpaceBySlug,
  mintPrincipalToken,
  listTokensForUser,
  listAllTokens,
  revokePrincipalToken,
  tokenOwnerUserId,
} from "@/lib/spaces";
import { resolvePrincipalUserId } from "@/lib/principal-user";

// ── Shared result shape ────────────────────────────────────────────────────────

/**
 * A tool result in the MCP `CallToolResult` shape. We always emit a single text
 * content block (JSON-stringified payload, so non-MCP clients can still read it)
 * and a parallel `structuredContent` object for clients that prefer structured
 * output. `isError` marks authz / validation / not-found failures.
 */
export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function ok(payload: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

function fail(message: string): ToolResult {
  const payload = { error: message };
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: true,
  };
}

// Same caps / patterns the REST layer enforces (src/app/api/docs/route.ts).
import {
  SLUG_RE,
  MAX_CONTENT_CHARS,
  MAX_COMMENT_CHARS,
  MAX_REVISION_NOTE_CHARS,
} from "@/lib/limits";

// ── Tool definition type ───────────────────────────────────────────────────────

/**
 * One MCP tool. `inputSchema` is a zod raw shape (the SDK's `registerTool`
 * accepts a raw shape and builds the JSON schema). `handler` receives the
 * resolved principal (closure-injected by the server) plus the validated args.
 */
export type ToolDef<Shape extends ZodRawShape = ZodRawShape> = {
  name: string;
  description: string;
  inputSchema: Shape;
  handler: (principal: Principal, args: z.infer<z.ZodObject<Shape>>) => Promise<ToolResult>;
};

// Helper to declare a tool while preserving the precise arg type.
function defineTool<Shape extends ZodRawShape>(def: ToolDef<Shape>): ToolDef<Shape> {
  return def;
}

// ── Authz guards (mirror the REST routes) ──────────────────────────────────────

const ADMIN_ONLY = "Forbidden — admin only";
const STAFF_ONLY = "Forbidden — staff only";

// ── Tools ──────────────────────────────────────────────────────────────────────

const listDocsTool = defineTool({
  name: "list_docs",
  description:
    "List published docs visible to the caller. Admins see every doc (including unpublished); members see only docs in spaces they can see (member-of, or public/unlisted). Optional `q` runs a full-text search over title + current-version content (ranked, title matches first) — each row then carries a `snippet` (matched terms wrapped in **bold**) and `rank`. Optional `path_prefix` restricts to a folder and its descendants (e.g. 'os' matches docs at path 'os' and 'os/canon').",
  inputSchema: {
    q: z
      .string()
      .optional()
      .describe("Full-text search over title + current-version content (ranked)."),
    path_prefix: z
      .string()
      .optional()
      .describe("Folder-path prefix — matches the folder itself and its descendants."),
  },
  handler: async (principal, args) => {
    if (!isStaff(principal)) return fail(STAFF_ONLY);
    let pathPrefix: string | undefined;
    if (args.path_prefix !== undefined && args.path_prefix.trim().length > 0) {
      const np = normalizePath(args.path_prefix);
      if (np === null) {
        return fail("Invalid path_prefix — segments must match ^[a-z0-9][a-z0-9-]*$, max depth 6");
      }
      pathPrefix = np;
    }
    // `q` switches to full-text search (ranked + snippet); snippets are
    // delimiter-encoded, re-encoded to **bold** here (never raw HTML).
    const q = args.q?.trim();
    if (q && q.length > 0) {
      const results = await searchDocs(q, {
        includeUnpublished: principal.kind === "admin",
        scope: await scopeForPrincipal(principal),
        ...(pathPrefix !== undefined ? { path: pathPrefix } : {}),
      });
      const docs = results.map((d) => ({ ...d, snippet: snippetToMarkdown(d.snippet) }));
      return ok({ docs });
    }
    const docs = await listDocs({
      includeUnpublished: principal.kind === "admin",
      scope: await scopeForPrincipal(principal),
      ...(pathPrefix !== undefined ? { path: pathPrefix } : {}),
    });
    return ok({ docs });
  },
});

const searchDocsTool = defineTool({
  name: "search_docs",
  description:
    "Full-text search over docs (staff only, space-scoped exactly like list_docs). Matches the query against each doc's title (weighted highest) and current-version content, ranked by relevance. Returns the matching docs newest-relevance-first, each with a `snippet` (the matched passage, with matched terms wrapped in **bold**) and a numeric `rank`. Members only see docs in spaces they can see; admins also see unpublished docs. An empty query returns no results. Snippets are plain text (matched terms bolded) — never raw HTML, safe to render as-is.",
  inputSchema: {
    q: z.string().describe("The full-text query (websearch syntax: bare words, \"quoted phrases\", -exclusions)."),
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Max results to return (default all matches; applied after ranking)."),
  },
  handler: async (principal, args) => {
    if (!isStaff(principal)) return fail(STAFF_ONLY);
    const q = args.q?.trim();
    if (!q || q.length === 0) return ok({ docs: [] });
    const results = await searchDocs(q, {
      includeUnpublished: principal.kind === "admin",
      scope: await scopeForPrincipal(principal),
    });
    const limited =
      args.limit !== undefined ? results.slice(0, args.limit) : results;
    const docs = limited.map((d) => ({ ...d, snippet: snippetToMarkdown(d.snippet) }));
    return ok({ docs });
  },
});

const getDocTool = defineTool({
  name: "get_doc",
  description:
    "Fetch one doc by slug: its metadata, current version content, and the full version list. Viewer-scoped like list_docs — members only see docs in spaces they can see; an out-of-scope or missing slug returns a not-found error (no existence signal leaks).",
  inputSchema: {
    slug: z.string().describe("The doc slug."),
  },
  handler: async (principal, args) => {
    if (!isStaff(principal)) return fail(STAFF_ONLY);
    const includeUnpublished = principal.kind === "admin";
    const result = await getDocBySlug(args.slug, {
      includeUnpublished,
      scope: await scopeForPrincipal(principal),
    });
    if (!result) return fail(`Doc '${args.slug}' not found`);
    const versions = await listVersions(args.slug);
    return ok({
      doc: result.doc,
      currentVersion: result.version,
      versions,
    });
  },
});

const publishDocTool = defineTool({
  name: "publish_doc",
  description:
    "Publish (create or update) a doc. CREATING a new slug is admin-only. UPDATING an existing slug: admin OR the doc's owner (direct publish, no approval). Same validations as POST /api/docs: slug must match ^[a-z0-9][a-z0-9-]*$, format is 'md' or 'html', and content is capped at 2,000,000 chars. `audience` is OPTIONAL and VESTIGIAL — read access is space-scoped now, so the value is stored unread; omit it to default to `private`. Identical content to the current version is a no-op (mutable fields still update). Returns the slug, versionId, whether a new version was created, and the hub URL.",
  inputSchema: {
    slug: z.string().describe("Doc slug (^[a-z0-9][a-z0-9-]*$)."),
    title: z.string().describe("Human-readable title."),
    source_path: z.string().describe("Source path the doc was published from."),
    audience: z
      .string()
      .optional()
      .describe("Audience key — vestigial (stored unread). Omit to default to `private`."),
    format: z.enum(["md", "html"]).describe("Content format."),
    content: z.string().describe("Doc body (md or html)."),
    path: z
      .string()
      .optional()
      .describe(
        "Optional folder path (slash-joined segments ^[a-z0-9][a-z0-9-]*$, max depth 6; '' = root). On a new doc it sets the folder; on an existing doc it updates it. Omit to leave unchanged.",
      ),
    base_version_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Optimistic-concurrency base. If given and it isn't the doc's current version, the publish is rejected as a conflict (no version appended). Omit for the default append-anyway behaviour.",
      ),
  },
  handler: async (principal, args) => {
    if (!isStaff(principal)) return fail(STAFF_ONLY);

    if (!SLUG_RE.test(args.slug)) {
      return fail("Missing or invalid slug (must match ^[a-z0-9][a-z0-9-]*$)");
    }
    if (args.title.length === 0) return fail("Missing title");
    if (args.source_path.length === 0) return fail("Missing sourcePath");
    // Audience optional (Audiences v2): absent/empty → `private`.
    const audienceKey =
      args.audience !== undefined && args.audience.trim().length > 0
        ? args.audience.trim()
        : "private";
    if (args.content.length === 0) return fail("Missing content");
    if (args.content.length > MAX_CONTENT_CHARS) {
      return fail(
        `Content too large (${args.content.length} chars; max ${MAX_CONTENT_CHARS})`,
      );
    }
    let normalizedPath: string | undefined;
    if (args.path !== undefined) {
      const np = normalizePath(args.path);
      if (np === null) {
        return fail("Invalid path — segments must match ^[a-z0-9][a-z0-9-]*$, max depth 6");
      }
      normalizedPath = np;
    }
    // Audience is VESTIGIAL under Gen-2 (read access is space-scoped); the value
    // is passed through unread and no longer validated against the dormant
    // `audiences` table.

    // Permission check: is the slug an existing doc or a new one?
    const existingDoc = await getDocBySlug(args.slug, {
      includeUnpublished: true,
      scope: { viewer: "admin" }, // load unconditionally for ownership check
    });

    if (existingDoc === null) {
      // Creating a new doc — admin only.
      if (principal.kind !== "admin") return fail("Forbidden — creating a new doc is admin only");
    } else {
      // Updating an existing doc — admin OR owner.
      if (!canPublishVersion(principal, existingDoc.doc)) {
        return fail("Forbidden — only the doc owner or an admin may publish new versions");
      }
    }

    const result = await publishDoc({
      slug: args.slug,
      title: args.title,
      sourcePath: args.source_path,
      audience: audienceKey,
      format: args.format,
      content: args.content,
      by: principal.name,
      ...(normalizedPath !== undefined ? { path: normalizedPath } : {}),
      ...(args.base_version_id !== undefined ? { baseVersionId: args.base_version_id } : {}),
      // On create, set the owner to the calling user (if userId is available).
      ...(existingDoc === null && principal.userId !== undefined ? { ownerUserId: principal.userId } : {}),
    });

    if (!result.ok) {
      return fail(
        `Version conflict — current version is ${result.currentVersionId} (hash ${result.currentContentHash}); re-base and retry`,
      );
    }

    const hubUrl = `${process.env.HUB_BASE_URL ?? "http://localhost:3000"}/docs/${args.slug}`;

    return ok({
      slug: result.slug,
      versionId: result.versionId,
      isNewVersion: result.isNewVersion,
      ownerUserId: result.ownerUserId,
      hubUrl,
    });
  },
});

const updateDocTool = defineTool({
  name: "update_doc",
  description:
    "Update a doc's mutable metadata WITHOUT publishing a new version (admin only). One consolidated tool for the doc's organizational fields — pass any combination of:\n" +
    "  • `path` — move the doc to a folder (slash-joined segments ^[a-z0-9][a-z0-9-]*$, max depth 6; '' = root). Organizational only — identity stays the slug, visibility unchanged. Emits doc.moved.\n" +
    "  • `owner_user_id` — reassign the owner (must be an active users-row id). The owner may publish new versions directly and decide revisions on their doc. Emits doc.owner_changed.\n" +
    "To change a doc's CONTENT, use publish_doc (or propose_revision). At least one field must be supplied. An unknown slug, or an inactive owner, returns a not-found / invalid error.",
  inputSchema: {
    slug: z.string().describe("The doc slug to update."),
    path: z
      .string()
      .optional()
      .describe("Destination folder path ('' = root). Omit to leave the folder unchanged."),
    owner_user_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("New owner's users-row id (active). Omit to leave the owner unchanged."),
  },
  handler: async (principal, args) => {
    if (principal.kind !== "admin") return fail(ADMIN_ONLY);
    if (args.path === undefined && args.owner_user_id === undefined) {
      return fail("Nothing to update — provide at least one of path, owner_user_id");
    }

    let movedPath: string | undefined;
    if (args.path !== undefined) {
      const np = normalizePath(args.path);
      if (np === null) {
        return fail("Invalid path — segments must match ^[a-z0-9][a-z0-9-]*$, max depth 6");
      }
      const result = await setDocPath(args.slug, np, principal.name);
      if (result === "not-found") return fail(`Doc '${args.slug}' not found`);
      movedPath = np;
    }

    if (args.owner_user_id !== undefined) {
      const result = await setDocOwner(args.slug, args.owner_user_id, principal.name);
      if (result === "not-found") return fail(`Doc '${args.slug}' not found`);
      if (result === "invalid-user") {
        return fail(`User ${args.owner_user_id} does not exist or is inactive`);
      }
    }

    return ok({
      ok: true,
      slug: args.slug,
      ...(movedPath !== undefined ? { path: movedPath } : {}),
      ...(args.owner_user_id !== undefined ? { ownerUserId: args.owner_user_id } : {}),
    });
  },
});

const unpublishDocTool = defineTool({
  name: "unpublish_doc",
  description:
    "Unpublish a doc by slug (admin only). The doc + its versions are retained; it stops resolving on the hub and via existing shares. Returns a not-found error if the slug is unknown.",
  inputSchema: {
    slug: z.string().describe("The doc slug to unpublish."),
  },
  handler: async (principal, args) => {
    if (principal.kind !== "admin") return fail(ADMIN_ONLY);
    const done = await unpublishDoc(args.slug);
    if (!done) return fail(`Doc '${args.slug}' not found`);
    return ok({ ok: true, slug: args.slug });
  },
});

const createShareTool = defineTool({
  name: "create_share",
  description:
    "Mint a capability-link share for a doc (admin only). Returns the one-time share URL — the raw token appears exactly once and is never recoverable afterward. `expires_in_days`: omit = 7 days; 0 or null = never; positive number = that many days. `label` is optional — auto-named from the doc title when omitted. Returns a not-found error if the doc slug is unknown.",
  inputSchema: {
    doc_slug: z.string().describe("Slug of the doc to share."),
    label: z.string().optional().describe("Optional human label for the share (e.g. the recipient). Auto-named from the doc title when omitted."),
    expires_in_days: z
      .number()
      .nonnegative()
      .optional()
      .describe("Days until expiry: omit = 7 days; 0 = never; positive number = that many days."),
    pinned_version_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Optional version id to pin the link to (must belong to this doc). Omit for a LIVE link that always shows the doc's current version.",
      ),
  },
  handler: async (principal, args) => {
    if (principal.kind !== "admin") return fail(ADMIN_ONLY);

    // 0 means "never expire" → pass null; otherwise pass as-is (undefined = 7d default)
    const expiresInDays = args.expires_in_days === 0 ? null : args.expires_in_days;

    const result = await createShare(
      args.doc_slug,
      args.label,
      principal.name,
      expiresInDays,
      args.pinned_version_id,
    );
    if (!result.ok) {
      if (result.error === "doc-not-found") return fail(`Doc '${args.doc_slug}' not found`);
      return fail("pinned_version_id does not belong to this doc");
    }

    return ok({
      id: result.id,
      label: result.label,
      shareUrl: result.shareUrl,
    });
  },
});

const createDirectoryShareTool = defineTool({
  name: "create_directory_share",
  description:
    "Mint a capability-link DIRECTORY share for a whole folder (admin only). One URL exposes every PUBLISHED doc under `path_prefix` (the prefix or any descendant — boundary-safe, so 'finance' does not cover 'financial/'); newly-published docs under it appear automatically and one revoke kills the lot. Audience is bypassed by design. The ROOT prefix is NOT allowed — a non-empty folder path is required. Returns the one-time share URL (the raw token appears exactly once). `expires_in_days`: omit = 7 days; 0 or null = never; positive = that many days. `label` optional — auto-named from folder path when omitted.",
  inputSchema: {
    path_prefix: z
      .string()
      .describe("Non-empty folder path to share (e.g. 'finance' or 'os/canon'). Root ('') is disallowed."),
    label: z.string().optional().describe("Optional human label for the share (e.g. the recipient). Auto-named from folder path when omitted."),
    expires_in_days: z
      .number()
      .nonnegative()
      .optional()
      .describe("Days until expiry: omit = 7 days; 0 = never; positive number = that many days."),
    allow_comments: z
      .boolean()
      .optional()
      .describe("Whether link visitors may comment on docs opened through this folder link (default true)."),
  },
  handler: async (principal, args) => {
    if (principal.kind !== "admin") return fail(ADMIN_ONLY);

    // 0 means "never expire" → pass null; otherwise pass as-is (undefined = 7d default)
    const expiresInDays = args.expires_in_days === 0 ? null : args.expires_in_days;

    const result = await createDirectoryShare(
      args.path_prefix,
      args.label,
      principal.name,
      expiresInDays,
      args.allow_comments ?? true,
    );
    if (!result.ok) {
      return fail("Invalid folder — a non-empty, valid folder path is required (root is not allowed).");
    }

    return ok({
      id: result.id,
      label: result.label,
      shareUrl: result.shareUrl,
      mode: "directory",
    });
  },
});

const listSharesTool = defineTool({
  name: "list_shares",
  description:
    "List every share (doc + directory) with aggregate view stats (view count, last-viewed timestamp, expiry, revocation state). Each row carries `mode` ('doc' | 'directory'): doc shares have `docSlug`; directory shares have `pathPrefix`. Admin only.",
  inputSchema: {},
  handler: async (principal) => {
    if (principal.kind !== "admin") return fail(ADMIN_ONLY);
    const shares = await listShares();
    return ok({ shares });
  },
});

const revokeShareTool = defineTool({
  name: "revoke_share",
  description:
    "Revoke a share by its numeric id (admin only). Returns a not-found error if the id is unknown or the share was already revoked.",
  inputSchema: {
    id: z.number().int().describe("Numeric share id to revoke."),
  },
  handler: async (principal, args) => {
    if (principal.kind !== "admin") return fail(ADMIN_ONLY);
    const done = await revokeShare(args.id);
    if (!done) return fail(`Share ${args.id} not found or already revoked`);
    return ok({ ok: true, id: args.id });
  },
});

const listCommentsTool = defineTool({
  name: "list_comments",
  description:
    "List the comment thread on a doc by slug (staff only, viewer-scoped exactly like get_doc — a member only sees docs in spaces they can see; an out-of-scope or missing slug returns a not-found error). Returns the full thread including resolved comments, oldest-first. Comment bodies are markdown; authorName / authorKind are data — render as plain text.",
  inputSchema: {
    slug: z.string().describe("The doc slug."),
  },
  handler: async (principal, args) => {
    if (!isStaff(principal)) return fail(STAFF_ONLY);
    const result = await getDocBySlug(args.slug, {
      includeUnpublished: principal.kind === "admin",
      scope: await scopeForPrincipal(principal),
    });
    if (!result) return fail(`Doc '${args.slug}' not found`);
    const comments = await listComments(result.doc.id, { includeResolved: true });
    return ok({ comments });
  },
});

const addCommentTool = defineTool({
  name: "add_comment",
  description:
    "Add a comment to a doc by slug (staff only, viewer-scoped like list_comments). The author is taken from the calling principal (never client-supplied); the comment is anchored to the doc's current published version. Body is markdown, trimmed, capped at 10,000 chars — an empty (after trim) or oversize body is rejected. Returns the created comment.",
  inputSchema: {
    slug: z.string().describe("The doc slug."),
    body: z.string().describe("Comment body (markdown, ≤10,000 chars)."),
  },
  handler: async (principal, args) => {
    if (!isStaff(principal)) return fail(STAFF_ONLY);
    const result = await getDocBySlug(args.slug, {
      includeUnpublished: principal.kind === "admin",
      scope: await scopeForPrincipal(principal),
    });
    if (!result) return fail(`Doc '${args.slug}' not found`);
    if (result.version === null) {
      return fail("Doc has no published version to comment on");
    }
    if (args.body.length > MAX_COMMENT_CHARS) {
      return fail(`Comment too long (max ${MAX_COMMENT_CHARS} chars)`);
    }
    const created = await addComment({
      docId: result.doc.id,
      versionId: result.version.id,
      authorName: principal.name,
      authorKind: principal.kind,
      body: args.body,
    });
    if (created === null) {
      return fail("Comment body is empty or too long after trimming");
    }
    return ok({ comment: created });
  },
});

const whoamiTool = defineTool({
  name: "whoami",
  description:
    "Return the resolved principal for the calling credentials (kind, name, and masked email/tokenName). The 'is my service token wired right' debugging tool. Staff only.",
  inputSchema: {},
  handler: async (principal) => {
    if (!isStaff(principal)) return fail(STAFF_ONLY);
    return ok({
      kind: principal.kind,
      name: principal.name,
      email: maskContact(principal.email),
      tokenName: maskContact(principal.tokenName),
    });
  },
});

/**
 * Mask a contact string for the debugging tool: keep the first character and
 * the domain (for emails) so the operator can recognise it without exposing the
 * full value over the MCP channel. Returns null when absent.
 */
function maskContact(value: string | undefined): string | null {
  if (!value) return null;
  const at = value.indexOf("@");
  if (at > 0) {
    const local = value.slice(0, at);
    const domain = value.slice(at);
    const head = local.slice(0, 1);
    return `${head}${"*".repeat(Math.max(1, local.length - 1))}${domain}`;
  }
  if (value.length <= 2) return `${value.slice(0, 1)}*`;
  return `${value.slice(0, 1)}${"*".repeat(value.length - 2)}${value.slice(-1)}`;
}

// ── Spaces (document-host Phase 1) ──────────────────────────────────────────────
// Both-channels parity with the REST surface under /api/spaces. A SPACE is the
// owned, access-controlled git repo Desk hosts (the WRITE boundary). Reads are
// staff-scoped (admins see all, members see theirs); mutations are admin-only.

const listSpacesTool = defineTool({
  name: "list_spaces",
  description:
    "List spaces visible to the caller (document-host). Admins see every space; members see only spaces they belong to. Each row carries slug, ownerUserId, visibility, memberCount, createdAt. Mirrors GET /api/spaces. Staff only.",
  inputSchema: {},
  handler: async (principal) => {
    if (!isStaff(principal)) return fail(STAFF_ONLY);
    const isAdmin = principal.kind === "admin";
    const userId = isAdmin ? null : await resolveMemberUserId(principal);
    const spaces = await listSpaces({ isAdmin, userId });
    return ok({ spaces });
  },
});

const createSpaceTool = defineTool({
  name: "create_space",
  description:
    "Create a space — an owned, access-controlled git repo Desk hosts (admin only). Mirrors POST /api/spaces: slug must match ^[a-z0-9][a-z0-9-]*$ and be unique; visibility is private|unlisted|public (default private); owner_user_id defaults to the calling admin. The owner is added as an `owner` member. A duplicate slug returns an error result.",
  inputSchema: {
    slug: z.string().describe("Space slug (^[a-z0-9][a-z0-9-]*$)."),
    visibility: z
      .enum(["private", "unlisted", "public"])
      .optional()
      .describe("Listing visibility (default private). Governs DISCOVERY only — never the git ACL."),
    owner_user_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Owner users.id (defaults to the calling admin)."),
  },
  handler: async (principal, args) => {
    if (principal.kind !== "admin") return fail(ADMIN_ONLY);
    const ownerUserId = args.owner_user_id ?? (await resolvePrincipalUserId(principal));
    if (ownerUserId == null) return fail("Cannot resolve an owner for the space");
    const out = await createSpace(
      args.slug.trim(),
      ownerUserId,
      args.visibility ?? "private",
      principal.name,
    );
    if (!out.ok) return fail(out.error);
    return ok({
      space: {
        slug: out.space.slug,
        visibility: out.space.visibility,
        ownerUserId: out.space.ownerUserId,
      },
    });
  },
});

const setSpaceMemberTool = defineTool({
  name: "set_space_member",
  description:
    "Set or remove a user's role on a space (admin or the space owner). Mirrors POST /api/spaces/[slug]/members: role 'writer'|'reader' upserts the membership; role null removes it. The space owner cannot be demoted/removed here. An unknown space returns an error result. Emits space.member_added / space.member_removed.",
  inputSchema: {
    slug: z.string().describe("Space slug."),
    user_id: z.number().int().positive().describe("Target users.id."),
    role: z
      .enum(["writer", "reader"])
      .nullable()
      .describe("New role ('writer'|'reader'), or null to remove the membership."),
  },
  handler: async (principal, args) => {
    if (!isStaff(principal)) return fail(STAFF_ONLY);
    const space = await getSpaceBySlug(args.slug);
    if (!space) return fail("Unknown space");
    if (!(await canManageSpace(principal, space))) return fail(ADMIN_ONLY);
    const out = await setSpaceMemberRole(args.slug, args.user_id, args.role, principal.name);
    if (!out.ok) return fail(out.error);
    return ok({ ok: true, role: out.role });
  },
});

// ── Principal tokens (document-host Phase 2) ────────────────────────────────────
// The git Basic-auth credential, self-serve. Parity with /api/tokens. A token is
// always scoped to the CALLER's user; a member touches only their own, an admin
// may list-all / revoke-any. The RAW token is returned exactly once (mint).

const createTokenTool = defineTool({
  name: "create_token",
  description:
    "Mint a principal token for the CALLER's user — the credential a git client sends as its HTTP Basic password to push/clone a space over /api/git/<owner>/<space>.git. Returns the RAW token EXACTLY ONCE (only its hash is stored; it is never re-shown). Mirrors POST /api/tokens. Staff only.",
  inputSchema: {
    label: z.string().describe("Human-facing name for the token (e.g. 'laptop', 'CI agent')."),
  },
  handler: async (principal, args) => {
    if (!isStaff(principal)) return fail(STAFF_ONLY);
    const label = args.label.trim();
    if (label.length === 0) return fail("Missing or invalid label");
    const userId = await resolvePrincipalUserId(principal);
    if (userId == null) return fail("Cannot resolve your user identity");
    const minted = await mintPrincipalToken(userId, label);
    return ok({ id: minted.id, label: minted.label, token: minted.token });
  },
});

// The documented safe token projection — drops the internal `ownerUserId`,
// matching GET /api/tokens. Never the raw token or hash (those never leave the
// service layer at all).
function tokenWire(t: {
  id: number;
  label: string;
  lastUsedAt: Date | null;
  createdAt: Date;
  revokedAt: Date | null;
}) {
  return {
    id: t.id,
    label: t.label,
    lastUsedAt: t.lastUsedAt,
    createdAt: t.createdAt,
    revokedAt: t.revokedAt,
  };
}

const listTokensTool = defineTool({
  name: "list_tokens",
  description:
    "List the CALLER's principal tokens (id, label, lastUsedAt, createdAt, revokedAt — NEVER the raw token, hash, or ownerUserId), newest-first. With all=true an admin lists every user's tokens. Mirrors GET /api/tokens. Staff only.",
  inputSchema: {
    all: z
      .boolean()
      .optional()
      .describe("Admin-only: list every user's tokens instead of just your own."),
  },
  handler: async (principal, args) => {
    if (!isStaff(principal)) return fail(STAFF_ONLY);
    if (args.all) {
      if (principal.kind !== "admin") return fail("Listing all tokens is admin only");
      return ok({ tokens: (await listAllTokens()).map(tokenWire) });
    }
    const userId = await resolvePrincipalUserId(principal);
    if (userId == null) return fail("Cannot resolve your user identity");
    return ok({ tokens: (await listTokensForUser(userId)).map(tokenWire) });
  },
});

const revokeTokenTool = defineTool({
  name: "revoke_token",
  description:
    "Revoke a principal token by id. A member may revoke only their OWN token; an admin may revoke any. An unknown or not-owned token returns a not-found error (no existence leak). Mirrors DELETE /api/tokens/[id]. Staff only.",
  inputSchema: {
    id: z.number().int().positive().describe("The token id to revoke."),
  },
  handler: async (principal, args) => {
    if (!isStaff(principal)) return fail(STAFF_ONLY);
    const owner = await tokenOwnerUserId(args.id);
    if (owner == null) return fail("Not found");
    if (principal.kind !== "admin") {
      const me = await resolvePrincipalUserId(principal);
      if (me == null || me !== owner) return fail("Not found");
    }
    await revokePrincipalToken(args.id);
    return ok({ ok: true });
  },
});

// ── Admin: user management ──────────────────────────────────────────────────────
// REMOVED from the MCP surface in the Slice-1.5 (D8) interface audit: user CRUD,
// multi-email management, and access-request triage are pure web-UI admin actions
// a headless agent does not drive. They remain available over REST (the Users /
// admin pages) — see /api/users/** and /api/access-requests/**. MCP keeps only the
// surfaces an agent actually drives (docs, spaces, tokens, revisions, shares,
// board cards, events).

// ── Admin: share management ──────────────────────────────────────────────────────

const listDocSharesTool = defineTool({
  name: "list_doc_shares",
  description:
    "List every share for one doc (by slug) with aggregate view stats, newest-first (admin only). Mirrors GET /api/docs/[slug]/shares: an unknown slug returns a uniform not-found error (no 'no shares vs no doc' disambiguation). Admins resolve unpublished docs too, so links stay manageable after an unpublish.",
  inputSchema: {
    slug: z.string().describe("The doc slug."),
  },
  handler: async (principal, args) => {
    if (principal.kind !== "admin") return fail(ADMIN_ONLY);
    const result = await getDocBySlug(args.slug, {
      includeUnpublished: true,
      scope: { viewer: "admin" },
    });
    if (!result) return fail(`Doc '${args.slug}' not found`);
    const shares = await listSharesForDoc(args.slug);
    return ok({ shares });
  },
});

// ── Admin: link retrieval, stage-2 delete, distribution ──────────────────────

const revealShareTool = defineTool({
  name: "reveal_share",
  description:
    "Reveal the full share URL for an existing share by numeric id (admin only). Decrypts the stored token to reconstruct the IDENTICAL URL that was returned at creation time. Returns null / not-found when: the share is unknown, stage-2 deleted, was created before encryption was deployed (no token_enc), or the DESK_TOKEN_KEY env var is unset/changed. The link's live/revoked state is NOT checked — an admin may still want to see a revoked link's URL.",
  inputSchema: {
    id: z.number().int().describe("Numeric share id."),
  },
  handler: async (principal, args) => {
    if (principal.kind !== "admin") return fail(ADMIN_ONLY);
    const url = await revealShareUrl(args.id);
    if (url === null) {
      return fail(`Share ${args.id} not found or link cannot be revealed (pre-migration share or key unset)`);
    }
    return ok({ url });
  },
});

const deleteShareTool = defineTool({
  name: "delete_share",
  description:
    "Stage-2 delete a share link by its numeric id (admin only). Distinct from revoke_share (stage 1). Sets deleted_at (and revoked_at if not already set — delete implies the link is dead). The row is KEPT (share_views / comments FK it — hard-DELETE is forbidden). Idempotent. After delete the link 404s AND the share is excluded from all list views. An unknown id returns an error result.",
  inputSchema: {
    id: z.number().int().describe("Numeric share id to permanently delete."),
  },
  handler: async (principal, args) => {
    if (principal.kind !== "admin") return fail(ADMIN_ONLY);
    const done = await deleteShare(args.id);
    if (!done) return fail(`Share ${args.id} not found`);
    return ok({ ok: true, id: args.id });
  },
});

const deleteDocTool = defineTool({
  name: "delete_doc",
  description:
    "Stage-2 complete deletion of a doc by slug (admin only). DESTRUCTIVE AND TERMINAL — not the reversible unpublish_doc (stage 1). In one transaction: sets docs.deleted_at; purges all version content (content = '' — rows kept for FK integrity); stage-2 deletes every share link for this doc; frees the slug for reuse (partial-unique index). Emits doc.deleted. Returns a not-found error if the slug is unknown or already deleted.",
  inputSchema: {
    slug: z.string().describe("The doc slug to delete permanently."),
  },
  handler: async (principal, args) => {
    if (principal.kind !== "admin") return fail(ADMIN_ONLY);
    const done = await deleteDoc(args.slug, principal.name);
    if (!done) return fail(`Doc '${args.slug}' not found`);
    return ok({ ok: true, slug: args.slug });
  },
});

const distributionOverviewTool = defineTool({
  name: "distribution_overview",
  description:
    "Return the full distribution overview (admin only) in three lenses: bySpace (per-space: visibility + member list + the docs in it), byUser (per-active-user: which spaces they can see + visible-doc count), and links (all live share links — doc + directory — with status and canCopy flag). All three exclude deleted docs. Use this to audit who can see what (read access is space-scoped) and which share links are active.",
  inputSchema: {},
  handler: async (principal) => {
    if (principal.kind !== "admin") return fail(ADMIN_ONLY);
    const [bySpace, byUser, links] = await Promise.all([
      distributionBySpace(),
      distributionByUser(),
      distributionLinks(),
    ]);
    return ok({ bySpace, byUser, links });
  },
});

// ── Staff: version content ──────────────────────────────────────────────────────

const getVersionTool = defineTool({
  name: "get_version",
  description:
    "Fetch the raw content of a specific version of a doc (staff only, space-scoped exactly like get_doc — a member only sees docs in spaces they can see; an out-of-scope or missing slug returns a not-found error). version_id must belong to the named doc (cross-doc access is rejected as not-found). Returns the version's content string.",
  inputSchema: {
    slug: z.string().describe("The doc slug."),
    version_id: z.number().int().describe("Numeric version id (must belong to the doc)."),
  },
  handler: async (principal, args) => {
    if (!isStaff(principal)) return fail(STAFF_ONLY);
    // Audience-scope the doc first (same as get_doc) so a member on a hidden
    // doc gets a uniform not-found and never reaches the version lookup.
    const result = await getDocBySlug(args.slug, {
      includeUnpublished: principal.kind === "admin",
      scope: await scopeForPrincipal(principal),
    });
    if (!result) return fail(`Doc '${args.slug}' not found`);
    const content = await getVersionContent(args.slug, args.version_id);
    if (content === null) {
      return fail(`Version ${args.version_id} not found for doc '${args.slug}'`);
    }
    return ok({ slug: args.slug, versionId: args.version_id, content });
  },
});

// ── Admin: comment moderation ────────────────────────────────────────────────────

const resolveCommentTool = defineTool({
  name: "resolve_comment",
  description:
    "Mark a comment resolved by numeric id (admin only). Mirrors POST /api/comments/[id]/resolve. Idempotent — re-resolving an already-resolved comment still succeeds. An unknown id returns an error result.",
  inputSchema: {
    id: z.number().int().describe("Numeric comment id."),
  },
  handler: async (principal, args) => {
    if (principal.kind !== "admin") return fail(ADMIN_ONLY);
    const done = await resolveComment(args.id);
    if (!done) return fail(`Comment ${args.id} not found`);
    return ok({ ok: true, id: args.id });
  },
});

const deleteCommentTool = defineTool({
  name: "delete_comment",
  description:
    "Hard-delete a comment by numeric id (admin only). Mirrors DELETE /api/comments/[id]. An unknown id returns an error result.",
  inputSchema: {
    id: z.number().int().describe("Numeric comment id."),
  },
  handler: async (principal, args) => {
    if (principal.kind !== "admin") return fail(ADMIN_ONLY);
    const done = await deleteComment(args.id);
    if (!done) return fail(`Comment ${args.id} not found`);
    return ok({ ok: true, id: args.id });
  },
});

// ── Editing: proposed revisions ──────────────────────────────────────────────────

const proposeRevisionTool = defineTool({
  name: "propose_revision",
  description:
    "Propose a revision to a doc by slug (staff only, viewer-scoped exactly like get_doc — a member only sees docs in spaces they can see; an out-of-scope or missing slug returns a not-found error). Markdown docs only (html docs have no editor → error). `content` is the FULL proposed doc body (markdown), capped at 2,000,000 chars; the revision is based on the doc's current version. Optional `note` (≤1,000 chars). The revision queues 'open' for an admin to accept (→ new version) or reject. Returns the created revision.",
  inputSchema: {
    slug: z.string().describe("The doc slug."),
    content: z.string().describe("Full proposed doc body (markdown, ≤2,000,000 chars)."),
    note: z.string().optional().describe("Optional note describing the change (≤1,000 chars)."),
  },
  handler: async (principal, args) => {
    if (!isStaff(principal)) return fail(STAFF_ONLY);
    const result = await getDocBySlug(args.slug, {
      includeUnpublished: principal.kind === "admin",
      scope: await scopeForPrincipal(principal),
    });
    if (!result) return fail(`Doc '${args.slug}' not found`);
    if (result.doc.format !== "md") {
      return fail("Revisions are only supported on markdown docs");
    }
    if (result.version === null) {
      return fail("Doc has no published version to propose against");
    }
    if (args.content.length === 0) return fail("Missing content");
    if (args.content.length > MAX_CONTENT_CHARS) {
      return fail(`Content too large (max ${MAX_CONTENT_CHARS} chars)`);
    }
    if (args.note !== undefined && args.note.length > MAX_REVISION_NOTE_CHARS) {
      return fail(`Note too long (max ${MAX_REVISION_NOTE_CHARS} chars)`);
    }
    const created = await createRevision({
      slug: args.slug,
      authorName: principal.name,
      authorKind: principal.kind,
      scope: await scopeForPrincipal(principal),
      content: args.content,
      note: args.note,
    });
    if (created === null) {
      return fail("Revision content or note is invalid");
    }
    return ok({ revision: created });
  },
});

const listRevisionsTool = defineTool({
  name: "list_revisions",
  description:
    "List the proposed revisions on a doc by slug (staff only, viewer-scoped like get_doc). Newest-first; optional `status` filter ('open' | 'accepted' | 'rejected'). content / authorName / note are data — render as plain text.",
  inputSchema: {
    slug: z.string().describe("The doc slug."),
    status: z
      .enum(["open", "accepted", "rejected"])
      .optional()
      .describe("Optional status filter."),
  },
  handler: async (principal, args) => {
    if (!isStaff(principal)) return fail(STAFF_ONLY);
    const result = await getDocBySlug(args.slug, {
      includeUnpublished: principal.kind === "admin",
      scope: await scopeForPrincipal(principal),
    });
    if (!result) return fail(`Doc '${args.slug}' not found`);
    const revisions = await listRevisions(result.doc.id, { status: args.status });
    return ok({ revisions });
  },
});

const decideRevisionTool = defineTool({
  name: "decide_revision",
  description:
    "Decide a proposed revision by numeric `id` (admin OR the doc owner). `accept: true` publishes the revision's content as a new doc version (the doc's title / sourcePath are unchanged — only content) and marks it accepted; `accept: false` rejects it. A revision can be decided only once (already-decided → error). When accepting, the response carries `staleBase` (true if the doc moved past the revision's base version).",
  inputSchema: {
    id: z.number().int().describe("Numeric revision id."),
    accept: z.boolean().describe("true → accept (publish a new version); false → reject."),
  },
  handler: async (principal, args) => {
    if (!isStaff(principal)) return fail(STAFF_ONLY);

    // Load the revision to get docId for ownership check.
    const rev = await getRevision(args.id);
    if (!rev) return fail(`Revision ${args.id} not found`);

    // Load the doc to check ownership.
    const [docRow] = await db
      .select({ id: docs.id, ownerUserId: docs.ownerUserId })
      .from(docs)
      .where(eq(docs.id, rev.docId))
      .limit(1);
    if (!docRow) return fail(`Doc for revision ${args.id} not found`);

    if (!canDecideRevision(principal, docRow)) {
      return fail("Forbidden — only the doc owner or an admin may decide revisions");
    }

    if (args.accept) {
      const res = await acceptRevision(args.id, { by: principal.name });
      if (!res.ok) {
        if (res.reason === "not-found") return fail(`Revision ${args.id} not found`);
        return fail("Revision already decided");
      }
      return ok({
        ok: true,
        id: args.id,
        status: "accepted",
        versionId: res.versionId,
        isNewVersion: res.isNewVersion,
        staleBase: res.staleBase,
      });
    }
    const res = await rejectRevision(args.id, { by: principal.name });
    if (!res.ok) {
      if (res.reason === "not-found") return fail(`Revision ${args.id} not found`);
      return fail("Revision already decided");
    }
    return ok({ ok: true, id: args.id, status: "rejected" });
  },
});

// ── Events ───────────────────────────────────────────────────────────────────────

const listEventsTool = defineTool({
  name: "list_events",
  description:
    "Read the append-only event log (staff only). Returns events after `since` (exclusive cursor on the monotonic event id), oldest-first. Optional `kinds` filters to a subset (doc.published, doc.unpublished, doc.moved, revision.proposed, revision.decided, comment.added, user.approved). Members are space-scoped — they only receive events for docs in a space they can see, and never user.approved. Payloads carry ids/slugs/version ids only — never document content (fetch bodies via get_doc / get_version). Advance `since` to the largest id returned to page forward.",
  inputSchema: {
    since: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Exclusive lower bound on the event id cursor (default 0 = from the start)."),
    kinds: z
      .array(z.enum(EVENT_KINDS))
      .optional()
      .describe("Optional subset of event kinds to include."),
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Max events to return (default 200, max 1000)."),
  },
  handler: async (principal, args) => {
    if (!isStaff(principal)) return fail(STAFF_ONLY);
    // Same resolver as the doc read path (scopeForPrincipal) so the events feed
    // and the docs list agree on which spaces a member can see.
    const userId =
      principal.kind === "member" ? await resolvePrincipalUserId(principal) : null;
    const events = await listEvents({
      since: args.since,
      kinds: args.kinds,
      limit: args.limit,
      viewer: principal.kind,
      userId,
    });
    // The cursor to resume from = the last id in this page (or the requested
    // `since`/0 if the page was empty).
    const nextCursor = events.length > 0 ? events[events.length - 1].id : args.since ?? 0;
    return ok({ events, nextCursor });
  },
});

// ── Board: buckets ──────────────────────────────────────────────────────────────

const listBucketsTool = defineTool({
  name: "list_buckets",
  description:
    "List the board's buckets (columns) in order, each with a live card-count. Staff only. The board is an internal coordination surface (not space-scoped).",
  inputSchema: {},
  handler: async (principal) => {
    if (!isStaff(principal)) return fail(STAFF_ONLY);
    const buckets = await listBuckets();
    return ok({ buckets });
  },
});

// ── Board: cards ────────────────────────────────────────────────────────────────

const listCardsTool = defineTool({
  name: "list_cards",
  description:
    "List board cards (staff only; not space-scoped — the board is internal). Live cards only by default; pass include_archived to include archived ones. Filters: `bucket_id`, `owner_user_id`, or `owner: \"me\"` (= cards owned by the calling principal's users row; my_cards sugar). Ordered by bucket then card position.",
  inputSchema: {
    bucket_id: z.number().int().positive().optional().describe("Restrict to one bucket."),
    owner_user_id: z.number().int().positive().optional().describe("Restrict to one owner's users-row id."),
    owner: z.literal("me").optional().describe("Sugar: only cards owned by the calling principal."),
    include_archived: z.boolean().optional().describe("Include archived cards (default false)."),
  },
  handler: async (principal, args) => {
    if (!isStaff(principal)) return fail(STAFF_ONLY);
    let ownerUserId = args.owner_user_id;
    if (args.owner === "me") {
      const me = await resolveMemberUserId(principal);
      if (me == null) return ok({ cards: [] });
      ownerUserId = me;
    }
    const cards = await listCards({
      bucketId: args.bucket_id,
      ownerUserId,
      includeArchived: args.include_archived === true,
    });
    return ok({ cards });
  },
});

const getCardTool = defineTool({
  name: "get_card",
  description:
    "Get one card plus its activity trail (staff only). The trail is the card.* events for this card, oldest-first (created/moved/updated/assigned/archived). An unknown id returns an error result.",
  inputSchema: {
    id: z.number().int().positive().describe("Numeric card id."),
  },
  handler: async (principal, args) => {
    if (!isStaff(principal)) return fail(STAFF_ONLY);
    const card = await getCard(args.id);
    if (!card) return fail(`Card ${args.id} not found`);
    const activity = await getCardActivity(args.id);
    return ok({ card, activity });
  },
});

const createCardTool = defineTool({
  name: "create_card",
  description:
    "Create a board card (any staff principal — members may create). Mirrors POST /api/cards. Provide `bucket_id` or `bucket_key`; optional `body` (markdown, capped), `doc_slug`, `checklist` ([{text, done}], ≤50). A member-created card is owned by the member (so they keep edit rights); an admin may pass `owner_user_id`. Emits card.created.",
  inputSchema: {
    title: z.string().describe("Card title (non-empty)."),
    bucket_id: z.number().int().positive().optional().describe("Target bucket id."),
    bucket_key: z.string().optional().describe("Target bucket key (alternative to bucket_id)."),
    body: z.string().optional().describe("Markdown body (capped)."),
    doc_slug: z.string().optional().describe("Optional linked doc slug."),
    owner_user_id: z.number().int().positive().nullable().optional().describe("Owner users-row id (admin only; members own their own card)."),
    checklist: z.array(z.object({ text: z.string(), done: z.boolean() })).optional().describe("Checklist items (≤50)."),
  },
  handler: async (principal, args) => {
    if (!isStaff(principal)) return fail(STAFF_ONLY);
    if (args.bucket_id == null && args.bucket_key == null) {
      return fail("Provide bucket_id or bucket_key");
    }
    let ownerUserId: number | null | undefined = undefined;
    if (principal.kind === "member") {
      ownerUserId = await resolveMemberUserId(principal);
    } else if (args.owner_user_id !== undefined) {
      ownerUserId = args.owner_user_id;
    }
    const result = await createCard({
      title: args.title,
      body: args.body,
      bucketId: args.bucket_id,
      bucketKey: args.bucket_key,
      ownerUserId,
      docSlug: args.doc_slug ?? null,
      checklist: args.checklist,
      actorName: principal.name,
    });
    if (!result.ok) return fail(result.error);
    return ok({ card: result.card });
  },
});

const updateCardTool = defineTool({
  name: "update_card",
  description:
    "Update a card's title / body / doc_slug / checklist (admin OR the card owner). Mirrors PATCH /api/cards/[id] field edits. Owner reassignment is a SEPARATE tool (assign_card, admin only). A member editing a card they don't own returns an error result. Emits card.updated.",
  inputSchema: {
    id: z.number().int().positive().describe("Numeric card id."),
    title: z.string().optional(),
    body: z.string().optional(),
    doc_slug: z.string().nullable().optional().describe("Linked doc slug, or null/empty to clear."),
    checklist: z.array(z.object({ text: z.string(), done: z.boolean() })).optional(),
  },
  handler: async (principal, args) => {
    if (!isStaff(principal)) return fail(STAFF_ONLY);
    const card = await getCard(args.id);
    if (!card) return fail(`Card ${args.id} not found`);
    const memberUserId = principal.kind === "member" ? await resolveMemberUserId(principal) : null;
    if (!canEditCard(principal, card, memberUserId)) {
      return fail("Forbidden — members may only edit cards they own");
    }
    if (args.title === undefined && args.body === undefined && args.doc_slug === undefined && args.checklist === undefined) {
      return fail("Nothing to update");
    }
    const result = await updateCard(args.id, {
      title: args.title,
      body: args.body,
      docSlug: args.doc_slug,
      checklist: args.checklist,
      actorName: principal.name,
    });
    if (!result.ok) return fail(result.error);
    return ok({ card: result.card });
  },
});

const moveCardTool = defineTool({
  name: "move_card",
  description:
    "Move a card to a bucket at a slot (admin OR the card owner). Mirrors POST /api/cards/[id]/move. `index` is the 0-based slot within the bucket (omit for end). Reorder within a bucket is just a move. A member moving a card they don't own returns an error result. Emits card.moved with from/to bucket keys.",
  inputSchema: {
    id: z.number().int().positive().describe("Numeric card id."),
    bucket_id: z.number().int().positive().describe("Target bucket id."),
    index: z.number().int().nonnegative().optional().describe("0-based slot within the bucket (omit for end)."),
  },
  handler: async (principal, args) => {
    if (!isStaff(principal)) return fail(STAFF_ONLY);
    const card = await getCard(args.id);
    if (!card) return fail(`Card ${args.id} not found`);
    const memberUserId = principal.kind === "member" ? await resolveMemberUserId(principal) : null;
    if (!canEditCard(principal, card, memberUserId)) {
      return fail("Forbidden — members may only move cards they own");
    }
    const result = await moveCard(args.id, args.bucket_id, args.index ?? null, principal.name);
    if (!result.ok) return fail(result.error);
    return ok({ card: result.card });
  },
});

const assignCardTool = defineTool({
  name: "assign_card",
  description:
    "Assign (or clear) a card's owner (admin only — owner reassignment is admin-only by design). Mirrors PATCH /api/cards/[id] with ownerUserId. Pass `owner_user_id: null` to unassign. An unknown card or owner returns an error result. Emits card.assigned.",
  inputSchema: {
    id: z.number().int().positive().describe("Numeric card id."),
    owner_user_id: z.number().int().positive().nullable().describe("New owner users-row id, or null to clear."),
  },
  handler: async (principal, args) => {
    if (principal.kind !== "admin") return fail(ADMIN_ONLY);
    const result = await assignCard(args.id, args.owner_user_id, principal.name);
    if (!result.ok) return fail(result.error);
    return ok({ card: result.card });
  },
});

const archiveCardTool = defineTool({
  name: "archive_card",
  description:
    "Archive or restore a card (admin OR the card owner). Mirrors DELETE /api/cards/[id] (archive) and PATCH archived:false (restore). Pass `archived: false` to restore. A member acting on a card they don't own returns an error result. Emits card.archived.",
  inputSchema: {
    id: z.number().int().positive().describe("Numeric card id."),
    archived: z.boolean().optional().describe("true = archive (default), false = restore."),
  },
  handler: async (principal, args) => {
    if (!isStaff(principal)) return fail(STAFF_ONLY);
    const card = await getCard(args.id);
    if (!card) return fail(`Card ${args.id} not found`);
    const memberUserId = principal.kind === "member" ? await resolveMemberUserId(principal) : null;
    if (!canEditCard(principal, card, memberUserId)) {
      return fail("Forbidden — members may only archive cards they own");
    }
    const result = await setCardArchived(args.id, args.archived ?? true, principal.name);
    if (!result.ok) return fail(result.error);
    return ok({ card: result.card });
  },
});

// ── Approval queue ───────────────────────────────────────────────────────────────
// (Doc owner reassignment is folded into update_doc — see above.)

const listOpenRevisionsTool = defineTool({
  name: "list_open_revisions",
  description:
    "List ALL open revisions across every doc (the central approval queue), newest-first. Admin sees every open revision; an owner sees only revisions on docs they own; a plain member with no owned docs gets a forbidden error. Each item carries the full revision row plus docSlug, docTitle, and docOwnerUserId for queue display.",
  inputSchema: {},
  handler: async (principal) => {
    if (!isStaff(principal)) return fail(STAFF_ONLY);

    if (principal.kind === "admin") {
      const revisions = await listOpenRevisions();
      return ok({ revisions });
    }

    // Member: only own-doc revisions.
    if (principal.userId == null) {
      return fail("Forbidden — you do not own any docs");
    }
    const revisions = await listOpenRevisions({ ownerUserId: principal.userId });
    return ok({ revisions });
  },
});

// ── Registry ───────────────────────────────────────────────────────────────────

/**
 * The full tool set, in a stable order. Exported as `ToolDef<ZodRawShape>` so
 * callers can iterate uniformly; each handler keeps its precise arg type
 * internally via `defineTool`.
 */
export const TOOLS: ReadonlyArray<ToolDef> = [
  // Docs + versions — the core read/write surface an agent drives.
  listDocsTool,
  searchDocsTool,
  getDocTool,
  getVersionTool,
  publishDocTool,
  updateDocTool, // merged set_doc_path + set_doc_owner
  unpublishDocTool,
  deleteDocTool,
  // Events — the trigger feed (card.assigned etc.).
  listEventsTool,
  // Shares + distribution — outbound sharing + the "who sees what" audit.
  createShareTool,
  createDirectoryShareTool,
  listSharesTool,
  listDocSharesTool,
  revokeShareTool,
  revealShareTool,
  deleteShareTool,
  distributionOverviewTool,
  // Comments.
  listCommentsTool,
  addCommentTool,
  resolveCommentTool,
  deleteCommentTool,
  // Revisions / approvals — the propose→review→accept gate.
  proposeRevisionTool,
  listRevisionsTool,
  decideRevisionTool,
  listOpenRevisionsTool,
  // Board — cards (the agent triggers on card.assigned + drives cards); bucket
  // LIFECYCLE (create/rename/delete) is web-UI-only (REST /api/buckets).
  listBucketsTool,
  listCardsTool,
  getCardTool,
  createCardTool,
  updateCardTool,
  moveCardTool,
  assignCardTool,
  archiveCardTool,
  // Spaces — the write/clone boundary.
  listSpacesTool,
  createSpaceTool,
  setSpaceMemberTool,
  // Principal tokens — the git Basic-auth credential, self-serve.
  createTokenTool,
  listTokensTool,
  revokeTokenTool,
  // Identity / debugging.
  whoamiTool,
] as ToolDef[];

// ── MCP surface policy (Slice-1.5 / D8) ─────────────────────────────────────────
//
// MCP is the AGENT surface; REST is the UI surface. They are deliberately NOT
// 1:1. MCP exposes what a headless agent actually drives — docs (publish / get /
// list / search / update / unpublish / delete), versions, events, shares +
// distribution, comments, revisions/approvals, board cards (it triggers on
// card.assigned), spaces, and principal tokens — plus whoami.
//
// The CATALOG is no longer an MCP surface: it was reframed (Slice 2 / D6) from a
// Desk-authored registry into a READ-ONLY projection of a space directory's doc
// frontmatter (+ optional `.desk.collection.yml` schema). Its truth is the repo,
// so an agent edits it by committing frontmatter — not via a Desk catalog tool.
// The dormant `catalog_*` tables are retained (dropped in a later cleanup).
//
// Pure web-UI admin actions a headless agent does NOT drive are REST-only and
// have NO MCP tool:
//   • user CRUD + multi-email management   → /api/users/**       (Users page)
//   • access-request triage                → /api/access-requests/**
//   • board BUCKET lifecycle (create/rename/delete) → /api/buckets/**
//   • per-share view-log + comment-toggle  → /api/shares/[id]/views, PATCH /api/shares/[id]
// The audit need those served (who-can-see-what) is covered for agents by
// distribution_overview + list_shares.
//
// Over-granular single-field doc mutations (set_doc_path, set_doc_owner) were
// MERGED into one update_doc tool.

export { maskContact };
