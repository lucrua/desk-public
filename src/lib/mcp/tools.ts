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
 * Authorization mirrors the REST API exactly (the single source of truth being
 * the routes under `src/app/api/**`):
 *   - reads (list_docs, get_doc, list_audiences, whoami) → any staff principal;
 *     members are viewer-scoped (audience-visibility) the same way GET routes
 *     scope them.
 *   - mutations + share management (publish_doc, unpublish_doc, create_share,
 *     list_shares, revoke_share) → admin only.
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
  audienceExists,
  listAudiences,
  createAudience,
  setAudienceMemberVisible,
  deleteAudience,
  listAudienceMembers,
  addAudienceMember,
  removeAudienceMember,
} from "@/lib/audiences";
import {
  createShare,
  createDirectoryShare,
  listShares,
  revokeShare,
  revealShareUrl,
  deleteShare,
  listSharesForDoc,
  setShareComments,
  listViews,
} from "@/lib/shares";
import { deleteDoc } from "@/lib/docs";
import {
  distributionByAudience,
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
import {
  listUsers,
  createUser,
  setUserDisplayName,
  setUserTokenName,
  applyAdminMutation,
  getUserById,
  listUserEmails,
  addUserEmail,
  removeUserEmail,
  isLastAdminOperation,
} from "@/lib/users";
import {
  listAccessRequests,
  approveAccessRequest,
  dismissAccessRequest,
} from "@/lib/access-requests";
import { uaLabel } from "@/lib/ua";
import { isSelfDeactivation } from "@/app/api/users/[id]/route";
import {
  listBuckets,
  createBucket,
  renameBucket,
  deleteBucket,
} from "@/lib/buckets";
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
  listKinds,
  getSchema,
  upsertSchema,
  listItems,
  getItem,
  upsertItem,
  deleteItem,
} from "@/lib/catalogs";

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

// Mirror GET /api/shares/[id]/views — raw UA truncated to 80 chars for a tooltip.
const RAW_UA_TOOLTIP_MAX = 80;

// ── Tools ──────────────────────────────────────────────────────────────────────

