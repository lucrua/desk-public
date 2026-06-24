import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getPrincipal } from "@/lib/auth";
import { resolvePrincipalUserId } from "@/lib/principal-user";
import {
  getSpaceBySlug,
  listSpaceMembers,
  docsInSpace,
  ownerSlugForSpace,
  type SpaceMemberItem,
  type SpaceRole,
} from "@/lib/spaces";
import { listUsers } from "@/lib/users";
import { gitRepoUrl, gitRemoteBase } from "@/lib/git-url";
import { renderSetupPrompt } from "@/lib/invites/setup-prompt";
import { listProposalsForSpace } from "@/lib/proposals-service";
import { listSpaceFiles } from "@/lib/web-author";
import { slugForPath } from "@/lib/git/indexer";
import SpaceVisibility from "./SpaceVisibility";
import PushPolicy from "./PushPolicy";
import InvitePanel from "./InvitePanel";
import SetupPromptView from "./SetupPromptView";
import MembersPanel, { type MemberRow, type UserChoice } from "./MembersPanel";
import PushHelp from "./PushHelp";
import SpaceDocsTree from "./SpaceDocsTree";
import SpaceFilesView from "./SpaceFilesView";
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
 * /spaces/[slug] — space detail. Shows the space's docs, a visibility control +
 * members panel (admin/owner only), and a "Push to this space" help block with
 * the exact git remote URL. A non-member non-admin gets a 404 (no existence
 * leak). Members see the space read-only.
 */
export default async function SpaceDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const hdrs = await headers();
  const principal = await getPrincipal(hdrs);
  const isAdmin = principal.kind === "admin";

  const space = await getSpaceBySlug(slug);
  if (!space) notFound();

  const members = (await listSpaceMembers(slug)) ?? [];
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
    ? (await listProposalsForSpace(slug).then((r) => (r.ok ? r.proposals : [])))
    : [];

  const docs = (await docsInSpace(slug)) ?? [];
  // Unpublished docs are admin-only; everyone else sees the published set.
  const visibleDocs = docs.filter((d) => isAdmin || !d.unpublished);
  const ownerSlug = await ownerSlugForSpace(space);
  const repoUrl = gitRepoUrl(ownerSlug, space.slug, hdrs);
  const pushPolicy = (space.pushPolicy as "direct" | "proposal") ?? "direct";

  // Web-author (Slice W1): an owner/admin (canManage) authors directly to main; a
  // writer authors too (direct → main, proposal → a PR). Readers cannot author.
  const canWebAuthor = canManage || myRole === "writer";
  const canPublishDirect = canManage; // owner/admin commit straight to main
  // Full git tree (every committed file, not just projected docs) — uploads of
  // any type show here. Doc-type files link to their rendered page via the
  // deterministic slug; other files link to the raw route.
  const spaceFiles = canWebAuthor || isAdmin || myMembership
    ? (await listSpaceFiles(space.slug)).map((f) => ({
        path: f.path,
        isDoc: f.isDoc,
        docSlug: f.isDoc ? slugForPath(f.path) : undefined,
      }))
    : [];

  // The setup-prompt TEMPLATE for members: a `<token>` placeholder (not a live
  // credential — the live token is handed out once at invite-accept time, or
  // minted at /settings/tokens). The push line already reflects push_policy.
  const setupPrompt = renderSetupPrompt({
    ownerSlug,
    spaceSlug: space.slug,
    gitHostBase: gitRemoteBase(hdrs),
    token: "<token>",
    pushPolicy,
    handle: myMembership?.tokenName ?? (myMembership?.email ? myMembership.email.split("@")[0] : "you"),
  });

  // For the members panel's "add by email" select, surface active users (admins
  // only — the only ones who can add members).
  const userChoices: UserChoice[] = canManage ? await activeUserChoices() : [];

  const memberRows: MemberRow[] = members.map(toMemberRow);

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

      {/* Visibility */}
      <section style={{ marginBottom: 28 }}>
        <h2 style={sectionLabel}>visibility</h2>
        {canManage ? (
          <SpaceVisibility slug={space.slug} current={space.visibility as "private" | "unlisted" | "public"} />
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
          <PushPolicy slug={space.slug} current={pushPolicy} />
        ) : (
          <p style={{ fontSize: 13, color: "var(--muted)", margin: 0 }}>
            This space&rsquo;s push policy is <strong>{pushPolicy}</strong>.{" "}
            {pushPolicy === "proposal"
              ? "Non-owner writers push to proposals/* (opens a PR for the owner)."
              : "Writers push the hosted main branch directly."}
          </p>
        )}
      </section>

      {/* Proposals (PR review) — owner/admin act; a writer sees the list. */}
      {canSeeProposals && (pushPolicy === "proposal" || proposals.length > 0) && (
        <section style={{ marginBottom: 28 }}>
          <h2 style={sectionLabel}>proposals ({proposals.length})</h2>
          <ProposalsPanel slug={space.slug} proposals={proposals} canDecide={canManage} />
        </section>
      )}

      {/* Invites (owner/admin) */}
      {canManage && (
        <section style={{ marginBottom: 28 }}>
          <h2 style={sectionLabel}>invite an external partner</h2>
          <InvitePanel slug={space.slug} />
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
          slug={space.slug}
          members={memberRows}
          userChoices={userChoices}
          canManage={canManage}
        />
      </section>

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
              slug={space.slug}
              pushPolicy={pushPolicy}
              canPublishDirect={canPublishDirect}
            />
          </div>
          <div>
            <h3 style={{ ...sectionLabel, margin: "0 0 8px" }}>upload a file</h3>
            <UploadPanel
              slug={space.slug}
              pushPolicy={pushPolicy}
              canPublishDirect={canPublishDirect}
            />
          </div>
        </section>
      )}

      {/* Docs — collapsible folder tree by the doc `path` field. */}
      <section style={{ marginBottom: 28 }}>
        <h2 style={sectionLabel}>docs in this space ({visibleDocs.length})</h2>
        {visibleDocs.length === 0 ? (
          <p style={{ fontSize: 13, color: "var(--faint)", margin: 0 }}>
            No docs yet. Create one above, push files to this space, and
            they&rsquo;ll render here.
          </p>
        ) : (
          <SpaceDocsTree docs={visibleDocs} />
        )}
      </section>

      {/* Files — the full git tree (uploads of any type included). */}
      <section>
        <h2 style={sectionLabel}>files ({spaceFiles.length})</h2>
        <SpaceFilesView slug={space.slug} files={spaceFiles} />
      </section>
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
