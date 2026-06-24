"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

/**
 * Proposals (PR) review panel (External Collaboration, E2). Lists a space's
 * `proposals/*` refs and — for an owner/admin (`canDecide`) — offers a unified
 * diff view + Accept (merge → main + reindex + delete ref) / Reject (delete
 * ref). A writer sees the list read-only.
 *
 * SECURITY: the diff `patch` is git output rendered as ESCAPED text (a <pre>
 * text node — React escapes), never an HTML sink. Accept/Reject hit the
 * owner/admin-gated REST routes; the panel hides the buttons for a non-decider
 * but the server is the real gate.
 */
export type ProposalRow = {
  name: string;
  ref: string;
  tipSha: string;
  pusher: string;
  subject: string;
  createdAt: string;
};

export default function ProposalsPanel({
  slug,
  proposals,
  canDecide,
}: {
  slug: string;
  proposals: ProposalRow[];
  canDecide: boolean;
}) {
  if (proposals.length === 0) {
    return (
      <p style={{ fontSize: 13, color: "var(--faint)", margin: 0 }}>
        No open proposals. Under the <strong>proposal</strong> push policy, a
        non-owner writer&rsquo;s push to <code>proposals/&lt;name&gt;</code> shows
        up here as a PR to review.
      </p>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {proposals.map((p) => (
        <ProposalCard key={p.ref} slug={slug} proposal={p} canDecide={canDecide} />
      ))}
    </div>
  );
}

function ProposalCard({
  slug,
  proposal,
  canDecide,
}: {
  slug: string;
  proposal: ProposalRow;
  canDecide: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [expanded, setExpanded] = useState(false);
  const [diff, setDiff] = useState<{ patch: string; files: { path: string; status: string }[] } | null>(null);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Single-segment encode: the REST proposal routes take `[name]` as one path
  // segment, so a nested name (proposals/a/b) is encoded whole (a%2Fb). The
  // common flow is a single-segment name (the setup prompt suggests
  // `proposals/<you>`); deeply-nested names are also decidable via the MCP
  // `decide_proposal` tool (no path-segment limit there).
  const nameEnc = encodeURIComponent(proposal.name);

  async function loadDiff() {
    if (diff) {
      setExpanded((v) => !v);
      return;
    }
    setLoadingDiff(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/spaces/${slug}/proposals/${nameEnc}/diff`,
      );
      if (!res.ok) {
        setError(`Could not load diff (${res.status})`);
        return;
      }
      const data = (await res.json()) as { patch: string; files: { path: string; status: string }[] };
      setDiff(data);
      setExpanded(true);
    } catch {
      setError("Network error loading diff.");
    } finally {
      setLoadingDiff(false);
    }
  }

  async function decide(action: "accept" | "reject") {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/spaces/${slug}/proposals/${nameEnc}/${action}`, {
        method: "POST",
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? `${action} failed (${res.status})`);
        setBusy(false);
        return;
      }
      startTransition(() => router.refresh());
    } catch {
      setError(`Network error — ${action} did not complete.`);
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        border: "1px solid var(--hairline)",
        borderRadius: 10,
        padding: "12px 14px",
        background: "var(--surface-alt)",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <code style={{ fontSize: 13, fontWeight: 600 }}>proposals/{proposal.name}</code>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--faint)" }}>
          {proposal.tipSha.slice(0, 8)}
        </span>
        <span style={{ fontSize: 11.5, color: "var(--muted)" }}>by {proposal.pusher}</span>
      </div>
      {proposal.subject && (
        <p style={{ margin: "6px 0 0", fontSize: 13, color: "var(--ink)" }}>{proposal.subject}</p>
      )}
      <div style={{ display: "flex", gap: 12, marginTop: 10, alignItems: "center" }}>
        <button
          type="button"
          onClick={() => void loadDiff()}
          disabled={loadingDiff}
          style={linkBtn}
        >
          {loadingDiff ? "Loading…" : expanded ? "Hide diff" : "View diff"}
        </button>
        {canDecide && (
          <>
            <button
              type="button"
              onClick={() => void decide("accept")}
              disabled={busy || pending}
              style={acceptBtn}
            >
              Accept &amp; merge
            </button>
            <button
              type="button"
              onClick={() => void decide("reject")}
              disabled={busy || pending}
              style={rejectBtn}
            >
              Reject
            </button>
          </>
        )}
      </div>
      {error && <p style={{ margin: "8px 0 0", fontSize: 11.5, color: "var(--danger-ink)" }}>{error}</p>}
      {expanded && diff && (
        <div style={{ marginTop: 10 }}>
          {diff.files.length > 0 && (
            <ul style={{ margin: "0 0 8px", paddingLeft: 18, fontSize: 12, color: "var(--muted)" }}>
              {diff.files.map((f) => (
                <li key={f.path}>
                  <span style={{ fontFamily: "var(--font-mono)" }}>{f.status}</span> {f.path}
                </li>
              ))}
            </ul>
          )}
          <pre
            style={{
              margin: 0,
              padding: 12,
              fontSize: 11.5,
              fontFamily: "var(--font-mono)",
              background: "var(--surface)",
              border: "1px solid var(--hairline)",
              borderRadius: 8,
              overflowX: "auto",
              whiteSpace: "pre",
              maxHeight: 360,
            }}
          >
            {diff.patch || "(no textual diff)"}
          </pre>
        </div>
      )}
    </div>
  );
}

const linkBtn = {
  background: "none",
  border: "none",
  padding: 0,
  cursor: "pointer",
  fontSize: 12.5,
  color: "var(--accent)",
} as const;

const acceptBtn = {
  fontSize: 12.5,
  padding: "5px 12px",
  borderRadius: 8,
  border: "1px solid var(--hairline-strong)",
  background: "var(--surface)",
  color: "var(--ink)",
  cursor: "pointer",
} as const;

const rejectBtn = {
  ...acceptBtn,
  color: "var(--danger-ink)",
} as const;