const listDocsTool = defineTool({
  name: "list_docs",
  description:
    "List published docs visible to the caller. Admins see every doc (including unpublished); members see only docs whose audience is member-visible. Optional `q` runs a full-text search over title + current-version content (ranked, title matches first) — each row then carries a `snippet` (matched terms wrapped in **bold**) and `rank`. Optional `path_prefix` restricts to a folder and its descendants (e.g. 'os' matches docs at path 'os' and 'os/canon').",
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
    "Full-text search over docs (staff only, audience-scoped exactly like list_docs). Matches the query against each doc's title (weighted highest) and current-version content, ranked by relevance. Returns the matching docs newest-relevance-first, each with a `snippet` (the matched passage, with matched terms wrapped in **bold**) and a numeric `rank`. Members only see member-visible audiences; admins also see unpublished docs. An empty query returns no results. Snippets are plain text (matched terms bolded) — never raw HTML, safe to render as-is.",
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
    "Fetch one doc by slug: its metadata, current version content, and the full version list. Viewer-scoped like list_docs — members only see member-visible audiences; an out-of-scope or missing slug returns a not-found error (no existence signal leaks).",
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
    "Publish (create or update) a doc. CREATING a new slug is admin-only. UPDATING an existing slug: admin OR the doc's owner (direct publish, no approval). Same validations as POST /api/docs: slug must match ^[a-z0-9][a-z0-9-]*$, format is 'md' or 'html', and content is capped at 2,000,000 chars. `audience` is OPTIONAL — omit it to default to `private` (only the author/admins + explicitly-added members see it); when provided it must already exist (create it in /admin first). Identical content to the current version is a no-op (mutable fields still update). Returns the slug, versionId, whether a new version was created, and the hub URL.",
  inputSchema: {
    slug: z.string().describe("Doc slug (^[a-z0-9][a-z0-9-]*$)."),
    title: z.string().describe("Human-readable title."),
    source_path: z.string().describe("Source path the doc was published from."),
    audience: z
      .string()
      .optional()
      .describe("Audience key — must already exist. Omit to default to `private`."),
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
    if (!(await audienceExists(audienceKey))) {
      return fail("unknown audience — create it in /admin first");
    }

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

const setDocPathTool = defineTool({
  name: "set_doc_path",
  description:
    "Move a doc to a folder path (admin only). The path is organizational only — identity stays the slug, audience/visibility unchanged. Path: slash-joined segments ^[a-z0-9][a-z0-9-]*$, max depth 6; '' = root. Emits a doc.moved event. An unknown slug returns a not-found error.",
  inputSchema: {
    slug: z.string().describe("The doc slug to move."),
    path: z.string().describe("Destination folder path ('' = root)."),
  },
  handler: async (principal, args) => {
    if (principal.kind !== "admin") return fail(ADMIN_ONLY);
    const np = normalizePath(args.path);
    if (np === null) {
      return fail("Invalid path — segments must match ^[a-z0-9][a-z0-9-]*$, max depth 6");
    }
    const result = await setDocPath(args.slug, np, principal.name);
    if (result === "not-found") return fail(`Doc '${args.slug}' not found`);
    return ok({ ok: true, slug: args.slug, path: np, moved: result === "ok" });
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

const listAudiencesTool = defineTool({
  name: "list_audiences",
  description:
    "List all audiences (key, label, member-visibility flag, live doc-count). Staff only. Useful before publish_doc to pick a valid existing audience key.",
  inputSchema: {},
  handler: async (principal) => {
    if (!isStaff(principal)) return fail(STAFF_ONLY);
    const audiences = await listAudiences();
    return ok({ audiences });
  },
});

const listCommentsTool = defineTool({
  name: "list_comments",
  description:
    "List the comment thread on a doc by slug (staff only, viewer-scoped exactly like get_doc — a member only sees member-visible audiences; an out-of-scope or missing slug returns a not-found error). Returns the full thread including resolved comments, oldest-first. Comment bodies are markdown; authorName / authorKind are data — render as plain text.",
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

// ── Admin: user management ──────────────────────────────────────────────────────

const listUsersTool = defineTool({
  name: "list_users",
  description:
    "List all users (id, email, tokenName, displayName, role, active flag, createdAt), newest-first. Same projection as GET /api/users. Admin only.",
  inputSchema: {},
  handler: async (principal) => {
    if (principal.kind !== "admin") return fail(ADMIN_ONLY);
    const users = await listUsers();
    return ok({ users });
  },
});

const createUserTool = defineTool({
  name: "create_user",
  description:
    "Create a member user (admin only). Mirrors POST /api/users: requires a non-empty display_name and at least one identifier (email or token_name); email is normalized (trim + lowercase). A duplicate email or token_name returns an error result. Every new user is created as a member; use update_user with role:'admin' to promote them afterwards.",
  inputSchema: {
    display_name: z.string().describe("Human display name (non-empty after trim)."),
    email: z.string().optional().describe("Email — normalized to trimmed lowercase."),
    token_name: z
      .string()
      .optional()
      .describe("Service-token Client ID (common_name) to bind this user to."),
  },
  handler: async (principal, args) => {
    if (principal.kind !== "admin") return fail(ADMIN_ONLY);
    if (args.display_name.trim().length === 0) {
      return fail("Missing or invalid displayName — must be a non-empty string");
    }
    const hasIdentifier =
      (args.email != null && args.email.trim().length > 0) ||
      (args.token_name != null && args.token_name.trim().length > 0);
    if (!hasIdentifier) {
      return fail("Provide at least one of email or service-token Client ID");
    }
    const user = await createUser({
      email: args.email,
      tokenName: args.token_name,
      displayName: args.display_name.trim(),
    });
    // hasIdentifier is true here, so a null result means a duplicate.
    if (user === null) {
      return fail("A user with that email or token name already exists");
    }
    return ok({ user });
  },
});

const updateUserTool = defineTool({
  name: "update_user",
  description:
    "Update a user (admin only). Mirrors PATCH /api/users/[id] exactly: provide at least one of display_name (non-empty), token_name (string or explicit null to clear), active (boolean), or role ('admin'|'member'). email is immutable and is NOT accepted. Enforces the self-deactivation guard — an admin cannot set its own row inactive (matched by email or tokenName). Enforces the last-admin guard — the only active admin cannot be demoted or deactivated. A duplicate token_name and an unknown id return error results.",
  inputSchema: {
    id: z.number().int().describe("Numeric user id."),
    display_name: z.string().optional().describe("New display name (non-empty after trim)."),
    token_name: z
      .string()
      .nullable()
      .optional()
      .describe("New service-token Client ID; pass null to clear it."),
    active: z.boolean().optional().describe("Active flag — false deactivates the user."),
    role: z
      .enum(["admin", "member"])
      .optional()
      .describe("Role to assign. Admin-only. Guarded by the last-admin invariant."),
  },
  handler: async (principal, args) => {
    if (principal.kind !== "admin") return fail(ADMIN_ONLY);

    const hasDisplayName = args.display_name !== undefined;
    const hasTokenName = args.token_name !== undefined;
    const hasActive = args.active !== undefined;
    const hasRole = args.role !== undefined;

    if (!hasDisplayName && !hasTokenName && !hasActive && !hasRole) {
      return fail(
        "Provide at least one of: active (boolean), role ('admin'|'member'), tokenName (string|null), displayName (string)",
      );
    }
    if (hasDisplayName && args.display_name!.trim().length === 0) {
      return fail("displayName must be a non-empty string");
    }

    // Load the target so the self-lockout guard can match on identity and so an
    // unknown id 404s before any mutation (mirrors the route's ordering).
    const target = await getUserById(args.id);
    if (target === null) return fail(`User ${args.id} not found`);

    if (isSelfDeactivation(principal, target, args.active)) {
      return fail("You can't deactivate yourself — ask another admin to do it.");
    }

    // Last-admin guard for demote — fires for both self-demotion and other-demotion.
    if (hasRole && args.role === "member") {
      const lastAdmin = await isLastAdminOperation(args.id, { newRole: "member" });
      if (lastAdmin) {
        // Detect self vs other for a more helpful message.
        const pEmails = (principal.emails ?? (principal.email ? [principal.email] : [])).map(
          (e) => e.trim().toLowerCase(),
        );
        const selfMatch =
          (target.email != null && pEmails.includes(target.email.toLowerCase())) ||
          (principal.tokenName != null &&
            target.tokenName != null &&
            principal.tokenName === target.tokenName);
        if (selfMatch) {
          return fail(
            "You are the only active admin — promote another user to admin before changing your own role.",
          );
        }
        return fail(
          "Cannot demote the only active admin — promote another user to admin first.",
        );
      }
    }

    // Last-admin deactivation guard.
    if (hasActive && args.active === false) {
      const lastAdmin = await isLastAdminOperation(args.id, { activeChange: false });
      if (lastAdmin) {
        return fail(
          "Cannot deactivate the only active admin — promote another user to admin first.",
        );
      }
    }

    if (hasDisplayName) {
      await setUserDisplayName(args.id, args.display_name!);
    }
    // Apply role and/or active atomically under the admin-set advisory lock so the
    // last-admin invariant can't be raced (TOCTOU). The pre-flight guards above
    // give specific messages on the common path; this re-checks INSIDE the lock and
    // catches a mutation that only loses the invariant under a concurrent race.
    if (hasRole || hasActive) {
      const result = await applyAdminMutation(args.id, {
        newRole: hasRole ? args.role : undefined,
        active: hasActive ? args.active : undefined,
      });
      if (result === "last-admin") {
        if (args.active === false) {
          return fail(
            "Cannot deactivate the only active admin — promote another user to admin first.",
          );
        }
        // Demote path: detect self vs other for the matching message.
        const pEmails = (principal.emails ?? (principal.email ? [principal.email] : [])).map(
          (e) => e.trim().toLowerCase(),
        );
        const selfMatch =
          (target.email != null && pEmails.includes(target.email.toLowerCase())) ||
          (principal.tokenName != null &&
            target.tokenName != null &&
            principal.tokenName === target.tokenName);
        if (selfMatch) {
          return fail(
            "You are the only active admin — promote another user to admin before changing your own role.",
          );
        }
        return fail(
          "Cannot demote the only active admin — promote another user to admin first.",
        );
      }
    }
    if (hasTokenName) {
      const result = await setUserTokenName(args.id, args.token_name!);
      if (result === "duplicate") {
        return fail("tokenName already in use by another user");
      }
    }

    return ok({ ok: true, id: args.id });
  },
});

// ── Admin: user emails (multiple emails per user) ───────────────────────────────

const listUserEmailsTool = defineTool({
  name: "list_user_emails",
  description:
    "List a user's emails (id, email, primary flag, createdAt), oldest-first. Mirrors GET /api/users/[id]/emails. `primary` flags the user's display email. Admin only. An unknown id returns an error result.",
  inputSchema: {
    id: z.number().int().describe("Numeric user id."),
  },
  handler: async (principal, args) => {
    if (principal.kind !== "admin") return fail(ADMIN_ONLY);
    const emails = await listUserEmails(args.id);
    if (emails === null) return fail(`User ${args.id} not found`);
    return ok({ emails });
  },
});

const addUserEmailTool = defineTool({
  name: "add_user_email",
  description:
    "Add an email to a user (admin only). Mirrors POST /api/users/[id]/emails: the address is normalized (trim + lowercase). Login by any of a user's emails resolves the same account. A duplicate (the email already belongs to ANY user) or an unknown id returns an error result. The user's primary/display email is unchanged.",
  inputSchema: {
    id: z.number().int().describe("Numeric user id."),
    email: z.string().describe("Email to add — normalized to trimmed lowercase."),
  },
  handler: async (principal, args) => {
    if (principal.kind !== "admin") return fail(ADMIN_ONLY);
    const result = await addUserEmail(args.id, args.email, principal.name);
    if (result === "invalid") return fail("email must be a non-empty string");
    if (result === "not-found") return fail(`User ${args.id} not found`);
    if (result === "duplicate") {
      return fail("That email already belongs to a user");
    }
    return ok({ ok: true, id: args.id });
  },
});

const removeUserEmailTool = defineTool({
  name: "remove_user_email",
  description:
    "Remove an email from a user (admin only). Mirrors DELETE /api/users/[id]/emails/[email]: the address is matched normalized. Removing the last email of a user WITHOUT a service token is blocked (last-email guard) — they'd have no way to sign in; a user with a token may drop to zero emails. An unknown user/email returns an error result.",
  inputSchema: {
    id: z.number().int().describe("Numeric user id."),
    email: z.string().describe("Email to remove — matched normalized."),
  },
  handler: async (principal, args) => {
    if (principal.kind !== "admin") return fail(ADMIN_ONLY);
    const result = await removeUserEmail(args.id, args.email, principal.name);
    if (result === "not-found") return fail(`Email not found on user ${args.id}`);
    if (result === "last-email") {
      return fail(
        "Can't remove the last email of a user without a service token — they'd have no way to sign in.",
      );
    }
    return ok({ ok: true, id: args.id });
  },
});

// ── Admin: access requests ──────────────────────────────────────────────────────

const listAccessRequestsTool = defineTool({
  name: "list_access_requests",
  description:
    "List pending access requests (id, email, firstSeenAt, lastSeenAt, hits), most-recently-seen first. Mirrors GET /api/access-requests. Admin only.",
  inputSchema: {},
  handler: async (principal) => {
    if (principal.kind !== "admin") return fail(ADMIN_ONLY);
    const accessRequests = await listAccessRequests();
    return ok({ accessRequests });
  },
});

const approveAccessRequestTool = defineTool({
  name: "approve_access_request",
  description:
    "Approve a pending access request by id (admin only). DEFAULT: creates a member user from its email and clears the request; optional display_name overrides the default (capitalized email local-part). ALIAS: pass alias_of_user_id to add the request's email to an EXISTING user instead of creating an account (for a second address of the same person — aliasing onto the admin's account makes that email an admin login). An unknown request id, or an unknown alias_of_user_id, returns an error; if a user with that email already appeared meanwhile the request is still cleared and an 'already exists' error is returned.",
  inputSchema: {
    id: z.number().int().describe("Numeric access-request id."),
    display_name: z
      .string()
      .optional()
      .describe("Optional display name for the new user; defaults from the email. Ignored in alias mode."),
    alias_of_user_id: z
      .number()
      .int()
      .optional()
      .describe("If set, add the request's email to this existing user instead of creating a new account."),
  },
  handler: async (principal, args) => {
    if (principal.kind !== "admin") return fail(ADMIN_ONLY);
    const result = await approveAccessRequest(args.id, {
      displayName: args.display_name,
      aliasOfUserId: args.alias_of_user_id,
      by: principal.name,
    });
    if (result.status === "not-found") {
      return fail(`Access request ${args.id} not found`);
    }
    if (result.status === "alias-not-found") {
      return fail(`Alias target user ${args.alias_of_user_id} not found`);
    }
    if (result.status === "duplicate") {
      return fail("A user with that email already exists — request cleared");
    }
    return ok({ ok: true, userId: result.userId });
  },
});

const dismissAccessRequestTool = defineTool({
  name: "dismiss_access_request",
  description:
    "Dismiss (delete) a pending access request by id without creating a user (admin only). Mirrors DELETE /api/access-requests/[id]. An unknown id returns an error result.",
  inputSchema: {
    id: z.number().int().describe("Numeric access-request id."),
  },
  handler: async (principal, args) => {
    if (principal.kind !== "admin") return fail(ADMIN_ONLY);
    const result = await dismissAccessRequest(args.id);
    if (result === "not-found") return fail(`Access request ${args.id} not found`);
    return ok({ ok: true, id: args.id });
  },
});

// ── Admin: audience management ──────────────────────────────────────────────────

const createAudienceTool = defineTool({
  name: "create_audience",
  description:
    "Create an audience (admin only). Mirrors POST /api/audiences: key must match ^[a-z0-9][a-z0-9-]*$, label must be non-empty, member_visible defaults to false. A duplicate key returns an error result.",
  inputSchema: {
    key: z.string().describe("Audience key (^[a-z0-9][a-z0-9-]*$)."),
    label: z.string().describe("Human label (non-empty after trim)."),
    member_visible: z
      .boolean()
      .optional()
      .describe("Whether members may see docs in this audience (default false)."),
  },
  handler: async (principal, args) => {
    if (principal.kind !== "admin") return fail(ADMIN_ONLY);
    if (!SLUG_RE.test(args.key.trim())) {
      return fail("Missing or invalid key (must match ^[a-z0-9][a-z0-9-]*$)");
    }
    if (args.label.trim().length === 0) {
      return fail("Missing or invalid label — must be a non-empty string");
    }
    const audience = await createAudience({
      key: args.key,
      label: args.label,
      memberVisible: args.member_visible === true,
    });
    // Key + label validated above, so null here means a duplicate key.
    if (audience === null) {
      return fail("An audience with that key already exists");
    }
    return ok({ audience });
  },
});

const updateAudienceTool = defineTool({
  name: "update_audience",
  description:
    "Toggle an audience's member-visibility by id (admin only). Mirrors PATCH /api/audiences/[id]. An unknown id returns an error result.",
  inputSchema: {
    id: z.number().int().describe("Numeric audience id."),
    member_visible: z.boolean().describe("New member-visibility flag."),
  },
  handler: async (principal, args) => {
    if (principal.kind !== "admin") return fail(ADMIN_ONLY);
    const done = await setAudienceMemberVisible(args.id, args.member_visible);
    if (!done) return fail(`Audience ${args.id} not found`);
    return ok({ ok: true, id: args.id });
  },
});

const deleteAudienceTool = defineTool({
  name: "delete_audience",
  description:
    "Delete an audience by id (admin only). Mirrors DELETE /api/audiences/[id]: refuses (error result) if any doc still references the audience key — re-point those docs first. An unknown id returns an error result.",
  inputSchema: {
    id: z.number().int().describe("Numeric audience id."),
  },
  handler: async (principal, args) => {
    if (principal.kind !== "admin") return fail(ADMIN_ONLY);
    const result = await deleteAudience(args.id);
    if (result === "not-found") return fail(`Audience ${args.id} not found`);
    if (result === "in-use") {
      return fail("Audience is in use — re-point its docs before deleting");
    }
    return ok({ ok: true, id: args.id });
  },
});

// ── Audience membership (Audiences v2 — audiences are groups) ────────────────────

const listAudienceMembersTool = defineTool({
  name: "list_audience_members",
  description:
    "List the members of an audience by numeric id (staff). Mirrors GET /api/audiences/[id]/members. Each row carries the audience_members row id, userId, displayName, email, tokenName, and createdAt. These users see the audience's docs via membership (on top of the member_visible flag). An unknown id returns an error result.",
  inputSchema: {
    id: z.number().int().describe("Numeric audience id."),
  },
  handler: async (principal, args) => {
    if (!isStaff(principal)) return fail(STAFF_ONLY);
    const members = await listAudienceMembers(args.id);
    if (members === null) return fail(`Audience ${args.id} not found`);
    return ok({ members });
  },
});

const addAudienceMemberTool = defineTool({
  name: "add_audience_member",
  description:
    "Add a user to an audience (admin only). Mirrors POST /api/audiences/[id]/members { userId }. Makes the audience a real group: the user then sees every doc tagged with this audience. Idempotent — re-adding an existing member succeeds with added:false and emits no event. An unknown audience or user id returns an error result. Emits audience.member_added on a real insert.",
  inputSchema: {
    id: z.number().int().describe("Numeric audience id."),
    user_id: z.number().int().describe("Numeric user id to add."),
  },
  handler: async (principal, args) => {
    if (principal.kind !== "admin") return fail(ADMIN_ONLY);
    const result = await addAudienceMember(args.id, args.user_id, principal.name);
    if (!result.ok) {
      if (result.reason === "audience-not-found") {
        return fail(`Audience ${args.id} not found`);
      }
      return fail(`User ${args.user_id} not found`);
    }
    return ok({ ok: true, added: result.added, member: result.item });
  },
});

const removeAudienceMemberTool = defineTool({
  name: "remove_audience_member",
  description:
    "Remove a user from an audience (admin only). Mirrors DELETE /api/audiences/[id]/members/[userId]. The user loses visibility of the audience's docs (unless the audience is member_visible). An unknown audience id, or a user who isn't a member, returns an error result. Emits audience.member_removed on a real delete.",
  inputSchema: {
    id: z.number().int().describe("Numeric audience id."),
    user_id: z.number().int().describe("Numeric user id to remove."),
  },
  handler: async (principal, args) => {
    if (principal.kind !== "admin") return fail(ADMIN_ONLY);
    const result = await removeAudienceMember(args.id, args.user_id, principal.name);
    if (result === "audience-not-found") return fail(`Audience ${args.id} not found`);
    if (result === "not-a-member") {
      return fail(`User ${args.user_id} is not a member of audience ${args.id}`);
    }
    return ok({ ok: true, id: args.id, userId: args.user_id });
  },
});

// ── Admin: share management ──────────────────────────────────────────────────────

const setShareCommentsTool = defineTool({
  name: "set_share_comments",
  description:
    "Toggle whether link visitors may comment on a share, by numeric id (admin only). Mirrors PATCH /api/shares/[id] { allowComments }. An unknown id returns an error result.",
  inputSchema: {
    id: z.number().int().describe("Numeric share id."),
    allow: z.boolean().describe("Whether share-link visitors may comment."),
  },
  handler: async (principal, args) => {
    if (principal.kind !== "admin") return fail(ADMIN_ONLY);
    const done = await setShareComments(args.id, args.allow);
    if (!done) return fail(`Share ${args.id} not found`);
    return ok({ ok: true, id: args.id, allowComments: args.allow });
  },
});

const listShareViewsTool = defineTool({
  name: "list_share_views",
  description:
    "List the raw view log for one share by numeric id (admin only). Mirrors GET /api/shares/[id]/views: each view carries viewedAt, ip, uaLabel (coarse human label), rawUa (truncated raw UA), and docVersionId. An unknown id returns an empty list (no existence signal — same as the route). ip / rawUa are attacker-controlled — render as plain text only.",
  inputSchema: {
    id: z.number().int().describe("Numeric share id."),
  },
  handler: async (principal, args) => {
    if (principal.kind !== "admin") return fail(ADMIN_ONLY);
    const views = await listViews(args.id);
    return ok({
      views: views.map((v) => ({
        viewedAt: v.viewedAt,
        ip: v.ip,
        uaLabel: uaLabel(v.userAgent),
        rawUa: v.userAgent != null ? v.userAgent.slice(0, RAW_UA_TOOLTIP_MAX) : null,
        docVersionId: v.docVersionId,
      })),
    });
  },
});

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
    "Return the full distribution overview (admin only) in three lenses: byAudience (per-audience: member list + doc list), byUser (per-active-user: visible audiences + visible-doc count), and links (all live share links — doc + directory — with status and canCopy flag). All three exclude deleted docs. Use this to audit who can see what and which share links are active.",
  inputSchema: {},
  handler: async (principal) => {
    if (principal.kind !== "admin") return fail(ADMIN_ONLY);
    const [byAudience, byUser, links] = await Promise.all([
      distributionByAudience(),
      distributionByUser(),
      distributionLinks(),
    ]);
    return ok({ byAudience, byUser, links });
  },
});

// ── Staff: version content ──────────────────────────────────────────────────────

const getVersionTool = defineTool({
  name: "get_version",
  description:
    "Fetch the raw content of a specific version of a doc (staff only, audience-scoped exactly like get_doc — a member only sees member-visible audiences; an out-of-scope or missing slug returns a not-found error). version_id must belong to the named doc (cross-doc access is rejected as not-found). Returns the version's content string.",
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
    "Propose a revision to a doc by slug (staff only, viewer-scoped exactly like get_doc — a member only sees member-visible audiences; an out-of-scope or missing slug returns a not-found error). Markdown docs only (html docs have no editor → error). `content` is the FULL proposed doc body (markdown), capped at 2,000,000 chars; the revision is based on the doc's current version. Optional `note` (≤1,000 chars). The revision queues 'open' for an admin to accept (→ new version) or reject. Returns the created revision.",
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
    "Decide a proposed revision by numeric `id` (admin OR the doc owner). `accept: true` publishes the revision's content as a new doc version (the doc's title / audience / sourcePath are unchanged — only content) and marks it accepted; `accept: false` rejects it. A revision can be decided only once (already-decided → error). When accepting, the response carries `staleBase` (true if the doc moved past the revision's base version).",
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
    "Read the append-only event log (staff only). Returns events after `since` (exclusive cursor on the monotonic event id), oldest-first. Optional `kinds` filters to a subset (doc.published, doc.unpublished, doc.moved, revision.proposed, revision.decided, comment.added, user.approved). Members are audience-scoped — they only receive events for docs they can see, and never user.approved. Payloads carry ids/slugs/version ids only — never document content (fetch bodies via get_doc / get_version). Advance `since` to the largest id returned to page forward.",
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
    const userId =
      principal.kind === "member" ? await resolveMemberUserId(principal) : null;
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
    "List the board's buckets (columns) in order, each with a live card-count. Staff only. The board is an internal coordination surface (no audience scoping).",
  inputSchema: {},
  handler: async (principal) => {
    if (!isStaff(principal)) return fail(STAFF_ONLY);
    const buckets = await listBuckets();
    return ok({ buckets });
  },
});

const createBucketTool = defineTool({
  name: "create_bucket",
  description:
    "Create a board bucket at the end of the column order (admin only). Mirrors POST /api/buckets: `label` is required; `key` (slug ^[a-z0-9][a-z0-9-]*$) is derived from the label when omitted. A duplicate/invalid key returns an error result. Emits bucket.created.",
  inputSchema: {
    label: z.string().describe("Human label (non-empty after trim)."),
    key: z.string().optional().describe("Optional slug key; derived from label if omitted."),
  },
  handler: async (principal, args) => {
    if (principal.kind !== "admin") return fail(ADMIN_ONLY);
    if (args.label.trim().length === 0) return fail("Missing or invalid label — must be a non-empty string");
    const bucket = await createBucket({ label: args.label, key: args.key, actorName: principal.name });
    if (bucket === null) return fail("Could not create bucket — invalid or duplicate key");
    return ok({ bucket });
  },
});

const updateBucketTool = defineTool({
  name: "update_bucket",
  description:
    "Rename a board bucket by id (admin only). Mirrors PATCH /api/buckets/[id]. The key is immutable (it's referenced in event payloads); only the label changes. An unknown id returns an error result. Emits bucket.updated.",
  inputSchema: {
    id: z.number().int().describe("Numeric bucket id."),
    label: z.string().describe("New label (non-empty after trim)."),
  },
  handler: async (principal, args) => {
    if (principal.kind !== "admin") return fail(ADMIN_ONLY);
    const result = await renameBucket(args.id, args.label, principal.name);
    if (result === "not-found") return fail(`Bucket ${args.id} not found`);
    if (result === "invalid") return fail("label must be a non-empty string");
    return ok({ ok: true, id: args.id });
  },
});

const deleteBucketTool = defineTool({
  name: "delete_bucket",
  description:
    "Delete a board bucket by id (admin only). Mirrors DELETE /api/buckets/[id]: refuses (error result) when ANY card (live or archived) still references it — move or archive-restore those first. An unknown id returns an error result. Emits bucket.deleted.",
  inputSchema: {
    id: z.number().int().describe("Numeric bucket id."),
  },
  handler: async (principal, args) => {
    if (principal.kind !== "admin") return fail(ADMIN_ONLY);
    const result = await deleteBucket(args.id, principal.name);
    if (result === "not-found") return fail(`Bucket ${args.id} not found`);
    if (result === "in-use") return fail("Bucket is not empty — move or archive its cards before deleting");
    return ok({ ok: true, id: args.id });
  },
});

// ── Board: cards ────────────────────────────────────────────────────────────────

const listCardsTool = defineTool({
  name: "list_cards",
  description:
    "List board cards (staff only; not audience-scoped). Live cards only by default; pass include_archived to include archived ones. Filters: `bucket_id`, `owner_user_id`, or `owner: \"me\"` (= cards owned by the calling principal's users row; my_cards sugar). Ordered by bucket then card position.",
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

// ── Catalogs ────────────────────────────────────────────────────────────────────

const listCatalogKindsTool = defineTool({
  name: "list_catalog_kinds",
  description:
    "List every catalog kind (schema-as-data registry: finding, decision, rfc, …), each with its label, idPattern, JSON Schema, and item count. Staff only. Catalogs are an internal coordination surface (no audience scoping) — members read, only admins write.",
  inputSchema: {},
  handler: async (principal) => {
    if (!isStaff(principal)) return fail(STAFF_ONLY);
    const kinds = await listKinds();
    return ok({ kinds });
  },
});

const getCatalogSchemaTool = defineTool({
  name: "get_catalog_schema",
  description:
    "Get one catalog kind's schema (label, idPattern, JSON Schema, item count) by its kind slug (staff only). An unknown kind returns an error result.",
  inputSchema: {
    kind: z.string().describe("The kind slug (e.g. 'finding')."),
  },
  handler: async (principal, args) => {
    if (!isStaff(principal)) return fail(STAFF_ONLY);
    const schema = await getSchema(args.kind);
    if (!schema) return fail(`Kind '${args.kind}' not found`);
    return ok({ kind: schema });
  },
});

const upsertCatalogSchemaTool = defineTool({
  name: "upsert_catalog_schema",
  description:
    "Create or update a catalog kind (admin only). `kind` is a slug (^[a-z0-9][a-z0-9-]*$, immutable once created); `label` is human-facing; `id_pattern` is a regex SOURCE (e.g. 'F-\\\\d+') used both to validate item ids and to auto-link references; `schema` is a JSON Schema (object) the item `data` payload is validated against. The idPattern must compile as a regex and the schema must compile as a JSON Schema, else an error result. Additive changes apply immediately; breaking changes are flagged in the UI, not blocked here. Emits catalog.schema.created/updated.",
  inputSchema: {
    kind: z.string().describe("Kind slug (^[a-z0-9][a-z0-9-]*$)."),
    label: z.string().describe("Human label (non-empty)."),
    id_pattern: z.string().describe("Regex source for item ids (e.g. 'F-\\\\d+')."),
    schema: z.record(z.string(), z.unknown()).optional().describe("JSON Schema object for the `data` payload (default {})."),
  },
  handler: async (principal, args) => {
    if (principal.kind !== "admin") return fail(ADMIN_ONLY);
    const result = await upsertSchema({
      kind: args.kind,
      label: args.label,
      idPattern: args.id_pattern,
      schema: args.schema ?? {},
      actorName: principal.name,
    });
    if (!result.ok) return fail(result.error);
    return ok({ kind: result.value });
  },
});

const listCatalogItemsTool = defineTool({
  name: "list_catalog_items",
  description:
    "List items in a catalog kind, newest-updated first (staff only). Optional `status` (exact match) and `q` (case-insensitive substring over itemId/title — simple, not full-text). An unknown kind returns an error result.",
  inputSchema: {
    kind: z.string().describe("The kind slug."),
    status: z.string().optional().describe("Exact status filter."),
    q: z.string().optional().describe("Substring match over itemId/title."),
  },
  handler: async (principal, args) => {
    if (!isStaff(principal)) return fail(STAFF_ONLY);
    const schema = await getSchema(args.kind);
    if (!schema) return fail(`Kind '${args.kind}' not found`);
    const items = await listItems({ kind: args.kind, status: args.status, q: args.q });
    return ok({ items });
  },
});

const getCatalogItemTool = defineTool({
  name: "get_catalog_item",
  description:
    "Get one catalog item plus its outbound + inbound typed links (staff only). Links are item↔item typed edges (references / supersedes / implements / …); the inbound list shows other items that link to this one. An unknown item returns an error result.",
  inputSchema: {
    kind: z.string().describe("The kind slug."),
    item_id: z.string().describe("The human item id (e.g. 'F-012')."),
  },
  handler: async (principal, args) => {
    if (!isStaff(principal)) return fail(STAFF_ONLY);
    const result = await getItem(args.kind, args.item_id);
    if (!result) return fail(`Item '${args.item_id}' not found in '${args.kind}'`);
    return ok(result);
  },
});

const upsertCatalogItemTool = defineTool({
  name: "upsert_catalog_item",
  description:
    "Create or update a catalog item (admin only), keyed on (kind, item_id). The id is CLIENT-PROPOSED: `item_id` is validated against the kind's idPattern (rejected if it doesn't match). `data` is validated against the kind's JSON Schema (rejected with the schema error if it fails). Links are re-derived automatically by scanning body + data for other kinds' ids (and own-kind references, excluding self). Body is markdown (capped). Emits catalog.item.created/updated (payload: kind/itemId/title/status only). An unknown kind returns an error result.",
  inputSchema: {
    kind: z.string().describe("The kind slug."),
    item_id: z.string().describe("Client-proposed human id (must match the kind's idPattern)."),
    title: z.string().describe("Item title (non-empty)."),
    body: z.string().optional().describe("Markdown body (capped)."),
    status: z.string().optional().describe("Status (free-text; the schema may constrain it)."),
    data: z.record(z.string(), z.unknown()).optional().describe("Structured payload, validated against the kind's JSON Schema."),
    source_hash: z.string().optional().describe("Repo-mirror ingest cursor (idempotent re-sync)."),
  },
  handler: async (principal, args) => {
    if (principal.kind !== "admin") return fail(ADMIN_ONLY);
    const result = await upsertItem({
      kind: args.kind,
      itemId: args.item_id,
      title: args.title,
      body: args.body,
      status: args.status,
      data: args.data,
      sourceHash: args.source_hash,
      actorName: principal.name,
    });
    if (!result.ok) return fail(result.error);
    return ok({ item: result.value });
  },
});

const deleteCatalogItemTool = defineTool({
  name: "delete_catalog_item",
  description:
    "Delete a catalog item by (kind, item_id) (admin only). Cascades its links (both directions). An unknown item returns an error result. Emits catalog.item.deleted.",
  inputSchema: {
    kind: z.string().describe("The kind slug."),
    item_id: z.string().describe("The human item id to delete."),
  },
  handler: async (principal, args) => {
    if (principal.kind !== "admin") return fail(ADMIN_ONLY);
    const result = await deleteItem(args.kind, args.item_id, principal.name);
    if (!result.ok) return fail(result.error);
    return ok({ ok: true, kind: args.kind, itemId: args.item_id });
  },
});

// ── Doc ownership ───────────────────────────────────────────────────────────────

const setDocOwnerTool = defineTool({
  name: "set_doc_owner",
  description:
    "Reassign a doc's owner (admin only). The owner may publish new versions directly and decide revisions on their doc. `owner_user_id` must be an active users-row id. Emits a doc.owner_changed event. An unknown slug, inactive user, or non-admin caller returns an error result.",
  inputSchema: {
    slug: z.string().describe("The doc slug."),
    owner_user_id: z.number().int().positive().describe("The new owner's users-row id."),
  },
  handler: async (principal, args) => {
    if (principal.kind !== "admin") return fail(ADMIN_ONLY);
    const result = await setDocOwner(args.slug, args.owner_user_id, principal.name);
    if (result === "not-found") return fail(`Doc '${args.slug}' not found`);
    if (result === "invalid-user") {
      return fail(`User ${args.owner_user_id} does not exist or is inactive`);
    }
    return ok({ ok: true, slug: args.slug, ownerUserId: args.owner_user_id });
  },
});

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
  listDocsTool,
  searchDocsTool,
  getDocTool,
  getVersionTool,
  publishDocTool,
  setDocPathTool,
  unpublishDocTool,
  listEventsTool,
  createShareTool,
  createDirectoryShareTool,
  listSharesTool,
  listDocSharesTool,
  revokeShareTool,
  revealShareTool,
  deleteShareTool,
  deleteDocTool,
  distributionOverviewTool,
  setShareCommentsTool,
  listShareViewsTool,
  listCommentsTool,
  addCommentTool,
  resolveCommentTool,
  deleteCommentTool,
  proposeRevisionTool,
  listRevisionsTool,
  decideRevisionTool,
  listOpenRevisionsTool,
  setDocOwnerTool,
  listAudiencesTool,
  createAudienceTool,
  updateAudienceTool,
  deleteAudienceTool,
  listAudienceMembersTool,
  addAudienceMemberTool,
  removeAudienceMemberTool,
  listUsersTool,
  createUserTool,
  updateUserTool,
  listUserEmailsTool,
  addUserEmailTool,
  removeUserEmailTool,
  listAccessRequestsTool,
  approveAccessRequestTool,
  dismissAccessRequestTool,
  // P2 board — buckets + cards (parity with REST).
  listBucketsTool,
  createBucketTool,
  updateBucketTool,
  deleteBucketTool,
  listCardsTool,
  getCardTool,
  createCardTool,
  updateCardTool,
  moveCardTool,
  assignCardTool,
  archiveCardTool,
  // P3 catalogs — schemas + items (parity with REST).
  listCatalogKindsTool,
  getCatalogSchemaTool,
  upsertCatalogSchemaTool,
  listCatalogItemsTool,
  getCatalogItemTool,
  upsertCatalogItemTool,
  deleteCatalogItemTool,
  whoamiTool,
] as ToolDef[];

export { maskContact };
