/**
 * sync-core.mjs — the pure-ish decision engine for `desk sync`.
 *
 * This is the testable heart of the sync client. It contains NO fs and NO
 * direct network I/O: callers inject a `fetchBase(versionId)` function (returns
 * the common-base content string) and a `merge(ours, base, theirs)` function
 * (returns {clean, merged}). The thin I/O shell in `desk-sync.mjs` supplies real
 * implementations (HTTP + git/diff3) and then executes the returned decision.
 *
 * Per sync-spec §3, a file's fate is decided by comparing two axes:
 *   localChanged  = sha256(local) !== entry.lastSyncedHash
 *   remoteChanged = remoteDoc.currentVersionId !== entry.lastSyncedVersionId
 *
 * Decision `action` values:
 *   noop          nothing changed on either side
 *   push          local-only change → publish with base_version_id
 *   pull          remote-only change → write cloud content locally
 *   merge-push    both changed, 3-way merge clean → publish merged w/ base check
 *   revision      both changed, merge dirty (or member token) → file local as a
 *                 proposed revision, then pull cloud HEAD locally
 *   create-local  dir mapping: a new remote doc under the prefix → create file
 *   create-remote dir mapping: a new local file under the prefix → publish it
 *
 * Each decision carries the fields the shell needs to act and the new state to
 * persist *after* the action succeeds (see `nextState`).
 */

/**
 * @typedef {Object} EntryState
 * @property {string} slug
 * @property {string} localPath
 * @property {number|null} lastSyncedVersionId
 * @property {string|null} lastSyncedHash
 *
 * @typedef {Object} RemoteDoc
 * @property {number|null} currentVersionId
 * @property {string|null} contentHash    sha256 hex of current cloud content
 * @property {string|null} content        current cloud content (when known)
 * @property {string} [format]            "md" | "html"
 *
 * @typedef {Object} Decision
 * @property {string} action
 * @property {string} slug
 * @property {string} [reason]            human-readable summary for the log
 * @property {string} [content]           content to push / write (when relevant)
 * @property {number|null} [baseVersionId] base for optimistic-concurrency push
 * @property {string} [note]              revision note (revision action)
 * @property {boolean} [pullAfter]        revision: pull cloud HEAD after filing
 * @property {Object} [nextState]         {lastSyncedVersionId, lastSyncedHash}
 *                                        to persist once the action confirms
 */

/** sha256 is injected so this module stays dependency-free and node-version
 * agnostic. The shell passes node:crypto's hash. */

/**
 * Decide the action for a single linked file.
 *
 * @param {Object} args
 * @param {EntryState} args.entry
 * @param {string|null} args.localContent   null = local file is missing
 * @param {RemoteDoc|null} args.remoteDoc   null = doc no longer exists on cloud
 * @param {(versionId:number)=>Promise<string|null>} args.fetchBase
 * @param {(ours:string, base:string, theirs:string)=>{clean:boolean, merged:string}} args.merge
 * @param {(s:string)=>string} args.hash    sha256-hex of a string
 * @param {boolean} [args.isMember]         member token → pushes are always revisions
 * @param {string} [args.hostname]          for the conflict revision note
 * @returns {Promise<Decision>}
 */
