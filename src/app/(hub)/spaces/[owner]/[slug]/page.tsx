import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getPrincipal } from "@/lib/auth";
import { resolvePrincipalUserId } from "@/lib/principal-user";
import {
  getSpace,
  listSpaceMembers,
  docsInSpace,
  ownerHandleForSpace,
  type SpaceMemberItem,
  type SpaceRole,
} from "@/lib/spaces";
import { listUsers } from "@/lib/users";
import { gitRepoUrl, gitRemoteBase } from "@/lib/git-url";
import { renderSetupPrompt } from "@/lib/invites/setup-prompt";
import { listProposalsForSpace } from "@/lib/proposals-service";
import { listSpaceFiles } from "@/lib/web-author";
import { hasSpaceDeployKey } from "@/lib/mirror";
import SpaceVisibility from "./SpaceVisibility";
import PushPolicy from "./PushPolicy";
import MirrorSettings from "./MirrorSettings";
import InvitePanel from "./InvitePanel";
import SetupPromptView from "./SetupPromptView";
import MembersPanel, { type MemberRow, type UserChoice } from "./MembersPanel";
import PushHelp from "./PushHelp";
import SpaceFileExplorer, { type FileEntry } from "./SpaceFileExplorer";
import SpaceTabs from "./SpaceTabs";
import NewDocPanel from "./NewDocPanel";
import UploadPanel from "./UploadPanel";
import ProposalsPanel from "./ProposalsPanel";

export const dynamic = "force-dynamic";

const sectionLabel = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  letterSpacing: "0.06em",
  textTransform: "uppercase" as const,
  color: "var(--faint)",
  margin: "0 0 10px",
} as const;

/**
 * /spaces/[owner]/[slug] — space detail (Owner-namespace S4: owner-qualified).
 * The `<owner>` segment is the owner's stable handle; the space resolves via
 * `getSpace(owner, slug)` so two owners can share a slug and each `/spaces/<owner>/
 * <slug>` resolves to the RIGHT space (a wrong owner/handle → 404, no existence
 * leak). Shows the space's docs, a visibility control + members panel (admin/owner
 * only), and a "Push to this space" help block with the exact git remote URL. A
 * non-member non-admin gets a 404. Legacy `/spaces/<slug>` 301-redirects here via
 * the proxy (src/proxy.ts).
 */
