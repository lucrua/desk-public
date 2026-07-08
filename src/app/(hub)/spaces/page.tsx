import { headers } from "next/headers";
import Link from "next/link";
import { getPrincipal } from "@/lib/auth";
import { resolvePrincipalUserId } from "@/lib/principal-user";
import { listSpacesForView, type SpaceViewItem } from "@/lib/spaces";
import NewSpace from "./NewSpace";

export const dynamic = "force-dynamic";

const labelStyle = {
  fontFamily: "var(--font-mono)",
  fontSize: 9.5,
  letterSpacing: "0.06em",
  textTransform: "uppercase" as const,
  color: "var(--faint)",
} as const;

function VisibilityBadge({ visibility }: { visibility: string }) {
  return (
    <span
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: 10,
        padding: "1px 7px",
        borderRadius: 999,
        border: "1px solid var(--hairline)",
        color: "var(--muted)",
        background: "var(--surface-alt)",
      }}
    >
      {visibility}
    </span>
  );
}

/**
 * /spaces — "Your spaces". Admins see every space; members see the spaces they
 * belong to. Each row → slug, owner, visibility, member count, doc count, linking
 * to the space detail page. "New space" (admin-only this slice) creates a space
 * owned by the creator. Informative empty state explains what a space is.
 */
export default async function SpacesPage() {
  const principal = await getPrincipal(await headers());
  const isAdmin = principal.kind === "admin";
  const userId = isAdmin ? null : await resolvePrincipalUserId(principal);
  const spaces = await listSpacesForView({ isAdmin, userId });

  return (
    <div style={{ maxWidth: 820, margin: "0 auto", padding: "32px 20px 80px" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
        <h1 style={{ fontSize: 24, fontWeight: 600, letterSpacing: "-0.01em", margin: 0 }}>
          Spaces
        </h1>
      </div>
      <p style={{ margin: "4px 0 24px", fontSize: 13, color: "var(--muted)", lineHeight: 1.55 }}>
        A <strong>space</strong> is an owned, access-controlled git repo Desk
        hosts — the unit of write/clone access. Push files to a space and Desk
        renders them; share subsets to readers.{" "}
        {isAdmin ? "You see every space." : "You see the spaces you belong to."}
      </p>

      {isAdmin && <NewSpace />}

      {spaces.length === 0 ? (
        <EmptyState isAdmin={isAdmin} />
      ) : (
        <div
          style={{
            border: "1px solid var(--hairline)",
            borderRadius: 10,
            overflow: "hidden",
            marginTop: 18,
          }}
        >
          {spaces.map((s, i) => (
            <SpaceRow key={s.id} space={s} first={i === 0} />
          ))}
        </div>
      )}
    </div>
  );
}

function SpaceRow({ space, first }: { space: SpaceViewItem; first: boolean }) {
  return (
    <Link
      href={`/spaces/${space.ownerHandle}/${space.slug}`}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "13px 16px",
        borderTop: first ? "none" : "1px solid var(--hairline)",
        background: "var(--surface)",
        textDecoration: "none",
        color: "var(--ink)",
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600, fontFamily: "var(--font-mono)" }}>
          {space.slug}
        </div>
        <div style={{ fontSize: 11.5, color: "var(--faint)", marginTop: 3 }}>
          owner {space.ownerLabel} · {space.memberCount}{" "}
          {space.memberCount === 1 ? "member" : "members"} · {space.docCount}{" "}
          {space.docCount === 1 ? "doc" : "docs"}
        </div>
      </div>
      <VisibilityBadge visibility={space.visibility} />
      <span style={{ color: "var(--faint)", fontSize: 14 }}>→</span>
    </Link>
  );
}

function EmptyState({ isAdmin }: { isAdmin: boolean }) {
  return (
    <div
      style={{
        border: "1px dashed var(--hairline-strong)",
        borderRadius: 10,
        background: "var(--surface-alt)",
        padding: "28px 24px",
        marginTop: 18,
        textAlign: "center",
      }}
    >
      <div style={{ ...labelStyle, marginBottom: 8 }}>no spaces yet</div>
      <p style={{ margin: "0 auto", maxWidth: 460, fontSize: 13, color: "var(--muted)", lineHeight: 1.6 }}>
        A space is a git repo Desk hosts. {isAdmin
          ? "Create one above, then mint a token and push files to it — Desk renders them and you can share subsets to readers."
          : "You're not a member of any space yet. Ask an admin to add you, then you'll see it here."}
      </p>
    </div>
  );
}
