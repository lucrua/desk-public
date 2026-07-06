/**
 * Convergence fix-pass, Slice 3 — Tier-1 anonymous "suggest an edit" converges
 * on git truth. Proves the END-TO-END loop the boundary route tests don't:
 *
 *   - a share visitor's suggestion (via POST /api/s/[token]/suggest) queues as a
 *     `revision` carrying the FORCED proposer_label + share_id;
 *   - ACCEPTING it produces a REAL git commit on `main` (verified in a fresh
 *     `git clone`, not just Postgres) authored by the PROPOSER (the share label,
 *     not the reviewer), and the projection updates to the suggested content;
 *   - REJECTING it changes nothing — no commit, no new version, clone intact;
 *   - a share visitor reaches NO staff surface (no principal escalation).
 *
 * Skipped when the host has no usable `git` (mirrors the Slice-2 e2e suite).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resetDb, seedUser, createShareOk } from "@/test/db";
import { HAVE_GIT, useTempDataDir, clearSpaceRepos, readFileFromClone } from "@/test/git";
import { createSpace, ownerSlugForUser } from "@/lib/spaces";
import { bareRepoPath } from "@/lib/git/repo";
import { getDocBySlug, listVersions } from "@/lib/docs";
import { docIdForSlug } from "@/lib/comments";
import {
  listRevisions,
  getRevision,
  acceptRevision,
  rejectRevision,
} from "@/lib/revisions";
import { setShareEdits } from "@/lib/shares";
import { shareSuggestLimiter } from "@/lib/rate-limit";
import type { Principal } from "@/lib/auth";
import { TOOLS, type ToolDef } from "@/lib/mcp/tools";
import { POST as suggestPost } from "@/app/api/s/[token]/suggest/route";

const run = promisify(execFile);
const admin: Principal = { kind: "admin", name: "Admin" };
const SPACE = "proof";

function tool(name: string): ToolDef {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}
async function runTool(name: string, principal: Principal, args: Record<string, unknown> = {}) {
  return tool(name).handler(principal, args as never);
}

const suggestReq = (token: string, body: unknown) =>
  new Request(`http://test/api/s/${token}/suggest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const ctx = (token: string) => ({ params: Promise.resolve({ token }) });

/** Clone the bare repo and read the HEAD commit's author name — proves the
 *  commit author is the PROPOSER (share label), not the reviewer. */
