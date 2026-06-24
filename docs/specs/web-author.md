# Desk — Web-author: create / edit / upload in the browser, every save is a commit (build spec)

> **Status: ACTIVE — building 2026-06-24.** Lets a space owner author a space entirely from the browser — new docs, edits, and file uploads — where **every web save = one git commit** into the space's bare repo (author = the user's principal, committer = Desk). Truth stays in git; Postgres stays a projection. Honors the per-space `push_policy` built in External Collaboration. AUTH-SENSITIVE (a new server-side write path that bypasses the git transport, so the access boundary must be re-applied in TypeScript). Lands in the Desk repo on `feat/web-author` (based on `feat/external-collab-e2`).
> **Model:** inherits `docs/architecture.md` (truth = files in the space's git repo; web edit → real commit, §13.2 / §13.3) and `docs/specs/external-collaboration.md` (per-space `push_policy`; `proposals/*` PRs). Reuses: the worktree+CAS mutation pattern from `acceptProposal` (`src/lib/git/proposals.ts`), `refUpdateAllowed` (`src/lib/git/push-policy.ts`), `reindexSpaceByDisk` (`src/lib/git/indexer.ts`), the space-page role-resolution pattern (`spaces/[slug]/page.tsx`).

## Use case
"I want to create a space and use it entirely from the web — dump notes, upload random files, share with people via a link." No clone, no terminal. The owner types a doc or drops a file in the browser; Desk commits it into the space's git repo and re-projects it; the owner shares it with the existing read-tiers / capability links. Because every save is a commit, the dump is fully versioned for free.

## Key facts this is built on (from the codebase map)
- **No fresh-commit-from-new-bytes primitive exists yet.** `acceptProposal` only *moves refs between commits that already exist* (`update-ref` CAS for ff; throwaway `git worktree` + `git merge` for divergent — `proposals.ts:176-255`). Web-author must **add** a sibling primitive (`commitFilesToRef`).
- **The current `/docs/[slug]/edit` flow does NOT touch git** — it writes a Postgres `doc_versions` row via `publishDoc`/`acceptRevision` (`revisions.ts:156-186`), the legacy content-store. Web-author is the **git-truth** replacement for owner edits; the DB-revision path stays only as the *suggestion* (guest propose→owner accept) surface.
- **The projection is markdown/HTML-only** (`DOC_FORMATS`, `isDocPath` — `indexer.ts:36,55`); the `docs`/`doc_versions` schema stores text, no binary column. Binary uploads are **truth in git** but do not become `docs` rows. We serve them raw instead of widening the schema.
- **push_policy is enforced only at the git transport** (the pre-receive hook). A server-side web write bypasses that hook, so the policy decision **`refUpdateAllowed(policy, role, ref)`** (`push-policy.ts:67`) must be re-applied in the web endpoint, fail-closed.

## Decisions
- **One commit per save.** Each create / edit / upload produces exactly one commit on the target ref. Author = the principal (`name` + `email ?? <derived>@desk.localhost`); committer = `Desk <desk@localhost>` (kept distinct — `architecture.md` §13.2).
- **Not a new "space type."** Web-authoring is a capability on **any** space where the actor is owner/admin (or writer, via the proposal path). A "web-only space" is just a normal space nobody clones. Keeps *one source, many doors*.
- **Honor `push_policy`, fail-closed.** Owner/admin → commit to `main`. Non-owner **writer** under `push_policy=proposal` → commit to `proposals/<handle>` (opens a PR via the existing surface). Reader / non-member / anonymous → **uniform 404**, no ref moved.
- **CAS-on-ref for concurrency.** The ref move is always `git update-ref <ref> <new> <expected-old>`. A moved tip → reject as `stale` (HTTP 409) and preserve the client's draft (no clobber). No CRDT, no auto-merge (`architecture.md` §13.3).
- **Binary uploads = truth-in-git + raw serve, not projected docs.** Markdown/HTML uploads project & render as docs (existing path). Any other file is committed and served byte-for-byte at a stable raw URL; it appears in the space's file view via the **git tree** (`listTree`), not via a schema change. No LFS / large-binary lane in this slice (deferred per `architecture.md` §"binary lane").
- **REST-only (UI surface).** Per the consolidation (MCP = agent surface, REST = UI surface), web-author adds **no MCP tools** — an agent already authors by `git push`. 

---

## Slice W1 — Owner-direct authoring (priority — Lucas's use case)

**W1.1 — Commit primitive** `src/lib/git/web-commit.ts` (NEW):
```
commitFilesToRef(repoPath, {
  ref,                       // "refs/heads/main" | "refs/heads/proposals/<handle>"
  expectedTip,               // string | null (null = ref absent / empty repo) — the CAS guard
  writes: Array<{ path: string; bytes: Buffer }>,
  deletes?: string[],
  author: { name; email }, committer: { name: "Desk"; email: "desk@localhost" },
  message,
}) => { ok: true; newSha } | { ok: false; reason: "stale" | "conflict" | "error"; detail? }
```
Mechanism (mirror `proposals.ts:222-254`): `mkdtemp` → `git worktree add -f <wt>` detached at `expectedTip` (or an empty worktree when the repo has no commits) → write/delete files in the worktree (binary-safe `fs.writeFile(Buffer)`) → `git add -A` → `git commit` with split author/committer env → **CAS** `git update-ref <ref> <newSha> <expectedTip>`; CAS failure ⇒ `stale`. Always `git worktree remove --force` + `prune` in `finally`. **Validate every `path`** against the segment/traversal guard before writing (never escape the worktree); reuse `repo.ts` path helpers. Use `runGit` (`repo.ts:66`).

**W1.2 — Web-write endpoint** `src/app/api/spaces/[slug]/docs/route.ts` (NEW). Fail-closed pipeline (mirror `accept/route.ts`):
1. `getPrincipal(headers)`; staff/identified else **uniform 404**.
2. `getSpaceBySlug(slug)`; resolve role via `listSpaceMembers(slug)` + `resolvePrincipalUserId(principal)` (the `spaces/[slug]/page.tsx:57-60` pattern). Non-member on a private space → **uniform 404** (no existence leak).
3. Target ref: owner/admin → `refs/heads/main`; writer + `pushPolicy==="proposal"` → `proposalRef(handle)`. Gate with `refUpdateAllowed(space.pushPolicy, role, targetRef)` → false ⇒ **uniform 404**.
4. `bareRepoPath`; `initBareRepo` if absent (never-pushed space); `expectedTip = refTip(repoPath, targetRef)`.
5. `commitFilesToRef(...)`. `stale` ⇒ **409** "changed while editing — reload"; `conflict`/`error` ⇒ 409/500 with a clear message; the client preserves the draft.
6. On success: if the target was `main`, `reindexSpaceByDisk(slug, repoPath, { fromSha: expectedTip, toSha: newSha, actorName })` so the doc projects immediately. (Proposal-ref writes do **not** reindex `main`.) `emitEvent` (`doc.web_committed` / `proposal.opened`).

Verbs: **POST** = create-new-doc or upload; **PUT** = edit existing doc. Body shapes:
- **New doc:** `{ path?, title, content, frontmatter? }` → derive repo path (`<dir>/<slug>.md`), validate slug uniqueness against the live `docs_slug_idx`.
- **Edit doc:** `{ slug, content, baseCommit }` → resolve `sourcePath` from the `docs` row; `expectedTip` = `baseCommit` (the commit the editor loaded, from `docs.currentCommit`) so CAS catches a moved main.
- **Upload:** multipart; `bytes` = raw Buffer; target path = `<dir>/<filename>`. Enforce a **size cap** (reuse the spirit of `MAX_CONTENT_CHARS`).

**W1.3 — Raw asset serve** `src/app/api/spaces/[slug]/raw/[...path]/route.ts` (NEW): GET streams `readBlob(repoPath, path)` bytes with a sniffed content-type for a committed file. **Same read-access gate** as the space's docs (member/admin/visibility/share — never looser). This is how uploaded non-doc files (images/PDFs) are viewed/shared.

**W1.4 — UI** (client islands, token-styled like `MembersPanel.tsx`, rendered from `spaces/[slug]/page.tsx` for `canManage || myRole==="writer"`):
- `NewDocPanel.tsx` — title/path + body editor → POST.
- `UploadPanel.tsx` — file picker / drag-drop → multipart POST.
- Generalize `docs/[slug]/edit/EditorIsland.tsx` save to target the new space-docs endpoint (keep its `canPublishDirect`→owner-direct vs writer→proposal two-branch shape).
- Space file view lists the **full git tree** (`listTree`): doc-type files link to their rendered page, other files to the raw URL — so uploads of any type are visible. (Doubles as the "hierarchical file view" already wanted.)

## Slice W2 — Guest / proposal authoring (after W1 verified)
The same endpoint, step-3 branch already wired: role `writer` + `pushPolicy==="proposal"` ⇒ `targetRef = proposalRef(handle)` (handle from `tokenName`/email-local, mirroring `page.tsx:91`). `commitFilesToRef` writes onto `refs/heads/proposals/<handle>` (based on main's tip). It surfaces in the existing `ProposalsPanel` via `listProposalsForSpace`; the owner accepts through the **existing** `acceptProposalForSpace` — no new accept logic. So a web-only guest collaborator and a git-push guest collaborator open the *same* PR.

---

## Security (CRITICAL — exhaustive tests; the access boundary is sacred)
1. A **reader / non-member / anonymous** POST/PUT/upload → **uniform 404**, and **no ref moved** (assert `refTip` unchanged before/after).
2. A **writer under `pushPolicy="proposal"`** cannot commit to `main` — the write lands on `proposals/<handle>`; `main` tip unchanged.
3. **CAS rejects a stale write:** two edits off the same `baseCommit` — the second returns `stale`/409 and does not clobber the first.
4. **Owner/admin** commit to `main` succeeds and **projects** (the `docs` row updates; a fresh clone `git pull` retrieves the commit).
5. The **raw serve** route honors the same read gate (a non-member gets 404, not the bytes).
6. Path traversal: a `path` like `../../etc` or an absolute path is rejected; nothing is written outside the worktree.

## Tests (mirror existing files)
- `src/lib/git/web-commit.test.ts` (NEW, no socket) — new-doc, edit, delete, CAS-stale-rejects, conflict, path-traversal-rejected (mirror `proposals.test.ts`).
- Extend the git-backed e2e harness shape of `src/app/api/git/[...path]/proposals-e2e.test.ts` — web-commit to main → assert `git log` + a separate clone `git pull` sees it + the `docs` row projects (`architecture.md` §15.5).
- `src/app/api/spaces/[slug]/docs/route.test.ts` (NEW) — the authz matrix (assertions 1–4) at the route level.
- Extend `push-policy.test.ts` call-site assertions if needed.
- Full `npx vitest run` + `pnpm build` + `pnpm typecheck` green.

## Landing
Branch `feat/web-author` off `feat/external-collab-e2`. **W1 then W2** (W2 after W1's boundary is verified). Atomic commits; vitest **foreground** (never background — DB-deadlock false failures); **commit + STOP, no deploy/push** — the orchestrator re-verifies the security assertions solo, then Lucas reviews + merges (this stacks on the unmerged E2 → it all merges together).

## Outcomes
_(append on completion: files added, the commit primitive's final mechanism, test counts, any scope cuts.)_
