/**
 * Proposals service (space-ID level) — ties the git-plumbing proposals layer
 * (lib/git/proposals.ts) to the space row, the projection reindex, and the event
 * log. The REST routes + MCP tools call THIS with the ALREADY-RESOLVED `spaceId`
 * (Owner-namespace S5 — never a bare slug, which is no longer unique); it loads
 * the exact space by id, resolves the on-disk repo path from its owner+slug,
 * performs the read/accept/reject, and (on accept) reindexes `main` so the merged
 * content projects immediately.
 *
 * AUTH: this module does NOT make the access decision — every entry point
 * assumes the caller already gated to the right principal (list: owner/admin or
 * the proposer-for-their-own; accept/reject: owner/admin). It is the
 * orchestration layer; the route/tool is the gate. (Same posture as
 * lib/git/repo.ts.)
 */
import { db } from "@/db";
import { getSpaceById } from "@/lib/spaces";
import { spaceRepoPath } from "@/lib/space-repo-path";
import { repoExists } from "@/lib/git/repo";
import {
  listProposals,
  getProposal,
  proposalDiff,
  acceptProposal,
  rejectProposal,
  type ProposalItem,
  type ProposalDiff,
} from "@/lib/git/proposals";
import { reindexSpaceFull } from "@/lib/git/indexer";
import { emitEvent } from "@/lib/events";
import { enqueueMirror } from "@/lib/mirror";
import { MIRRORED_WRITE_REFUSED } from "@/lib/web-author";

export type ListProposalsResult =
  | { ok: true; proposals: ProposalItem[] }
  | { ok: false; reason: "unknown-space" };

/**
 * List a space's proposals. `pusherFilter`, when set, returns only proposals
 * whose recorded pusher matches (used to scope a non-owner proposer to their
 * own). The pusher match is best-effort on the commit committer name — the
 * route additionally enforces the role gate; this is a convenience narrowing,
 * not a security boundary on its own.
 */
export async function listProposalsForSpace(
  spaceId: number,
  opts: { pusherFilter?: string } = {},
): Promise<ListProposalsResult> {
  const space = await getSpaceById(spaceId);
  if (!space) return { ok: false, reason: "unknown-space" };
  const repoPath = await spaceRepoPath(space);
  // A space whose bare repo has not been created yet (never pushed) has no
  // proposals — and spawning git in a non-existent cwd throws `spawn git
  // ENOENT`, which would crash the space detail page. Treat absent as empty.
  if (!(await repoExists(repoPath))) return { ok: true, proposals: [] };
  let proposals = await listProposals(repoPath);
  if (opts.pusherFilter != null) {
    proposals = proposals.filter((p) => p.pusher === opts.pusherFilter);
  }
  return { ok: true, proposals };
}

export type ProposalDiffResult =
  | { ok: true; diff: ProposalDiff }
  | { ok: false; reason: "unknown-space" | "not-found" };

/** The review diff for one proposal (merge-base(main, proposal)..proposal). */
export async function proposalDiffForSpace(
  spaceId: number,
  name: string,
): Promise<ProposalDiffResult> {
  const space = await getSpaceById(spaceId);
  if (!space) return { ok: false, reason: "unknown-space" };
  const repoPath = await spaceRepoPath(space);
  const diff = await proposalDiff(repoPath, name);
  if (!diff) return { ok: false, reason: "not-found" };
  return { ok: true, diff };
}

export type AcceptResult =
  | {
      ok: true;
      merged: "fast-forward" | "merge-commit";
      newMainSha: string;
      reindexed: number;
    }
  | {
      ok: false;
      reason: "unknown-space" | "not-found" | "conflict" | "error" | "mirrored";
      detail?: string;
    };

/**
 * Accept a proposal: merge → main, reindex the space, delete the proposal ref,
 * emit `proposal.accepted`. `acceptedBy` identifies the merge-commit author (for
 * a non-ff merge) + the event actor.
 */
export async function acceptProposalForSpace(
  spaceId: number,
  name: string,
  acceptedBy: { name: string; email: string },
): Promise<AcceptResult> {
  const space = await getSpaceById(spaceId);
  if (!space) return { ok: false, reason: "unknown-space" };

  // MIRRORED-MODE WRITE REFUSAL (Slice 4b). Accepting a proposal merges into
  // `main` — a Desk-originated write. A `mirrored` space's canon is GitHub, so
  // the accept is refused (the reviewer applies the change upstream instead). The
  // git transport that DELIVERS GitHub's canon stays open (it does not pass here).
  if (space.sourceMode === "mirrored") {
    return { ok: false, reason: "mirrored", detail: MIRRORED_WRITE_REFUSED };
  }

  const repoPath = await spaceRepoPath(space);

  // Confirm the proposal exists up front (so a missing one is "not-found", not a
  // git-plumbing "error").
  const existing = await getProposal(repoPath, name);
  if (!existing) return { ok: false, reason: "not-found" };

  const outcome = await acceptProposal(repoPath, name, acceptedBy);
  if (!outcome.ok) return outcome;

  // Reindex `main` from its new tip so the merged content projects. A reindex
  // failure must NOT undo the merge (the canon is already in git; the projection
  // is rebuildable) — log and continue, mirroring the push hot-path posture.
  let reindexed = 0;
  try {
    const r = await reindexSpaceFull(space.slug, repoPath, acceptedBy.name, {
      spaceId: space.id,
    });
    reindexed = r.indexed;
  } catch (e) {
    console.error("[proposals] reindex after accept failed:", (e as Error)?.message);
  }

  await emitEvent(db, {
    kind: "proposal.accepted",
    payload: {
      slug: space.slug,
      name,
      merged: outcome.merged,
      tipSha: outcome.tipSha,
      newMainSha: outcome.newMainSha,
    },
    actorName: acceptedBy.name,
  });

  // Mirror hook (Slice 4b): the merge advanced `main` → fan out to the space's
  // GitHub mirror. Fire-and-forget + fail-soft (no-op unless hosted + has a
  // remote; never throws into the accept).
  enqueueMirror(space.id);

  return { ok: true, merged: outcome.merged, newMainSha: outcome.newMainSha, reindexed };
}

export type RejectResult =
  | { ok: true }
  | { ok: false; reason: "unknown-space" | "not-found" };

/**
 * Reject a proposal: delete the ref (main untouched), emit `proposal.rejected`.
 */
export async function rejectProposalForSpace(
  spaceId: number,
  name: string,
  rejectedBy: string,
): Promise<RejectResult> {
  const space = await getSpaceById(spaceId);
  if (!space) return { ok: false, reason: "unknown-space" };
  const repoPath = await spaceRepoPath(space);
  const outcome = await rejectProposal(repoPath, name);
  if (!outcome.ok) return { ok: false, reason: "not-found" };

  await emitEvent(db, {
    kind: "proposal.rejected",
    payload: { slug: space.slug, name },
    actorName: rejectedBy,
  });

  return { ok: true };
}
