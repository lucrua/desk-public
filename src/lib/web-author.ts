/**
 * Web-author service (Web-author, Slice W1/W2) — orchestrates a browser SAVE
 * into one git commit on a space's bare repo. Ties the fresh-commit primitive
 * (lib/git/web-commit.ts) to: the space row, the push-policy decision
 * (re-applied OFF-transport), the projection reindex, and the event log. The
 * REST route calls THIS; this resolves the on-disk repo path, computes the
 * target ref (honoring push_policy, FAIL-CLOSED), performs the commit, and (for
 * a `main` commit) reindexes so the doc projects immediately.
 *
 * AUTH BOUNDARY (the part this module DOES own): the space-WRITE boundary. The
 * pre-receive hook that enforces push_policy on the git transport does NOT run
 * for a server-side commit, so this module re-applies `refUpdateAllowed(policy,
 * role, ref)` in TypeScript and fails closed — a role that may not write the
 * computed ref yields `forbidden`, which the route maps to a UNIFORM 404 (no
 * existence leak). The route still gates membership/visibility first; this is
 * the ref-level half. (READ boundary is the route's job, mirroring page.tsx.)
 */
import { db } from "@/db";
import { users, docs } from "@/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { isStaff, type Principal } from "@/lib/auth";
import {
  getSpaceBySlug,
  listSpaceMembers,
  ownerSlugForUser,
  type SpaceRole,
  type SpaceRow,
} from "@/lib/spaces";
import { resolvePrincipalUserId } from "@/lib/principal-user";
import {
  bareRepoPath,
  initBareRepo,
  refTip,
  listTree,
  repoExists,
  DEFAULT_BRANCH,
} from "@/lib/git/repo";
import {
  refUpdateAllowed,
  proposalRef,
  isValidProposalName,
  HOSTED_BRANCH,
} from "@/lib/git/push-policy";
import { commitFilesToRef, type FileWrite } from "@/lib/git/web-commit";
import { reindexSpaceByDisk } from "@/lib/git/indexer";
import { emitEvent } from "@/lib/events";

/** Identity for a web commit: author = the principal, committer = Desk (kept
 * distinct, architecture §13.2). */
export type WebAuthorIdentity = {
  /** The principal's display name (commit author name). */
  name: string;
  /** The principal's email, or a derived stable address when absent. */
  email: string;
  /** The `<handle>` for a proposal ref (tokenName / email-local). */
  handle: string;
};

export type WebCommitRequest = {
  /** The acting principal's resolved space role (owner | writer | reader). */
  role: SpaceRole;
  identity: WebAuthorIdentity;
  /** Files to create/overwrite (binary-safe). */
  writes: FileWrite[];
  /** Repo-relative paths to delete (optional). */
  deletes?: string[];
  /**
   * The expected current tip of `main` the caller built on — the editor's
   * `baseCommit` (from `docs.currentCommit`) for an edit, or the live `main`
   * tip for a create/upload. Drives the CAS so a moved main is caught. `null`
   * means "main has no commits yet" (a never-pushed space).
   */
  baseMainTip: string | null;
  message: string;
};

export type WebCommitResult =
  | {
      ok: true;
      /** Where the commit landed. */
      target: "main" | "proposal";
      ref: string;
      newSha: string;
      /** The proposal handle when target === "proposal". */
      proposalName?: string;
      /** docs upserted by the reindex (0 for a proposal write — main untouched). */
      reindexed: number;
    }
  | {
      ok: false;
      // forbidden ⇒ route maps to a uniform 404 (ref-level write boundary).
      reason: "unknown-space" | "forbidden" | "stale" | "conflict" | "error";
      detail?: string;
    };

/** Resolve the on-disk bare-repo path for a space row (mirrors proposals-service). */
async function repoPathForSpace(space: SpaceRow): Promise<string> {
  const owner = await db.query.users.findFirst({ where: eq(users.id, space.ownerUserId) });
  const ownerSlug = ownerSlugForUser(owner ?? null, space.ownerUserId);
  return bareRepoPath(ownerSlug, space.slug);
}

/**
 * The live `main` tip for a space's bare repo (null when the space was never
 * pushed / has no repo on disk yet). The CAS base a web/agent commit builds on.
 * Non-throwing — an absent repo resolves to null (a first commit).
 */
export async function liveMainTip(spaceSlug: string): Promise<string | null> {
  const space = await getSpaceBySlug(spaceSlug);
  if (!space) return null;
  const repoPath = await repoPathForSpace(space);
  try {
    return await refTip(repoPath, DEFAULT_BRANCH);
  } catch {
    return null; // repo absent — a never-pushed space.
  }
}

