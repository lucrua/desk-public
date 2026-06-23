import { headers } from "next/headers";
import { notFound } from "next/navigation";
import Link from "next/link";
import { getPrincipal } from "@/lib/auth";
import {
  distributionBySpace,
  distributionByUser,
  distributionLinks,
  type SpaceDistEntry,
  type UserDistEntry,
  type LinkDistEntry,
} from "@/lib/distribution";
import DistLinkActions from "./DistLinkActions";

export const dynamic = "force-dynamic";

// ── shared style fragments ───────────────────────────────────────────────────
const mono = { fontFamily: "var(--font-mono)" } as const;

const tableHead = {
  ...mono,
  fontSize: 10,
  letterSpacing: "0.06em",
  textTransform: "uppercase" as const,
  color: "var(--faint)",
};

const cellMono = { ...mono, fontSize: 11, color: "var(--muted)" } as const;

const chip = (fg: string) => ({
  ...mono,
  fontSize: 10,
  padding: "2px 7px",
  borderRadius: 4,
  border: "1px solid var(--hairline)",
  color: fg,
  display: "inline-block" as const,
});

const statusColors: Record<"active" | "revoked" | "expired", string> = {
  active: "var(--ok-ink, var(--accent))",
  revoked: "var(--danger-ink)",
  expired: "var(--faint)",
};

function formatDate(d: Date | null): string {
  if (!d) return "—";
  return d.toISOString().slice(0, 10);
}

