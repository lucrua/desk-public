import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getPrincipal, isStaff } from "@/lib/auth";
import { listOpenRevisions } from "@/lib/revisions";
import { canSeeApprovalQueueItem } from "@/lib/permissions";

export const dynamic = "force-dynamic";

/**
 * Central approval queue — /approvals.
 *
 * Admin: sees all open revisions across every doc.
 * Owner (member who owns at least one doc with open revisions): sees only their docs.
 * Plain member with no owned docs: redirected to /docs (forbidden).
 *
 * Each row shows: doc title (linked to the doc page), proposer, age, and a
 * Review link that goes to the doc page where the per-doc Revisions panel lives.
 */

const SANS = "'Helvetica Neue', Helvetica, Arial, system-ui, sans-serif";
const MONO = "'JetBrains Mono', 'SFMono-Regular', Menlo, monospace";

function relativeTime(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

export default async function ApprovalsPage() {
  const principal = await getPrincipal(await headers());
  if (!isStaff(principal)) redirect("/docs");

  // Admins see all; members see only their owned docs.
  let revisions;
  if (principal.kind === "admin") {
    revisions = await listOpenRevisions();
  } else {
    if (principal.userId == null) redirect("/docs");
    revisions = await listOpenRevisions({ ownerUserId: principal.userId });
  }

  // Filter to only items this principal is allowed to see (defence-in-depth).
  const visible = revisions.filter((r) =>
    canSeeApprovalQueueItem(principal, { ownerUserId: r.docOwnerUserId }),
  );

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: "32px 20px 96px" }}>
      <header style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 24, fontWeight: 600, letterSpacing: "-0.01em", margin: "0 0 6px" }}>
          Approvals
        </h1>
        <p style={{ fontSize: 13.5, color: "var(--muted)", margin: 0, fontFamily: SANS, lineHeight: 1.6 }}>
          {principal.kind === "admin"
            ? "All open revision proposals across every doc. Accept or reject from each doc's page."
            : "Open proposals on docs you own. Accept or reject from each doc's page."}
        </p>
      </header>

      {visible.length === 0 ? (
        <div
          style={{
            border: "1px solid var(--hairline)",
            borderRadius: 12,
            background: "var(--surface)",
            padding: "40px 24px",
            textAlign: "center",
          }}
        >
          <p style={{ fontSize: 14, color: "var(--muted)", margin: 0, fontFamily: SANS }}>
            No open proposals right now.
          </p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
          {/* Header row */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 140px 100px 80px",
              gap: 12,
              padding: "8px 16px",
              borderRadius: "8px 8px 0 0",
              background: "var(--surface-alt)",
              border: "1px solid var(--hairline)",
              borderBottom: "none",
            }}
          >
            {["Doc", "Proposed by", "When", ""].map((h) => (
              <span
                key={h}
                style={{
                  fontFamily: MONO,
                  fontSize: 10,
                  letterSpacing: "0.07em",
                  textTransform: "uppercase",
                  color: "var(--faint)",
                }}
              >
                {h}
              </span>
            ))}
          </div>

          {visible.map((rev, i) => {
            const isLast = i === visible.length - 1;
            return (
              <div
                key={rev.id}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 140px 100px 80px",
                  gap: 12,
                  padding: "13px 16px",
                  background: "var(--surface)",
                  border: "1px solid var(--hairline)",
                  borderTop: "none",
                  borderRadius: isLast ? "0 0 8px 8px" : 0,
                  alignItems: "center",
                }}
              >
                {/* Doc title + slug */}
                <div>
                  <Link
                    href={`/docs/${rev.docSlug}`}
                    style={{
                      fontSize: 13.5,
                      fontWeight: 500,
                      color: "var(--ink)",
                      textDecoration: "none",
                    }}
                  >
                    {rev.docTitle}
                  </Link>
                  <div
                    style={{
                      fontFamily: MONO,
                      fontSize: 10.5,
                      color: "var(--faint)",
                      marginTop: 2,
                    }}
                  >
                    {rev.docSlug}
                  </div>
                  {rev.note && (
                    <div
                      style={{
                        fontSize: 12,
                        color: "var(--muted)",
                        marginTop: 3,
                        fontStyle: "italic",
                        fontFamily: SANS,
                      }}
                    >
                      &ldquo;{rev.note}&rdquo;
                    </div>
                  )}
                </div>

                {/* Proposer */}
                <div style={{ fontSize: 13, color: "var(--ink)", fontFamily: SANS }}>
                  {rev.authorName}
                  <span
                    style={{
                      marginLeft: 6,
                      fontFamily: MONO,
                      fontSize: 9.5,
                      color: "var(--faint)",
                    }}
                  >
                    {rev.authorKind}
                  </span>
                </div>

                {/* When */}
                <div
                  style={{
                    fontSize: 12,
                    color: "var(--muted)",
                    fontFamily: MONO,
                  }}
                  title={rev.createdAt.toISOString()}
                >
                  {relativeTime(rev.createdAt)}
                </div>

                {/* Review link */}
                <Link
                  href={`/docs/${rev.docSlug}`}
                  style={{
                    fontSize: 12.5,
                    fontWeight: 500,
                    color: "var(--accent)",
                    textDecoration: "none",
                    fontFamily: SANS,
                  }}
                >
                  Review →
                </Link>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