/**
 * The write access a principal has on a space, for a server-side commit that
 * BYPASSES the git transport (MCP `publish_doc`, `POST /api/docs`, the
 * space-scoped web-author route). Resolves the caller's SPACE ROLE + commit
 * IDENTITY the same way the space page + git transport do, FAIL-CLOSED:
 *   - a non-staff (anonymous) principal → forbidden;
 *   - an unknown space slug → unknown-space (callers map to a uniform 404/error);
 *   - a non-admin, non-member of the space → forbidden;
 *   - admin OR the space owner → role `owner` (unrestricted); else the
 *     membership role (writer/reader — a reader is rejected downstream by
 *     `targetRefFor`).
 *
 * This is ONLY the read/existence + role resolution; the ref-level write
 * boundary (push-policy) is re-applied inside `webAuthorCommit` (`targetRefFor`).
 */
export type WebAuthorAccess =
  | { ok: true; role: SpaceRole; identity: WebAuthorIdentity; spaceId: number; spaceSlug: string }
  | { ok: false; reason: "forbidden" | "unknown-space" };

export async function resolveWebAuthorAccess(
  principal: Principal,
  spaceSlug: string,
): Promise<WebAuthorAccess> {
  if (!isStaff(principal)) return { ok: false, reason: "forbidden" };
  const space = await getSpaceBySlug(spaceSlug);
  if (!space) return { ok: false, reason: "unknown-space" };

  const members = (await listSpaceMembers(spaceSlug)) ?? [];
  const myUserId = await resolvePrincipalUserId(principal);
  const myMembership =
    myUserId != null ? members.find((m) => m.userId === myUserId) : undefined;
  const isAdmin = principal.kind === "admin";

  // READ boundary: an admin sees any space; a non-admin must be a member.
  if (!isAdmin && !myMembership) return { ok: false, reason: "forbidden" };

  // WRITE role: admin + the space owner act as `owner` (unrestricted); otherwise
  // the membership role. A reader resolves to a role webAuthorCommit won't let
  // write (forbidden downstream).
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

  return { ok: true, role, identity, spaceId: space.id, spaceSlug };
}

export type SpaceFileEntry = {
  /** Repo-relative POSIX path. */
  path: string;
  /** True iff this file projects to a rendered doc (markdown/HTML). */
  isDoc: boolean;
  /**
   * The projected doc's OPAQUE slug (the stable id), for a doc-type file that is
   * currently a live/published projection. Undefined for non-doc files and for
   * doc-type files that aren't (yet) a live doc. Identity is this slug — NEVER
   * re-derive it from the path (that was the old collision-prone scheme).
   */
  docSlug?: string;
};

/**
 * List EVERY committed file in a space's `main` tree (the full git tree, not
 * just the projected docs). Doc-type files (markdown/HTML) carry isDoc=true and,
 * when live, their real projected slug so the UI can link them to their rendered
 * page; everything else (uploads) links to the raw route. Returns [] for a
 * never-pushed space. Pure read — the CALLER gates who may see the space (same
 * read boundary as the space page).
 */