export default async function SpaceDetailPage({
  params,
}: {
  params: Promise<{ owner: string; slug: string }>;
}) {
  const { owner, slug } = await params;
  const hdrs = await headers();
  const principal = await getPrincipal(hdrs);
  const isAdmin = principal.kind === "admin";

  const space = await getSpace(owner, slug);
  if (!space) notFound();

  // The canonical `<owner>` segment for every owner-qualified link on this page
  // (panels' API fetches + the git remote) is the owner's STABLE HANDLE
  // (Owner-namespace S4/S5, D4) — the same segment this page resolved under.
  const ownerHandle = await ownerHandleForSpace(space);

  const members = (await listSpaceMembers(space.id)) ?? [];
  const myUserId = await resolvePrincipalUserId(principal);
  const myMembership = myUserId != null ? members.find((m) => m.userId === myUserId) : undefined;
  const myRole: SpaceRole | null = myMembership?.role ?? null;

  // Visibility: admins see any space; a non-admin must be a member of THIS space.
  if (!isAdmin && !myMembership) notFound();

  // Manage rights (visibility + members) = admin OR the space owner.
  const canManage = isAdmin || myRole === "owner";

  // Proposals (E2): admin / owner / writer may see the list; only owner/admin
  // (canManage) may accept/reject. Fetch only when the caller may see them.
  const canSeeProposals = canManage || myRole === "writer";
  const proposals = canSeeProposals
    ? (await listProposalsForSpace(space.id).then((r) => (r.ok ? r.proposals : [])))
    : [];

  const docs = (await docsInSpace(space.id)) ?? [];
  // Unpublished docs are admin-only; everyone else sees the published set.
  const visibleDocs = docs.filter((d) => isAdmin || !d.unpublished);
  const repoUrl = gitRepoUrl(ownerHandle, space.slug, hdrs);
  const pushPolicy = (space.pushPolicy as "direct" | "proposal") ?? "direct";

  // Web-author (Slice W1): an owner/admin (canManage) authors directly to main; a
  // writer authors too (direct → main, proposal → a PR). Readers cannot author.
  const canWebAuthor = canManage || myRole === "writer";
  const canPublishDirect = canManage; // owner/admin commit straight to main

  // ⚠ ACCESS BOUNDARY (do not weaken). The full git tree — every committed file,
  // INCLUDING non-doc raw uploads (images, PDFs, data) — is gated exactly as
  // before: shown only to `canWebAuthor || isAdmin || myMembership`. Doc-type
  // files link to their rendered page via the real projected slug; other files
  // link to the raw route.
  const canSeeRawFiles = canWebAuthor || isAdmin || myMembership;
  const spaceFiles: FileEntry[] = canSeeRawFiles
    ? (await listSpaceFiles(space.id)).map((f) => ({
        path: f.path,
        isDoc: f.isDoc,
        docSlug: f.docSlug, // the REAL projected slug (opaque id), not path-derived
      }))
    : [];

  // The unified explorer (S3) feed. For the gated audience: the full tree above.
  // For a viewer who can see the space but is OUTSIDE that gate, fall back to a
  // DOCS-ONLY tree (the projected docs, exactly what `SpaceDocsTree` showed) —
  // no raw non-doc file, and no unpublished doc for a non-admin (visibleDocs is
  // already filtered). A synthetic `folder/slug.ext` path lets the same tree
  // builder fold docs into their folders; the leaf still links by real slug.
  const explorerFiles: FileEntry[] = canSeeRawFiles
    ? spaceFiles
    : visibleDocs.map((d) => ({
        path: (d.path ? d.path + "/" : "") + d.slug + "." + d.format,
        isDoc: true,
        docSlug: d.slug,
      }));

  // The setup-prompt TEMPLATE for members: a `<token>` placeholder (not a live
  // credential — the live token is handed out once at invite-accept time, or
  // minted at /settings/tokens). The push line already reflects push_policy.
  const setupPrompt = renderSetupPrompt({
    ownerSlug: ownerHandle,
    spaceSlug: space.slug,
    gitHostBase: gitRemoteBase(hdrs),
    token: "<token>",
    pushPolicy,
    handle: myMembership?.tokenName ?? (myMembership?.email ? myMembership.email.split("@")[0] : "you"),
  });

  // For the members panel's "add by email" select, surface active users (admins
  // only — the only ones who can add members).
  const userChoices: UserChoice[] = canManage ? await activeUserChoices() : [];

  // GitHub mirror settings (Slice 4c) — owner/admin only; the "configured ✓"
  // flag is boolean-only (no reveal), same posture as the instance PAT.
  const deployKeyConfigured = canManage ? await hasSpaceDeployKey(space.id) : false;

  const memberRows: MemberRow[] = members.map(toMemberRow);

  // The Settings tab surfaces space config. Its read-only visibility / push-policy
  // / mirror notes + members list + setup prompt are shown to every ADMIN or
  // MEMBER today (WHO is unchanged — only WHERE moves), so the tab is present for
  // them. A viewer who is NEITHER (only reachable if the membership gate above is
  // ever relaxed for public spaces) has nothing to configure → NO Settings tab,
  // never newly exposing anything.
  const hasSettings = isAdmin || myMembership != null;

  // ── Content tab: the file explorer + authoring actions + proposals (all act
  //    on `main`). Server-rendered here, handed to the client tab shell. ─────────
  const contentGroup = (
    <>
      {/* Author from the web (owner/admin direct; writer direct-or-proposal). */}
      {canWebAuthor && (
        <section style={{ marginBottom: 28 }}>
          <h2 style={sectionLabel}>author from the web</h2>
          <p style={{ margin: "0 0 12px", fontSize: 12.5, color: "var(--muted)" }}>
            Every save is one git commit into this space&rsquo;s repo
            {canPublishDirect
              ? "."
              : pushPolicy === "proposal"
                ? " — your saves open a proposal for the owner to review."
                : "."}
          </p>
          <div style={{ marginBottom: 16 }}>
            <NewDocPanel
              owner={ownerHandle}
              slug={space.slug}
              pushPolicy={pushPolicy}
              canPublishDirect={canPublishDirect}
            />
          </div>
          <div>
            <h3 style={{ ...sectionLabel, margin: "0 0 8px" }}>upload a file</h3>
            <UploadPanel
              owner={ownerHandle}
              slug={space.slug}
              pushPolicy={pushPolicy}
              canPublishDirect={canPublishDirect}
            />
          </div>
        </section>
      )}

      {/* Proposals (PR review) — owner/admin act; a writer sees the list. They
          act on `main`, so they live under Content. */}
      {canSeeProposals && (pushPolicy === "proposal" || proposals.length > 0) && (
        <section style={{ marginBottom: 28 }}>
          <h2 style={sectionLabel}>proposals ({proposals.length})</h2>
          <ProposalsPanel owner={ownerHandle} slug={space.slug} proposals={proposals} canDecide={canManage} />
        </section>
      )}

      {/* Files — one unified collapsed tree of every committed file (folders
          start collapsed). Doc leaves link to their rendered page; raw leaves to
          the raw route. The list is boundary-gated upstream (explorerFiles). */}
      <section>
        <h2 style={sectionLabel}>files ({explorerFiles.length})</h2>
        <SpaceFileExplorer owner={ownerHandle} slug={space.slug} files={explorerFiles} />
      </section>
    </>
  );

  // ── Settings tab: visibility, push policy, GitHub mirror, invites, push help,
  //    setup prompt, members. Each panel keeps its OWN gate. ────────────────────
  const settingsGroup = (
    <>
      {/* Visibility */}
      <section style={{ marginBottom: 28 }}>
        <h2 style={sectionLabel}>visibility</h2>
        {canManage ? (
          <SpaceVisibility owner={ownerHandle} slug={space.slug} current={space.visibility as "private" | "unlisted" | "public"} />
        ) : (
          <p style={{ fontSize: 13, color: "var(--muted)", margin: 0 }}>
            This space is <strong>{space.visibility}</strong>. Only an admin or the
            owner can change it.
          </p>
        )}
      </section>

      {/* Push policy */}
      <section style={{ marginBottom: 28 }}>
        <h2 style={sectionLabel}>push policy</h2>
        {canManage ? (
          <PushPolicy owner={ownerHandle} slug={space.slug} current={pushPolicy} />
        ) : (
          <p style={{ fontSize: 13, color: "var(--muted)", margin: 0 }}>
            This space&rsquo;s push policy is <strong>{pushPolicy}</strong>.{" "}
            {pushPolicy === "proposal"
              ? "Non-owner writers push to proposals/* (opens a PR for the owner)."
              : "Writers push the hosted main branch directly."}
          </p>
        )}
      </section>

      {/* GitHub mirror (Slice 4c, D-C3/D-C4/D-C5): source mode, remote URL,
          "Mirror now" + status, and the per-space deploy-key override. Owner/
          admin only — a non-manager sees the current mode as a one-line note,
          matching the visibility/push-policy read-only fallback above. */}
      <section style={{ marginBottom: 28 }}>
        <h2 style={sectionLabel}>github mirror</h2>
        {canManage ? (
          <MirrorSettings
            owner={ownerHandle}
            slug={space.slug}
            sourceMode={space.sourceMode as "hosted" | "mirrored"}
            mirrorRemoteUrl={space.mirrorRemoteUrl}
            mirrorState={space.mirrorState}
            hasDeployKey={deployKeyConfigured}
          />
        ) : (
          <p style={{ fontSize: 13, color: "var(--muted)", margin: 0 }}>
            This space is <strong>{space.sourceMode}</strong>
            {space.sourceMode === "mirrored"
              ? " — GitHub is canon; content arrives here only via a git push."
              : space.mirrorRemoteUrl
                ? " — Desk mirrors main out to GitHub after every write."
                : "."}{" "}
            Only an admin or the owner can change it.
          </p>
        )}
      </section>

      {/* Invites (owner/admin) */}
      {canManage && (
        <section style={{ marginBottom: 28 }}>
          <h2 style={sectionLabel}>invite an external partner</h2>
          <InvitePanel owner={ownerHandle} slug={space.slug} />
        </section>
      )}

      {/* Push help */}
      <section style={{ marginBottom: 28 }}>
        <h2 style={sectionLabel}>push to this space</h2>
        <PushHelp repoUrl={repoUrl} canPush={canManage || myRole === "writer"} />
      </section>

      {/* Setup prompt (members) — paste-able onboarding for an agent. */}
      {myMembership && (
        <section style={{ marginBottom: 28 }}>
          <h2 style={sectionLabel}>agent setup prompt</h2>
          <SetupPromptView prompt={setupPrompt} />
        </section>
      )}

      {/* Members */}
      <section style={{ marginBottom: 28 }}>
        <h2 style={sectionLabel}>members</h2>
        <MembersPanel
          owner={ownerHandle}
          slug={space.slug}
          members={memberRows}
          userChoices={userChoices}
          canManage={canManage}
        />
      </section>
    </>
  );

  return (
    <div style={{ maxWidth: 820, margin: "0 auto", padding: "32px 20px 80px" }}>
      <div style={{ marginBottom: 4 }}>
        <Link href="/spaces" style={{ fontSize: 12, color: "var(--accent)", textDecoration: "none" }}>
          ← Spaces
        </Link>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 4 }}>
        <h1 style={{ fontSize: 24, fontWeight: 600, fontFamily: "var(--font-mono)", margin: 0 }}>
          {space.slug}
        </h1>
        {myRole && (
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              padding: "3px 10px",
              borderRadius: 999,
              border: "1px solid var(--hairline)",
              background: "var(--surface-alt)",
              color: "var(--muted)",
            }}
          >
            your role: {myRole}
          </span>
        )}
      </div>
      <p style={{ margin: "0 0 24px", fontSize: 13, color: "var(--muted)" }}>
        Owned by {memberRows.find((m) => m.isOwner)?.label ?? `user ${space.ownerUserId}`}.
      </p>

      <SpaceTabs content={contentGroup} settings={settingsGroup} hasSettings={hasSettings} />
    </div>
  );
}

function toMemberRow(m: SpaceMemberItem): MemberRow {
  const label = m.displayName || m.email || m.tokenName || `user ${m.userId}`;
  return {
    userId: m.userId,
    role: m.role,
    label,
    sub: m.email ?? m.tokenName ?? null,
    isOwner: m.isOwner,
  };
}

async function activeUserChoices(): Promise<UserChoice[]> {
  const all = await listUsers();
  return all
    .filter((u) => u.active === 1)
    .map((u) => ({
      id: u.id,
      label: u.displayName,
      email: u.email ?? null,
    }));
}
