"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * Client island for the copy / revoke / delete controls on the Distribution
 * links table. Kept small — all it does is fire the same admin REST endpoints
 * the per-doc share panel uses.
 */
export default function DistLinkActions({
  id,
  canCopy,
  status,
  label,
}: {
  id: number;
  canCopy: boolean;
  status: "active" | "revoked" | "expired";
  label: string;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [copying, setCopying] = useState(false);
  const [copySuccess, setCopySuccess] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const actionBtn = {
    fontSize: 11,
    fontWeight: 500,
    padding: "3px 9px",
    borderRadius: 6,
    cursor: "pointer",
    fontFamily: "var(--font-sans)",
  } as const;

  async function copyLink() {
    setCopying(true);
    setCopySuccess(false);
    setError(null);
    try {
      const res = await fetch(`/api/shares/${id}/reveal`);
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? `Could not retrieve link (${res.status})`);
        return;
      }
      const { url } = (await res.json()) as { url: string };
      await navigator.clipboard.writeText(url);
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2000);
    } catch {
      setError("Clipboard unavailable.");
    } finally {
      setCopying(false);
    }
  }

  async function revoke() {
    if (!window.confirm(`Revoke "${label}"? The link dies instantly.`)) return;
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/shares/${id}/revoke`, { method: "POST" });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? `Revoke failed (${res.status})`);
        return;
      }
      startTransition(() => router.refresh());
    } catch {
      setError("Network error.");
    } finally {
      setBusy(false);
    }
  }

  async function deleteShare() {
    if (!window.confirm(`Permanently remove "${label}" from the link list?\n\nThis cannot be undone.`)) return;
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/shares/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? `Delete failed (${res.status})`);
        return;
      }
      startTransition(() => router.refresh());
    } catch {
      setError("Network error.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {/* Copy column */}
      <span style={{ justifySelf: "end" }}>
        {canCopy ? (
          <button
            type="button"
            onClick={copyLink}
            disabled={copying}
            title="Copy share link URL to clipboard"
            style={{
              ...actionBtn,
              border: "1px solid var(--hairline)",
              background: copySuccess ? "var(--ok-bg, var(--surface-alt))" : "var(--surface)",
              color: copySuccess ? "var(--ok-ink, var(--accent))" : "var(--muted)",
            }}
          >
            {copying ? "…" : copySuccess ? "copied!" : "copy"}
          </button>
        ) : (
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--faint)", opacity: 0.5 }}>—</span>
        )}
      </span>

      {/* Revoke or Delete column */}
      <span style={{ justifySelf: "end" }}>
        {status === "active" ? (
          <button
            type="button"
            onClick={revoke}
            disabled={busy}
            style={{
              ...actionBtn,
              border: "1px solid var(--danger-border)",
              background: "transparent",
              color: "var(--danger-ink)",
            }}
          >
            {busy ? "…" : "revoke"}
          </button>
        ) : (
          <button
            type="button"
            onClick={deleteShare}
            disabled={busy}
            title="Permanently removes this link record"
            style={{
              ...actionBtn,
              border: "1px solid var(--hairline)",
              background: "transparent",
              color: "var(--faint)",
            }}
          >
            {busy ? "…" : "delete"}
          </button>
        )}
      </span>

      {error && (
        <div
          style={{
            gridColumn: "1 / -1",
            fontSize: 11,
            color: "var(--danger-ink)",
            paddingTop: 4,
          }}
        >
          {error}
        </div>
      )}
    </>
  );
}
