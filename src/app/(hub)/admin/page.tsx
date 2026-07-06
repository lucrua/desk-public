import { headers } from "next/headers";
import Link from "next/link";
import { getPrincipal } from "@/lib/auth";
import { listDocs } from "@/lib/docs";
import { listShares, countRecentViews } from "@/lib/shares";
import { listUsers, listAllUserEmails } from "@/lib/users";
import { listAccessRequests } from "@/lib/access-requests";
import { hasInstanceGithubPat } from "@/lib/instance-settings";
import { dateStamp } from "../docs/view-model";
import { computeStats, toShareRow, toUserRow, toAccessRequestRow } from "./view-model";
import ShareRow from "./ShareRow";
import DocUnpublish from "./DocUnpublish";
import UserRow from "./UserRow";
import AddUser from "./AddUser";
import AccessRequests from "./AccessRequests";
import GithubPatSettings from "./GithubPatSettings";

export const dynamic = "force-dynamic";

// ── shared style fragments ───────────────────────────────────────────────────
const tableHead = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--faint)",
} as const;

const sectionH2 = {
  fontSize: 14,
  fontWeight: 600,
  margin: "0 0 10px",
} as const;

/**
 * The admin to ask for access. Derived from active admin rows in the DB so
 * the contact info stays accurate as admins are promoted/demoted. Falls back
 * to a generic label when no active admin row exists yet.
 */
async function grantContact(): Promise<string> {
  try {
    const { listUsers } = await import("@/lib/users");
    const all = await listUsers();
    const admins = all.filter((u) => u.role === "admin" && u.active === 1);
    if (admins.length === 0) return "the workspace admin";
    const first = admins[0];
    return first.email
      ? `${first.displayName} (${first.email})`
      : first.displayName;
  } catch {
    return "the workspace admin";
  }
}

// ── 403 panel (member self-gate) ─────────────────────────────────────────────
async function ForbiddenPanel() {
  const contact = await grantContact();
  return (
    <div style={{ maxWidth: 1180, margin: "0 auto", padding: "26px 20px 90px" }}>
      <div
        style={{
          maxWidth: 460,
          margin: "60px auto",
          textAlign: "center",
          border: "1px solid var(--danger-border)",
          background: "var(--danger-bg)",
          borderRadius: 12,
          padding: "32px 28px",
        }}
      >
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            color: "var(--danger-ink)",
            marginBottom: 10,
          }}
        >
          403 · admin only
        </div>
        <h1 style={{ fontSize: 18, fontWeight: 600, margin: "0 0 8px", color: "var(--ink)" }}>
          This surface is admin-only
        </h1>
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6, color: "var(--muted)" }}>
          The admin dashboard manages shares, the view log, and published docs.
          Your account is a member — ask {contact} if you need admin access.
        </p>
        <Link
          href="/spaces"
          style={{
            display: "inline-block",
            marginTop: 18,
            fontSize: 12.5,
            color: "var(--accent)",
            textDecoration: "none",
          }}
        >
          ← Back to spaces
        </Link>
      </div>
    </div>
  );
}

