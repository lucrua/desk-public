import { headers } from "next/headers";
import Link from "next/link";
import { getPrincipal } from "@/lib/auth";
import ThemeToggle from "@/components/ThemeToggle";
import HubNav from "./HubNav";
import DevSwitcher from "@/components/DevSwitcher";
import { listUsers } from "@/lib/users";
import { listOpenRevisions } from "@/lib/revisions";

// Operator surfaces are private and per-request — never statically cached.
export const dynamic = "force-dynamic";

// ── pending (anonymous) screen ──────────────────────────────────────────────────
// Polite, calm full-page state. No nav, no children — the layout refuses to
// render anything operator-facing for an unauthenticated principal.

/**
 * Derive the "who to contact" label from actual active admin rows. Shows the
 * first admin's display name (+ email when present) so new visitors know who
 * to ask. Falls back to "the workspace admin" when no admin row exists yet
 * (brand-new deploy before first login).
 */
async function grantContact(): Promise<string> {
  try {
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

/**
 * Host shown in the pending-screen footer, derived from HUB_BASE_URL. Returns
 * null when unset/invalid so the footer line renders nothing rather than a
 * broken or hardcoded value.
 */
function hubHost(): string | null {
  const raw = process.env.HUB_BASE_URL?.trim();
  if (!raw) return null;
  try {
    return new URL(raw).host || null;
  } catch {
    return null;
  }
}

async function PendingScreen({ showSwitcher }: { showSwitcher: boolean }) {
  const contact = await grantContact();
  const host = hubHost();
  return (
    <div
      style={{
        minHeight: "100vh",
        background: "var(--bg)",
        color: "var(--ink)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px",
      }}
    >
      <div
        style={{
          maxWidth: 420,
          textAlign: "center",
          border: "1px solid var(--hairline)",
          background: "var(--surface)",
          borderRadius: 14,
          padding: "40px 32px",
        }}
      >
        <span
          style={{
            display: "inline-block",
            width: 10,
            height: 10,
            background: "var(--accent)",
            borderRadius: 2,
            marginBottom: 18,
          }}
        />
        <h1
          style={{
            fontSize: 18,
            fontWeight: 600,
            letterSpacing: "-0.01em",
            margin: "0 0 10px",
          }}
        >
          Access pending
        </h1>
        <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6, color: "var(--muted)" }}>
          This is the Desk — an internal workspace. You&rsquo;re not signed in
          with an account that can see it yet. Ask {contact}{" "}to grant access, and
          this page will open up once you&rsquo;re added. Your request has been noted.
        </p>
        {host && (
          <p
            style={{
              margin: "18px 0 0",
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: "var(--faint)",
            }}
          >
            {host}
          </p>
        )}
      </div>
      {showSwitcher && <DevSwitcher current="anonymous" />}
    </div>
  );
}

// ── top bar ─────────────────────────────────────────────────────────────────────

export default async function HubLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const principal = await getPrincipal(await headers());
  const showSwitcher = process.env.AUTH_MODE !== "cloudflare";

  if (principal.kind === "anonymous") {
    return <PendingScreen showSwitcher={showSwitcher} />;
  }

  const isAdmin = principal.kind === "admin";

  // Count open revisions visible to this principal for the Approvals nav badge.
  let approvalCount = 0;
  try {
    if (principal.kind === "admin") {
      const open = await listOpenRevisions();
      approvalCount = open.length;
    } else if (principal.kind === "member" && principal.userId != null) {
      const open = await listOpenRevisions({ ownerUserId: principal.userId });
      approvalCount = open.length;
    }
  } catch {
    // Non-fatal — badge just won't show.
  }

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", color: "var(--ink)" }}>
      <header
        style={{
          height: 50,
          borderBottom: "1px solid var(--hairline)",
          background: "var(--surface)",
          display: "flex",
          alignItems: "center",
          padding: "0 20px",
          gap: 24,
          position: "sticky",
          top: 0,
          zIndex: 30,
        }}
      >
        <Link
          href="/spaces"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            textDecoration: "none",
            color: "var(--ink)",
          }}
        >
          <span
            style={{
              width: 10,
              height: 10,
              background: "var(--accent)",
              borderRadius: 2,
              display: "inline-block",
            }}
          />
          <span style={{ fontWeight: 600, fontSize: 13.5, letterSpacing: "-0.01em" }}>
            Desk
          </span>
        </Link>

        {/* Principal name chip — top-left, immediately after the wordmark. Links
            to /me with a nav-link hover affordance. */}
        <Link
          href="/me"
          title={`Signed in as ${principal.name} (${principal.kind}) — view your account`}
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            padding: "4px 10px",
            borderRadius: 999,
            border: "1px solid var(--hairline)",
            background: "var(--surface-alt)",
            color: "var(--muted)",
            whiteSpace: "nowrap",
            textDecoration: "none",
          }}
        >
          {principal.name}
        </Link>

        <HubNav isAdmin={isAdmin} approvalCount={approvalCount} />

        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <ThemeToggle />
          {!showSwitcher && (
            /* Cloudflare Access owns the session; its edge-handled logout
               endpoint is the only way to sign out. Hidden in dev mode
               (no CF in the path — the DevSwitcher covers identity there). */
            <a
              href="/cdn-cgi/access/logout"
              title="Sign out — ends your Cloudflare Access session on this domain"
              style={{
                fontSize: 12.5,
                color: "var(--muted)",
                textDecoration: "none",
                padding: "5px 10px",
                borderRadius: 6,
                border: "1px solid var(--hairline)",
              }}
            >
              Sign out
            </a>
          )}
        </div>
      </header>

      <main>{children}</main>

      {showSwitcher && <DevSwitcher current={principal.kind} />}
    </div>
  );
}
