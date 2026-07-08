"use client";

import { useState } from "react";

/**
 * Owner/admin invite panel (External Collaboration, E1): mint a capability-link
 * invite for this space at a writer|reader role. POSTs to
 * /api/spaces/[owner]/[slug]/invites and shows the one-time invite URL (the raw
 * token appears once; we never re-fetch it). Send that URL to the external
 * partner — opening it lets them self-serve into the space.
 */
type Role = "writer" | "reader";

const codeBlock: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 12.5,
  lineHeight: 1.6,
  background: "var(--surface-alt)",
  border: "1px solid var(--hairline)",
  borderRadius: 8,
  padding: "10px 12px",
  whiteSpace: "pre-wrap",
  wordBreak: "break-all",
  color: "var(--ink)",
  margin: "10px 0 0",
};

export default function InvitePanel({ owner, slug }: { owner: string; slug: string }) {
  const [role, setRole] = useState<Role>("writer");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function mint() {
    setError(null);
    setInviteUrl(null);
    setPending(true);
    try {
      const res = await fetch(`/api/spaces/${owner}/${slug}/invites`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? `Could not mint invite (${res.status}).`);
        return;
      }
      const data = (await res.json()) as { inviteUrl: string };
      setInviteUrl(data.inviteUrl);
    } catch {
      setError("Network error — invite not created.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <select
          aria-label="Invite role"
          value={role}
          onChange={(e) => setRole(e.target.value as Role)}
          disabled={pending}
          style={{
            fontSize: 13,
            fontFamily: "var(--font-sans)",
            padding: "6px 10px",
            borderRadius: 8,
            border: "1px solid var(--hairline-strong)",
            background: "var(--surface-alt)",
            color: "var(--ink)",
          }}
        >
          <option value="writer">writer (clone + push)</option>
          <option value="reader">reader (clone only)</option>
        </select>
        <button
          type="button"
          onClick={() => void mint()}
          disabled={pending}
          style={{
            fontSize: 13,
            fontWeight: 500,
            padding: "6px 14px",
            borderRadius: 8,
            border: "1px solid var(--hairline-strong)",
            background: "var(--surface-alt)",
            color: "var(--ink)",
            cursor: pending ? "default" : "pointer",
          }}
        >
          {pending ? "Minting…" : "Create invite link"}
        </button>
      </div>
      <p style={{ fontSize: 12, color: "var(--faint)", margin: "6px 0 0" }}>
        Send the link to an external partner — opening it lets them self-serve into
        this space. The link is shown once.
      </p>
      {inviteUrl && (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 12 }}>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--faint)" }}>
              invite link (shown once)
            </span>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(inviteUrl).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                });
              }}
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                padding: "4px 10px",
                borderRadius: 6,
                border: "1px solid var(--hairline-strong)",
                background: "var(--surface-alt)",
                color: "var(--muted)",
                cursor: "pointer",
              }}
            >
              {copied ? "copied" : "copy"}
            </button>
          </div>
          <div style={codeBlock}>{inviteUrl}</div>
        </>
      )}
      {error && <p style={{ margin: "10px 0 0", fontSize: 11.5, color: "var(--danger-ink)" }}>{error}</p>}
    </div>
  );
}