export default async function AdminPage() {
  const principal = await getPrincipal(await headers());

  // Layout already blocks anonymous. The PAGE self-gates members per prototype:
  // a member reaching /admin gets a 403 panel, not a redirect.
  if (principal.kind !== "admin") {
    return <ForbiddenPanel />;
  }

  const [docs, shares, recentViews, users, accessRequests, emailsByUser, githubPatConfigured] =
    await Promise.all([
      listDocs({ includeUnpublished: true, scope: { viewer: "admin" } }),
      listShares(),
      countRecentViews(7),
      listUsers(),
      listAccessRequests(),
      listAllUserEmails(),
      hasInstanceGithubPat(),
    ]);

  const stats = computeStats(docs, shares, recentViews);
  const shareRows = shares
    .map((s) => toShareRow(s))
    // newest shares first by id (createdAt monotonic with id).
    .sort((a, b) => b.id - a.id);
  // listUsers returns newest-first. The role chip is read from the stored role
  // column (multi-admin model v2) — pass undefined as adminEmail so toUserRow
  // uses the stored column without any ADMIN_EMAIL override.
  const userRows = users.map((u) =>
    toUserRow(
      u,
      principal,
      undefined,
      (emailsByUser.get(u.id) ?? []).map((e) => ({ email: e.email, primary: e.primary })),
    ),
  );
  // Candidate users for the access-request approve picker (id + display name).
  const userOptions = users.map((u) => ({ id: u.id, displayName: u.displayName }));
  const accessRequestRows = accessRequests.map((r) => toAccessRequestRow(r));

  const statTiles = [
    { label: "published docs", value: stats.publishedDocs },
    { label: "active shares", value: stats.activeShares },
    { label: "members", value: userRows.length },
    { label: "views · 7 days", value: stats.recentViews },
  ];

  return (
    <div style={{ maxWidth: 1180, margin: "0 auto", padding: "26px 20px 90px" }}>
      {/* ── access requests (top; renders only when there are pending) ── */}
      <AccessRequests rows={accessRequestRows} userOptions={userOptions} />

      {/* ── stats tiles ── */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
          gap: 10,
          marginBottom: 26,
        }}
      >
        {statTiles.map((s) => (
          <div
            key={s.label}
            style={{
              border: "1px solid var(--hairline)",
              borderRadius: 10,
              background: "var(--surface)",
              padding: "12px 14px",
            }}
          >
            <div style={{ ...tableHead, marginBottom: 5 }}>{s.label}</div>
            <div
              style={{
                fontSize: 20,
                fontWeight: 600,
                letterSpacing: "-0.01em",
                color: "var(--ink)",
              }}
            >
              {s.value}
            </div>
          </div>
        ))}
      </div>

      {/* ── users ── */}
      <section style={{ marginBottom: 30 }}>
        <h2 style={sectionH2}>
          Users{" "}
          <span style={{ fontWeight: 400, color: "var(--faint)", fontSize: 11.5 }}>
            · humans (email) &amp; agents (service-token Client ID)
          </span>
        </h2>
        <div
          style={{
            border: "1px solid var(--hairline)",
            borderRadius: 10,
            background: "var(--surface)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1.2fr 1.3fr 1fr 0.7fr 0.8fr 0.8fr 1fr",
              padding: "8px 14px",
              borderBottom: "1px solid var(--hairline)",
              background: "var(--surface-alt)",
              ...tableHead,
            }}
          >
            <span>name</span>
            <span>email</span>
            <span>token</span>
            <span>role</span>
            <span>state</span>
            <span>created</span>
            <span style={{ justifySelf: "end" }}>actions</span>
          </div>
          {userRows.length === 0 ? (
            <div style={{ padding: "24px 14px", fontSize: 12.5, color: "var(--muted)" }}>
              No users yet — add the first one below.
            </div>
          ) : (
            userRows.map((u) => <UserRow key={u.id} row={u} />)
          )}
        </div>
        <AddUser />
      </section>

      {/* ── shares + view log ── */}
      <section style={{ marginBottom: 30 }}>
        <h2 style={sectionH2}>Shares</h2>
        <div
          style={{
            border: "1px solid var(--hairline)",
            borderRadius: 10,
            background: "var(--surface)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1.4fr 1.1fr 0.8fr 0.8fr 0.5fr 0.6fr",
              padding: "8px 14px",
              borderBottom: "1px solid var(--hairline)",
              background: "var(--surface-alt)",
              ...tableHead,
            }}
          >
            <span>label</span>
            <span>scope</span>
            <span>expires</span>
            <span>last view</span>
            <span style={{ justifySelf: "end" }}>views</span>
            <span />
          </div>
          {shareRows.length === 0 ? (
            <div style={{ padding: "24px 14px", fontSize: 12.5, color: "var(--muted)" }}>
              No shares yet — create one from a doc&rsquo;s Share action.
            </div>
          ) : (
            shareRows.map((row) => <ShareRow key={row.id} row={row} />)
          )}
        </div>
        <div style={{ fontSize: 11.5, color: "var(--faint)", marginTop: 8 }}>
          Revocation is a DB row — links die instantly, indistinguishable from
          never-existed. Expand a row for its view log.
        </div>
      </section>

      {/* ── docs & versions ── */}
      <section style={{ marginBottom: 30 }}>
        <h2 style={sectionH2}>Published docs</h2>
        <div
          style={{
            border: "1px solid var(--hairline)",
            borderRadius: 10,
            background: "var(--surface)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1.3fr 0.7fr 0.9fr 0.7fr 0.8fr",
              padding: "8px 14px",
              borderBottom: "1px solid var(--hairline)",
              background: "var(--surface-alt)",
              ...tableHead,
            }}
          >
            <span>slug</span>
            <span>versions</span>
            <span>updated</span>
            <span>state</span>
            <span />
          </div>
          {docs.length === 0 ? (
            <div style={{ padding: "24px 14px", fontSize: 12.5, color: "var(--muted)" }}>
              Nothing published yet.
            </div>
          ) : (
            docs.map((d) => {
              const unpublished = d.unpublishedAt !== null;
              return (
                <div
                  key={d.slug}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1.3fr 0.7fr 0.9fr 0.7fr 0.8fr",
                    padding: "8px 14px",
                    borderBottom: "1px solid var(--hairline)",
                    alignItems: "center",
                    opacity: unpublished ? 0.55 : 1,
                  }}
                >
                  <Link
                    href={`/docs/${d.slug}`}
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 11.5,
                      fontWeight: 500,
                      color: "var(--ink)",
                      textDecoration: "none",
                    }}
                  >
                    {d.slug}
                  </Link>
                  <span
                    style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--muted)" }}
                  >
                    {d.versionCount}
                  </span>
                  <span
                    style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--muted)" }}
                  >
                    {dateStamp(d.updatedAt)}
                  </span>
                  <span
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 10,
                      color: unpublished ? "var(--warn-ink)" : "var(--faint)",
                    }}
                  >
                    {unpublished ? "unpublished" : "published"}
                  </span>
                  {unpublished ? (
                    <span
                      style={{
                        justifySelf: "end",
                        fontFamily: "var(--font-mono)",
                        fontSize: 10,
                        color: "var(--faint)",
                      }}
                    >
                      —
                    </span>
                  ) : (
                    <DocUnpublish slug={d.slug} />
                  )}
                </div>
              );
            })
          )}
        </div>
      </section>

      {/* ── instance settings: GitHub mirror PAT (Slice 4c, D-C5) ── */}
      <section style={{ marginBottom: 30 }}>
        <h2 style={sectionH2}>GitHub mirror PAT</h2>
        <GithubPatSettings initialConfigured={githubPatConfigured} />
        <div style={{ fontSize: 11.5, color: "var(--faint)", marginTop: 8 }}>
          Instance-wide credential for mirroring `hosted` spaces&rsquo; `main` out to GitHub (see{" "}
          <span style={{ fontFamily: "var(--font-mono)" }}>docs/remotes.md</span>). Per-space mode, remote
          URL, and an optional deploy-key override live on each space&rsquo;s settings page.
        </div>
      </section>

      {/* ── service-token note (the Users table now lists token users) ── */}
      <section>
        <div style={{ fontSize: 11.5, color: "var(--faint)", lineHeight: 1.5 }}>
          Service-token agents appear in the Users table above (token column). The
          tokens themselves are issued &amp; rotated in Cloudflare (Zero Trust →
          Access → Service Auth) — Desk only maps a token&rsquo;s Client ID to a
          role.
        </div>
      </section>
    </div>
  );
}