export async function decideFile(args) {
  const {
    entry,
    localContent,
    remoteDoc,
    fetchBase,
    merge,
    hash,
    isMember = false,
    hostname = "unknown-host",
  } = args;
  const slug = entry.slug;

  // ── Remote doc vanished (unpublished) ─────────────────────────────────────
  // Spec: keep the local file, drop the mapping, loud notice. Never delete
  // local data on an unpublish.
  if (remoteDoc === null || remoteDoc.currentVersionId === null) {
    return {
      action: "drop-mapping",
      slug,
      reason: `remote doc '${slug}' is no longer published — local file kept, mapping dropped`,
    };
  }

  const remoteChanged = remoteDoc.currentVersionId !== entry.lastSyncedVersionId;

  // ── Local file missing ────────────────────────────────────────────────────
  // Treat as "no local change" — let remote win (pull). We never push a deletion
  // (local-delete → unpublish is explicit-only, out of scope here).
  if (localContent === null) {
    if (remoteChanged) {
      return {
        action: "pull",
        slug,
        reason: `local file missing — writing cloud v${remoteDoc.currentVersionId}`,
        content: remoteDoc.content,
        nextState: stateFrom(remoteDoc),
      };
    }
    return { action: "noop", slug, reason: "local file missing, remote unchanged" };
  }

  const localHash = hash(localContent);
  // State-file corruption / first sync: a null base hash means we can't trust
  // "unchanged locally" — treat local as changed (safe: worst case an extra
  // revision or a base-checked push).
  const localChanged =
    entry.lastSyncedHash === null || localHash !== entry.lastSyncedHash;

  // Local already matches cloud HEAD exactly → converge state, no I/O.
  if (localHash === remoteDoc.contentHash) {
    if (
      entry.lastSyncedVersionId !== remoteDoc.currentVersionId ||
      entry.lastSyncedHash !== remoteDoc.contentHash
    ) {
      return {
        action: "noop",
        slug,
        reason: "local already equals cloud HEAD — state converged",
        nextState: stateFrom(remoteDoc),
      };
    }
    return { action: "noop", slug, reason: "in sync" };
  }

  // ── neither changed ───────────────────────────────────────────────────────
  if (!localChanged && !remoteChanged) {
    return { action: "noop", slug, reason: "in sync" };
  }

  // ── remote only ───────────────────────────────────────────────────────────
  if (!localChanged && remoteChanged) {
    return {
      action: "pull",
      slug,
      reason: `cloud advanced to v${remoteDoc.currentVersionId} — pulling`,
      content: remoteDoc.content,
      nextState: stateFrom(remoteDoc),
    };
  }

  // ── local only ────────────────────────────────────────────────────────────
  if (localChanged && !remoteChanged) {
    // Member token: pushes are ALWAYS proposed revisions (permission = conflict).
    if (isMember) {
      return revisionDecision(slug, localContent, remoteDoc, hostname, {
        reason: "member token — filing local edit as a proposed revision",
      });
    }
    return {
      action: "push",
      slug,
      reason: "local edit — publishing with base check",
      content: localContent,
      baseVersionId: entry.lastSyncedVersionId,
      nextStateOnPush: true, // shell fills nextState from the publish response
    };
  }

  // ── both changed ──────────────────────────────────────────────────────────
  // Member token short-circuits to a revision (no base-checked publish at all).
  if (isMember) {
    return revisionDecision(slug, localContent, remoteDoc, hostname, {
      reason: "member token — filing local edit as a proposed revision",
    });
  }

  // Fetch the common base (last-synced version content) for a 3-way merge.
  let baseContent = null;
  if (entry.lastSyncedVersionId !== null) {
    baseContent = await fetchBase(entry.lastSyncedVersionId);
  }
  // No retrievable base (corruption / pruned) → we cannot safely auto-merge.
  // Conservatively file a revision so nothing is lost.
  if (baseContent === null) {
    return revisionDecision(slug, localContent, remoteDoc, hostname, {
      reason: "no base content available for merge — filing a proposed revision",
    });
  }

  const { clean, merged } = merge(localContent, baseContent, remoteDoc.content);
  if (clean) {
    return {
      action: "merge-push",
      slug,
      reason: "both changed — clean 3-way merge, publishing merged",
      content: merged,
      baseVersionId: remoteDoc.currentVersionId, // base-check against cloud HEAD
      nextStateOnPush: true,
    };
  }

  // Dirty merge → proposed revision of the LOCAL content, then pull cloud HEAD.
  return revisionDecision(slug, localContent, remoteDoc, hostname, {
    reason: "both changed — merge conflict, filing local edit as a proposed revision",
  });
}

/** Build a revision decision: file local content as a proposed revision, then
 * pull cloud HEAD locally and converge state to it. */
function revisionDecision(slug, localContent, remoteDoc, hostname, extra) {
  return {
    action: "revision",
    slug,
    content: localContent,
    note: `sync conflict from ${hostname}`,
    pullAfter: true,
    pullContent: remoteDoc.content,
    nextState: stateFrom(remoteDoc),
    ...extra,
  };
}

function stateFrom(remoteDoc) {
  return {
    lastSyncedVersionId: remoteDoc.currentVersionId,
    lastSyncedHash: remoteDoc.contentHash,
  };
}

/**
 * Dir-mapping adoption decisions, decided per-name across the union of remote
 * docs under a prefix and local files in the dir. Pure: takes already-resolved
 * sets, returns the list of adoption actions to apply (the shell then runs each
 * through decideFile for already-mapped names).
 *
 * @param {Object} args
 * @param {Map<string,{slug:string, currentVersionId:number|null, content:string|null, contentHash:string|null}>} args.remoteBySlug
 * @param {Map<string,{localPath:string}>} args.localBySlug   md/html files keyed by derived slug
 * @param {Set<string>} args.mapped       slugs already in entry.files
 * @param {boolean} args.isMember
 * @returns {{adopt: Array<{action:string, slug:string, reason:string}>}}
 */
export function decideDirAdoptions(args) {
  const { remoteBySlug, localBySlug, mapped, isMember } = args;
  const adopt = [];

  // New remote docs under the prefix not yet mapped → create locally.
  for (const [slug, rd] of remoteBySlug) {
    if (mapped.has(slug)) continue;
    if (rd.currentVersionId === null) continue;
    adopt.push({
      action: "create-local",
      slug,
      reason: `new cloud doc '${slug}' under prefix — creating local file`,
    });
  }

  // New local files not yet mapped and not present remotely → publish (admin)
  // or notice (member can't create new docs; revision needs an existing doc).
  for (const [slug] of localBySlug) {
    if (mapped.has(slug)) continue;
    if (remoteBySlug.has(slug)) continue; // it's a remote we'll adopt above
    if (isMember) {
      adopt.push({
        action: "skip-new-local",
        slug,
        reason: `new local file '${slug}' — members can't create cloud docs; skipped (publish as admin)`,
      });
    } else {
      adopt.push({
        action: "create-remote",
        slug,
        reason: `new local file '${slug}' under prefix — publishing to cloud`,
      });
    }
  }

  return { adopt };
}