// ── By Space lens ────────────────────────────────────────────────────────────
function SpaceLens({ rows }: { rows: SpaceDistEntry[] }) {
  if (rows.length === 0) {
    return (
      <p style={{ fontSize: 13, color: "var(--muted)" }}>No spaces configured.</p>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {rows.map((s) => (
        <div
          key={s.slug}
          style={{
            border: "1px solid var(--hairline)",
            borderRadius: 10,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "10px 14px",
              background: "var(--surface-alt)",
              borderBottom:
                s.docCount > 0 || s.members.length > 0 ? "1px solid var(--hairline)" : "none",
            }}
          >
            <span style={{ ...mono, fontSize: 12, fontWeight: 600, color: "var(--ink)" }}>
              {s.slug}
            </span>
            <span
              style={chip(
                s.openVisible ? "var(--ok-ink, var(--accent))" : "var(--muted)",
              )}
            >
              {s.visibility}
            </span>
            <span style={{ ...cellMono, marginLeft: "auto" }}>
              {s.memberCount} {s.memberCount === 1 ? "member" : "members"}
            </span>
            <span style={cellMono}>
              {s.docCount} {s.docCount === 1 ? "doc" : "docs"}
            </span>
          </div>
          {(s.members.length > 0 || s.docCount > 0) && (
            <div style={{ padding: "6px 14px 10px" }}>
              {s.members.length > 0 && (
                <div style={{ marginBottom: 6, display: "flex", flexWrap: "wrap", gap: 4 }}>
                  {s.members.map((m) => (
                    <span
                      key={m.displayName}
                      style={{ ...mono, fontSize: 10.5, padding: "2px 8px", borderRadius: 999, border: "1px solid var(--hairline)", color: "var(--muted)" }}
                    >
                      {m.displayName}
                      <span style={{ color: "var(--faint)" }}> · {m.role}</span>
                    </span>
                  ))}
                </div>
              )}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {s.docs.map((d) => (
                  <Link
                    key={d.slug}
                    href={`/docs/${d.slug}`}
                    style={{
                      ...mono,
                      fontSize: 10.5,
                      padding: "2px 8px",
                      borderRadius: 999,
                      border: "1px solid var(--hairline)",
                      color: "var(--accent)",
                      textDecoration: "none",
                    }}
                  >
                    {d.path ? `${d.path}/${d.slug}` : d.slug}
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ── By User lens ─────────────────────────────────────────────────────────────
function UserLens({ rows }: { rows: UserDistEntry[] }) {
  if (rows.length === 0) {
    return (
      <p style={{ fontSize: 13, color: "var(--muted)" }}>No active users.</p>
    );
  }

  return (
    <div style={{ border: "1px solid var(--hairline)", borderRadius: 10, overflow: "hidden" }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1.5fr 1fr 1fr 2fr 0.6fr",
          padding: "7px 14px",
          background: "var(--surface-alt)",
          borderBottom: "1px solid var(--hairline)",
          ...tableHead,
        }}
      >
        <span>user</span>
        <span>role</span>
        <span>emails</span>
        <span>visible spaces</span>
        <span style={{ justifySelf: "end" }}>docs</span>
      </div>
      {rows.map((u) => (
        <div
          key={u.id}
          style={{
            display: "grid",
            gridTemplateColumns: "1.5fr 1fr 1fr 2fr 0.6fr",
            padding: "9px 14px",
            borderBottom: "1px solid var(--hairline)",
            alignItems: "start",
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 500, color: "var(--ink)" }}>
            {u.displayName}
          </span>
          <span style={{ ...cellMono, textTransform: "uppercase", fontSize: 10, letterSpacing: "0.04em" }}>
            {u.role}
          </span>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {u.emails.map((e) => (
              <span key={e} style={{ ...cellMono, fontSize: 10.5 }}>{e}</span>
            ))}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
            {u.visibleSpaces.length === 0 ? (
              <span style={cellMono}>none</span>
            ) : u.role === "admin" ? (
              <span style={chip("var(--muted)")}>all ({u.visibleSpaces.length})</span>
            ) : (
              u.visibleSpaces.map((slug) => (
                <span key={slug} style={chip("var(--muted)")}>{slug}</span>
              ))
            )}
          </div>
          <span style={{ ...cellMono, justifySelf: "end", fontWeight: 600 }}>
            {u.role === "admin" ? `${u.visibleDocCount} (all)` : u.visibleDocCount}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── By Links lens ─────────────────────────────────────────────────────────────
function LinksLens({ rows }: { rows: LinkDistEntry[] }) {
  if (rows.length === 0) {
    return (
      <p style={{ fontSize: 13, color: "var(--muted)" }}>No share links.</p>
    );
  }

  return (
    <div style={{ border: "1px solid var(--hairline)", borderRadius: 10, overflow: "hidden" }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1.5fr 0.9fr 1.2fr 0.7fr 0.6fr 0.6fr 0.5fr 0.5fr",
          padding: "7px 14px",
          background: "var(--surface-alt)",
          borderBottom: "1px solid var(--hairline)",
          ...tableHead,
        }}
      >
        <span>label</span>
        <span>type</span>
        <span>target</span>
        <span>created</span>
        <span style={{ justifySelf: "end" }}>views</span>
        <span>status</span>
        <span style={{ justifySelf: "end" }}>copy</span>
        <span style={{ justifySelf: "end" }} />
      </div>
      {rows.map((link) => (
        <LinkRow key={link.id} link={link} />
      ))}
    </div>
  );
}

/**
 * Client-interactive row: copy, revoke, delete.
 * Defined as a server component structure but uses client islands inline.
 * Because this page is a server component, interactive bits are pulled out
 * into a separate inline client component below.
 */
function LinkRow({ link }: { link: LinkDistEntry }) {
  const st = statusColors[link.status];
  const targetLabel =
    link.mode === "dir"
      ? `folder · ${"pathPrefix" in link.target ? link.target.pathPrefix : ""}/ `
      : "slug" in link.target
        ? link.target.slug
        : "";
  const targetHref =
    link.mode === "doc" && "slug" in link.target
      ? `/docs/${link.target.slug}`
      : null;

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1.5fr 0.9fr 1.2fr 0.7fr 0.6fr 0.6fr 0.5fr 0.5fr",
        padding: "9px 14px",
        borderBottom: "1px solid var(--hairline)",
        alignItems: "center",
        opacity: link.status === "active" ? 1 : 0.6,
      }}
    >
      <span style={{ fontSize: 12.5, fontWeight: 500, color: "var(--ink)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {link.label}
      </span>
      <span>
        <span style={link.mode === "dir"
          ? chip("var(--ref-ink, var(--accent))")
          : { ...chip("var(--muted)"), border: "1px solid var(--hairline)" }
        }>
          {link.mode === "dir" ? "folder" : "doc"}
        </span>
      </span>
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {targetHref ? (
          <Link href={targetHref} style={{ ...cellMono, fontSize: 11.5, color: "var(--accent)", textDecoration: "none" }}>
            {targetLabel}
          </Link>
        ) : (
          <span style={cellMono}>{targetLabel}</span>
        )}
      </span>
      <span style={cellMono}>{formatDate(link.createdAt)}</span>
      <span style={{ ...cellMono, justifySelf: "end" }}>{link.views}</span>
      <span style={{ ...mono, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.04em", color: st }}>
        {link.status}
      </span>
      {/* Copy + revoke/delete are interactive — delegate to a client island */}
      <DistLinkActions id={link.id} canCopy={link.canCopy} status={link.status} label={link.label} />
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────
export default async function DistributionPage() {
  const principal = await getPrincipal(await headers());
  if (principal.kind !== "admin") notFound();

  const [bySpace, byUser, links] = await Promise.all([
    distributionBySpace(),
    distributionByUser(),
    distributionLinks(),
  ]);

  const liveLinks = links.filter((l) => l.status === "active").length;

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: "32px 20px 90px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, marginBottom: 6 }}>
        <h1 style={{ fontSize: 20, fontWeight: 600, letterSpacing: "-0.01em", margin: 0 }}>
          Distribution
        </h1>
        <span style={{ ...mono, fontSize: 11, color: "var(--faint)" }}>
          {bySpace.length} spaces · {byUser.length} users · {links.length} links ({liveLinks} active)
        </span>
      </div>
      <p style={{ margin: "0 0 28px", fontSize: 13, color: "var(--muted)" }}>
        Who can see what — three read-only lenses over your workspace&apos;s exposure. Admin-only.
      </p>

      {/* ── By Space ── */}
      <section style={{ marginBottom: 48 }}>
        <h2 style={{ fontSize: 15, fontWeight: 600, margin: "0 0 12px" }}>By space</h2>
        <p style={{ margin: "0 0 14px", fontSize: 13, color: "var(--muted)" }}>
          Each space — its visibility, who is a member (and their role), and which docs live in it.
          A public/unlisted space is visible to every signed-in user; a private space only to its members.
        </p>
        <SpaceLens rows={bySpace} />
      </section>

      {/* ── By User ── */}
      <section style={{ marginBottom: 48 }}>
        <h2 style={{ fontSize: 15, fontWeight: 600, margin: "0 0 12px" }}>By user</h2>
        <p style={{ margin: "0 0 14px", fontSize: 13, color: "var(--muted)" }}>
          Each active user — their role, the spaces they can see (member-of plus any
          public/unlisted space), and how many docs they can see. Admins see all docs in all spaces.
        </p>
        <UserLens rows={byUser} />
      </section>

      {/* ── By Links & Folders ── */}
      <section style={{ marginBottom: 48 }}>
        <h2 style={{ fontSize: 15, fontWeight: 600, margin: "0 0 12px" }}>By links &amp; folders</h2>
        <p style={{ margin: "0 0 14px", fontSize: 13, color: "var(--muted)" }}>
          All share links — doc and directory — with copy, revoke, and delete controls.
          Revoked rows stay visible (dimmed) until deleted.
        </p>
        <LinksLens rows={links} />
      </section>
    </div>
  );
}
