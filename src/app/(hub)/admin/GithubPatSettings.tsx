"use client";

import { useState } from "react";

const inputStyle = {
  fontSize: 12.5,
  fontFamily: "var(--font-mono)",
  padding: "6px 9px",
  borderRadius: 6,
  border: "1px solid var(--hairline-strong)",
  background: "var(--surface)",
  color: "var(--ink)",
  width: "100%",
} as const;

/**
 * Admin-only instance GitHub mirror PAT control (convergence fix-pass, Slice
 * 4c; decision D-C5). Set / replace / clear only — the server NEVER returns
 * the PAT value (`/api/settings/github-pat` responses carry a boolean
 * `configured` only), so this component shows "configured ✓ / not configured"
 * from the initial server-rendered prop and never round-trips the value back.
 */
export default function GithubPatSettings({ initialConfigured }: { initialConfigured: boolean }) {
  const [configured, setConfigured] = useState(initialConfigured);
  const [pat, setPat] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (pat.trim().length === 0) return;
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/settings/github-pat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pat }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(d?.error ?? `Save failed (${res.status})`);
        return;
      }
      setConfigured(true);
      setPat("");
    } catch {
      setError("Network error — PAT unchanged.");
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/settings/github-pat", { method: "DELETE" });
      if (!res.ok) {
        const d = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(d?.error ?? `Clear failed (${res.status})`);
        return;
      }
      setConfigured(false);
    } catch {
      setError("Network error — PAT unchanged.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        border: "1px solid var(--hairline)",
        borderRadius: 10,
        background: "var(--surface)",
        padding: "14px 16px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            padding: "3px 10px",
            borderRadius: 999,
            border: "1px solid var(--hairline)",
            background: configured ? "var(--accent-ring)" : "var(--surface-alt)",
            color: configured ? "var(--accent)" : "var(--faint)",
          }}
        >
          {configured ? "configured ✓" : "not configured"}
        </span>
        <span style={{ fontSize: 12, color: "var(--faint)" }}>
          A fine-grained GitHub PAT (Contents: Read/Write) used to mirror `hosted` spaces&rsquo; `main` out to
          GitHub. Write-only — never shown again once saved.
        </span>
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          type="password"
          aria-label="GitHub PAT"
          value={pat}
          onChange={(e) => setPat(e.target.value)}
          placeholder="github_pat_…"
          disabled={busy}
          style={{ ...inputStyle, flex: 1 }}
        />
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy || pat.trim().length === 0}
          style={{
            fontSize: 12.5,
            fontWeight: 500,
            padding: "7px 14px",
            borderRadius: 6,
            border: "1px solid var(--accent)",
            background: "var(--accent)",
            color: "#fff",
            cursor: busy ? "default" : "pointer",
            opacity: busy || pat.trim().length === 0 ? 0.6 : 1,
            fontFamily: "var(--font-sans)",
            whiteSpace: "nowrap",
          }}
        >
          {configured ? "replace" : "save"}
        </button>
        {configured && (
          <button
            type="button"
            onClick={() => void clear()}
            disabled={busy}
            style={{
              fontSize: 12.5,
              fontWeight: 500,
              padding: "7px 14px",
              borderRadius: 6,
              border: "1px solid var(--hairline)",
              background: "var(--surface)",
              color: "var(--danger-ink)",
              cursor: busy ? "default" : "pointer",
              opacity: busy ? 0.6 : 1,
              fontFamily: "var(--font-sans)",
              whiteSpace: "nowrap",
            }}
          >
            clear
          </button>
        )}
      </div>
      {error && <div style={{ marginTop: 8, fontSize: 11.5, color: "var(--danger-ink)" }}>{error}</div>}
    </div>
  );
}