async function cloneHeadAuthor(repoPath: string): Promise<string | null> {
  const clone = await mkdtemp(path.join(tmpdir(), "desk-clone-author-"));
  try {
    await run("git", ["clone", "--quiet", repoPath, clone], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    const { stdout } = await run("git", ["-C", clone, "log", "-1", "--format=%an"]);
    return stdout.trim();
  } catch {
    return null;
  } finally {
    await rm(clone, { recursive: true, force: true });
  }
}

describe.skipIf(!HAVE_GIT)("Slice 3 — share suggest-edit → git-truth accept", () => {
  let restore: () => Promise<void>;

  beforeAll(async () => {
    ({ restore } = await useTempDataDir());
  });
  afterAll(async () => {
    await restore();
  });

  let ownerSlug: string;
  beforeEach(async () => {
    await resetDb();
    await clearSpaceRepos();
    shareSuggestLimiter.reset();
    const ownerUserId = await seedUser({ tokenName: "lucas", displayName: "Lucas", role: "admin" });
    const created = await createSpace(SPACE, ownerUserId, "private", "t");
    if (!created.ok) throw new Error(created.error);
    ownerSlug = ownerSlugForUser({ tokenName: "lucas", email: null }, ownerUserId);
  });

  const repoPath = () => bareRepoPath(ownerSlug, SPACE);

  async function seedSharedDoc(pathRel: string, content: string, label = "Microsoft") {
    const pub = await runTool("publish_doc", admin, { space: SPACE, path: pathRel, content });
    const slug = (pub.structuredContent as Record<string, unknown>).slug as string;
    const share = await createShareOk(slug, label, "lucas");
    await setShareEdits(share.id, true);
    const token = share.shareUrl.split("/").pop()!;
    return { slug, shareId: share.id, token, label };
  }

  it("accepted suggestion → real commit on main (author = proposer) + projection updates", async () => {
    const { slug, shareId, token, label } = await seedSharedDoc(
      "os/guide.md",
      "# Guide\n\noriginal body\n",
    );

    // Visitor suggests via the PUBLIC route (no principal).
    const res = await suggestPost(
      suggestReq(token, { content: "# Guide\n\nSUGGESTED body\n", note: "clearer" }),
      ctx(token),
    );
    expect(res.status).toBe(201);
    const revId = (await res.json()).suggestion.id as number;

    const rev = await getRevision(revId);
    expect(rev!.proposerLabel).toBe(`link:${label}`);
    expect(rev!.shareId).toBe(shareId);
    expect(rev!.status).toBe("open");

    // Owner accepts → commit to main via the Slice-2 path.
    const acc = await acceptRevision(revId, { by: "Owner" });
    expect(acc.ok).toBe(true);

    // Projection now carries the suggested content.
    const doc = await getDocBySlug(slug, { includeUnpublished: true });
    expect(doc!.version!.content).toBe("# Guide\n\nSUGGESTED body\n");

    // Truth = git: a fresh clone shows the committed suggestion...
    expect(await readFileFromClone(repoPath(), "os/guide.md")).toBe("# Guide\n\nSUGGESTED body\n");
    // ...authored by the PROPOSER (the share label), not the accepting reviewer.
    expect(await cloneHeadAuthor(repoPath())).toBe(label);

    // The revision transitioned open → accepted.
    expect((await getRevision(revId))!.status).toBe("accepted");
  });

  it("rejected suggestion changes nothing — no commit, no new version", async () => {
    const { slug, token } = await seedSharedDoc("os/x.md", "# X\n\nv1\n");
    const before = await listVersions(slug);

    const res = await suggestPost(suggestReq(token, { content: "# X\n\nDROPPED\n" }), ctx(token));
    const revId = (await res.json()).suggestion.id as number;

    const rej = await rejectRevision(revId, { by: "Owner" });
    expect(rej.ok).toBe(true);

    // Clone + projection still show the ORIGINAL — a reject never commits.
    expect(await readFileFromClone(repoPath(), "os/x.md")).toBe("# X\n\nv1\n");
    const doc = await getDocBySlug(slug, { includeUnpublished: true });
    expect(doc!.version!.content).toBe("# X\n\nv1\n");
    expect((await listVersions(slug)).length).toBe(before.length);
    expect((await getRevision(revId))!.status).toBe("rejected");
  });

  it("a share visitor cannot reach any staff surface (no principal escalation)", async () => {
    const { slug, token } = await seedSharedDoc("os/y.md", "# Y\n\nbody\n");
    // The visitor's ONLY power is to queue a suggestion.
    const res = await suggestPost(suggestReq(token, { content: "# Y\n\nsuggested\n" }), ctx(token));
    expect(res.status).toBe(201);

    // The same token is NOT a Principal: the staff MCP tools reject an anonymous
    // caller. list_open_revisions / decide_revision / publish_doc are staff-only.
    const anon: Principal = { kind: "anonymous" };
    expect((await runTool("list_open_revisions", anon)).isError).toBe(true);
    expect((await runTool("decide_revision", anon, { id: 1, accept: true })).isError).toBe(true);
    expect((await runTool("publish_doc", anon, { space: SPACE, path: "os/z.md", content: "x" })).isError).toBe(true);

    // And the suggestion is still merely OPEN — a visitor can never accept it.
    const docId = (await docIdForSlug(slug))!;
    const open = await listRevisions(docId, { status: "open" });
    expect(open.length).toBe(1);
  });
});