export async function listSpaceFiles(spaceSlug: string): Promise<SpaceFileEntry[]> {
  const space = await getSpaceBySlug(spaceSlug);
  if (!space) return [];
  const repoPath = await repoPathForSpace(space);
  if (!(await repoExists(repoPath))) return [];
  const tip = await refTip(repoPath, DEFAULT_BRANCH);
  if (!tip) return [];
  const tree = await listTree(repoPath, tip);
  const { isDocPath } = await import("@/lib/git/indexer");
  // Resolve each committed doc-file to its REAL projected slug by (space, path).
  // Non-doc files and unprojected/unpublished paths carry no slug and fall back
  // to the raw route in the UI.
  const projected = await db
    .select({ sourcePath: docs.sourcePath, slug: docs.slug })
    .from(docs)
    .where(
      and(eq(docs.spaceId, space.id), isNull(docs.deletedAt), isNull(docs.unpublishedAt)),
    );
  const slugByPath = new Map(projected.map((d) => [d.sourcePath, d.slug]));
  return tree
    .map((e) => ({
      path: e.path,
      isDoc: isDocPath(e.path),
      docSlug: slugByPath.get(e.path),
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Compute the target ref for a (policy, role) under web-author, re-applying the
 * push-policy decision off-transport. Owner/admin → `main`. A non-owner writer
 * under `proposal` policy → `proposals/<handle>`. Anything `refUpdateAllowed`
 * rejects → null (the route fails closed to a uniform 404).
 *
 * Returns the ref plus whether it is the hosted branch (so the caller knows to
 * reindex) and the proposal handle when applicable.
 */
export function targetRefFor(
  policy: SpaceRow["pushPolicy"],
  role: SpaceRole,
  handle: string,
): { ref: string; target: "main" | "proposal"; proposalName?: string } | null {
  const pol = (policy ?? "direct") as "direct" | "proposal";
  // FAIL-CLOSED, web-specific: ONLY owner + writer may ever write. A reader (or
  // any unknown role) is rejected up front. This is the gate the git transport
  // does FOR `refUpdateAllowed` (a reader never reaches the pre-receive hook) —
  // but the web path has no such pre-filter, so `refUpdateAllowed("direct",
  // "reader", main)` would wrongly return true. We must reject readers HERE.
  if (role !== "owner" && role !== "writer") return null;
  // Owner (and admin, which resolves to owner-or-management upstream) writes main.
  // A writer under direct policy also writes main; under proposal policy a writer
  // is routed to proposals/<handle>.
  if (role === "owner" || pol === "direct") {
    const ref = `refs/heads/${HOSTED_BRANCH}`;
    return refUpdateAllowed(pol, role, ref) ? { ref, target: "main" } : null;
  }
  // Non-owner writer under proposal policy → a proposal ref.
  if (role === "writer") {
    const name = sanitizeHandle(handle);
    if (!isValidProposalName(name)) return null;
    const ref = proposalRef(name);
    return refUpdateAllowed(pol, role, ref)
      ? { ref, target: "proposal", proposalName: name }
      : null;
  }
  // reader (or anything else) — never writes.
  return null;
}

/** Coerce a raw handle (tokenName / email-local) into a valid proposal name
 * segment. Lowercases, replaces non-alphanumerics with '-', strips edges. */
function sanitizeHandle(raw: string): string {
  const s = (raw || "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s.length > 0 ? s : "web";
}

/**
 * Perform a web-author commit. The route has already gated MEMBERSHIP +
 * VISIBILITY (the read/existence boundary); this applies the REF-level write
 * boundary (push-policy) and does the git work + projection.
 */
export async function webAuthorCommit(
  spaceSlug: string,
  req: WebCommitRequest,
): Promise<WebCommitResult> {
  const space = await getSpaceBySlug(spaceSlug);
  if (!space) return { ok: false, reason: "unknown-space" };

  const target = targetRefFor(space.pushPolicy, req.role, req.identity.handle);
  if (!target) return { ok: false, reason: "forbidden" };

  const repoPath = await repoPathForSpace(space);
  // A never-pushed space has no bare repo on disk yet — create it (idempotent),
  // installing the policy hook, so the web write has somewhere to land.
  await initBareRepo(repoPath);

  // The live main tip is the base every web commit builds on. For a proposal
  // ref the worktree still bases on main's tip (the proposal forks main), but
  // the CAS is on the proposal ref (create-only ⇒ expectedTip null).
  const liveMainTip = await refTip(repoPath, DEFAULT_BRANCH);

  let expectedTip: string | null;
  let baseCommit: string | null;
  if (target.target === "main") {
    // Edit/create/upload to main: CAS on main. The caller's baseMainTip is the
    // editor's loaded commit (an edit) or the live tip (a create) — either way,
    // if main moved since, the CAS rejects as stale.
    expectedTip = req.baseMainTip;
    baseCommit = req.baseMainTip;
  } else {
    // New proposal ref off main's current tip; the ref must not exist yet.
    const existing = await refTip(repoPath, target.ref);
    expectedTip = existing; // CAS: append to an existing proposal, else create.
    baseCommit = existing ?? liveMainTip;
  }

  const commit = await commitFilesToRef(repoPath, {
    ref: target.ref,
    expectedTip,
    baseCommit,
    writes: req.writes,
    deletes: req.deletes,
    author: { name: req.identity.name, email: req.identity.email },
    committer: { name: "Desk", email: "desk@localhost" },
    message: req.message,
  });

  if (!commit.ok) {
    return { ok: false, reason: commit.reason, detail: commit.detail };
  }

  // Reindex only when main moved (a proposal write does NOT touch the rendered
  // projection — main is unchanged). A reindex failure must NOT undo the commit
  // (canon is in git; the projection is rebuildable) — log and continue.
  let reindexed = 0;
  if (target.target === "main") {
    try {
      const r = await reindexSpaceByDisk(spaceSlug, repoPath, {
        fromSha: expectedTip,
        toSha: commit.newSha,
        actorName: req.identity.name,
      });
      reindexed = r.indexed;
    } catch (e) {
      console.error("[web-author] reindex after commit failed:", (e as Error)?.message);
    }
  }

  await emitEvent(db, {
    kind: target.target === "main" ? "doc.web_committed" : "proposal.opened",
    payload: {
      slug: space.slug,
      ref: target.ref,
      newSha: commit.newSha,
      ...(target.proposalName ? { name: target.proposalName } : {}),
      paths: req.writes.map((w) => w.path),
    },
    actorName: req.identity.name,
  });

  return {
    ok: true,
    target: target.target,
    ref: target.ref,
    newSha: commit.newSha,
    proposalName: target.proposalName,
    reindexed,
  };
}
