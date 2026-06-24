import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { resolveInvite } from "@/lib/invites/invites";
import AcceptForm from "./AcceptForm";

// Resolve fresh on every request — expiry / revocation / use-cap must take effect
// immediately with no caching in front (mirrors the /s/[token] share page).
export const dynamic = "force-dynamic";

// Neutral metadata — never reveal the space name in an unfurl (the holder of the
// link already knows it; an unfurled link to a third party should not).
export const metadata: Metadata = {
  title: "Desk invite",
  description: "You've been invited to a Desk space.",
};

/**
 * GET /invite/[token] — the PUBLIC invite accept page (share host).
 *
 * Resolves the invite by token; a uniform 404 for invalid/expired/over-limit/
 * revoked/unknown (no signal about which, or whether the email exists). On a live
 * invite it renders "you're invited to <space> as <role>" + the email form
 * (AcceptForm), which POSTs to the accept API and renders the one-time token +
 * setup prompt inline.
 *
 * Reachable on the share host because the SHARE_HOST middleware allow-list admits
 * /invite/* — without that, this 404s on the share host (see host-routing.ts).
 */
export default async function InviteAcceptPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const invite = await resolveInvite(token);
  if (invite === null) notFound();

  const spaceLabel = `${invite.ownerSlug}/${invite.spaceSlug}`;

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "var(--bg)",
        color: "var(--ink)",
        fontFamily: "var(--font-sans)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: "64px 24px",
      }}
    >
      <main
        style={{
          width: "100%",
          maxWidth: 520,
        }}
      >
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            color: "var(--faint)",
            marginBottom: 16,
          }}
        >
          Desk · {invite.role} invite
        </div>
        <AcceptForm token={token} spaceLabel={spaceLabel} />
      </main>
    </div>
  );
}
