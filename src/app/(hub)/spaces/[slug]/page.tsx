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
import { gitRepoUrl } from "@/lib/git-url";
import SpaceVisibility from "./SpaceVisibility";
import MembersPanel, { type MemberRow, type UserChoice } from "./MembersPanel";
import PushHelp from "./PushHelp";
import SpaceDocsTree from "./SpaceDocsTree";

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

  const docs = (await docsInSpace(slug)) ?? [];
  // Unpublished docs are admin-only; everyone else sees the published set.
  const visibleDocs = docs.filter((d) => isAdmin || !d.unpublished);
  const ownerSlug = await ownerSlugForSpace(space);
  const repoUrl = gitRepoUrl(ownerSlug, space.slug, hdrs);

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

      {/* Push help */}
      <section style={{ marginBottom: 28 }}>
        <h2 style={sectionLabel}>push to this space</h2>
        <PushHelp repoUrl={repoUrl} canPush={canManage || myRole === "writer"} />
      </section>

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

      {/* Docs — collapsible folder tree by the doc `path` field. */}
      <section>
        <h2 style={sectionLabel}>docs in this space ({visibleDocs.length})</h2>
        {visibleDocs.length === 0 ? (
          <p style={{ fontSize: 13, color: "var(--faint)", margin: 0 }}>
            No docs yet. Push files to this space (see above) and they&rsquo;ll
            render here.
          </p>
        ) : (
          <SpaceDocsTree docs={visibleDocs} />
        )}
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
