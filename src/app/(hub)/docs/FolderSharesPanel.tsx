"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export type FolderShareRow = {
  id: number;
  label: string;
  pathPrefix: string;
  status: "active" | "revoked" | "expired";
  created: string; // YYYY-MM-DD
  expires: string; // "never" | "expired" | YYYY-MM-DD
  lastView: string; // "—" | YYYY-MM-DD
  viewCount: number;
  allowComments: boolean;
  canRevoke: boolean;
  canCopy: boolean;
};

const statusStyle: Record<FolderShareRow["status"], { fg: string; label: string }> = {
  active: { fg: "var(--ok-ink, var(--accent))", label: "active" },
  revoked: { fg: "var(--danger-ink)", label: "revoked" },
  expired: { fg: "var(--faint)", label: "expired" },
};

function Row({ row }: { row: FolderShareRow }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [allowComments, setAllowComments] = useState(row.allowComments);
  const [busy, setBusy] = useState(false);
  const [copying, setCopying] = useState(false);
  const [copySuccess, setCopySuccess] = useState(false);
  const st = statusStyle[row.status];
  const cell = { fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--muted)" } as const;

  async function copyLink() {
    setCopying(true);
    setCopySuccess(false);
    setError(null);
    try {
      const res = await fetch(`/api/shares/${row.id}/reveal`);
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
      setError("Could not copy to clipboard.");
    } finally {
      setCopying(false);
    }
  }

  async function revoke() {
    if (!window.confirm(`Revoke "${row.label}"? Every doc under ${row.pathPrefix}/ 404s instantly for anyone who has the link.`)) return;
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/shares/${row.id}/revoke`, { method: "POST" });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? `Revoke failed (${res.status})`);
        return;
      }
      router.refresh();
    } catch {
      setError("Network error — share not revoked.");
    } finally {
      setBusy(false);
    }
  }

  async function deleteShare() {
    if (!window.confirm(`Permanently remove "${row.label}" from the link list?\n\nThis cannot be undone.`)) return;
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/shares/${row.id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? `Delete failed (${res.status})`);
        return;
      }
      router.refresh();
    } catch {
      setError("Network error — share not deleted.");
    } finally {
      setBusy(false);
    }
  }

  async function toggleComments() {
    const next = !allowComments;
    setAllowComments(next); // optimistic
    setError(null);
    try {
      const res = await fetch(`/api/shares/${row.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ allowComments: next }),
      });
      if (!res.ok) {
        setAllowComments(!next);
        setError(`Could not update comments setting (${res.status})`);
      }
    } catch {
      setAllowComments(!next);
      setError("Network error — comments setting unchanged.");
    }
  }

  const actionBtn = {
    fontSize: 11,
    fontWeight: 500,
    padding: "3px 10px",
    borderRadius: 6,
    cursor: "pointer",
    fontFamily: "var(--font-sans)",
  } as const;

  return (
    <>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1.4fr 1fr 0.8fr 0.8fr 0.7fr 0.5fr 0.6fr 0.45fr 0.55fr",
          gap: 10,
          padding: "9px 14px",
          borderBottom: "1px solid var(--hairline)",
          alignItems: "center",
          opacity: row.status === "active" ? 1 : 0.55,
        }}
      >
        <span style={{ fontSize: 12.5, fontWeight: 500, color: "var(--ink)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {row.label}
        </span>
        <span
          title={`Directory share — ${row.pathPrefix}/`}
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            padding: "2px 7px",
            borderRadius: 4,
            color: "var(--ref-ink, var(--accent))",
            border: "1px solid var(--hairline)",
            justifySelf: "start",
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          folder · {row.pathPrefix}/
        </span>
        <span style={cell}>{row.created}</span>
        <span style={cell}>{row.expires}</span>
        <span style={cell}>{row.lastView}</span>
        <span style={{ ...cell, justifySelf: "end" }}>{row.viewCount}</span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            letterSpacing: "0.04em",
            textTransform: "uppercase",
            color: st.fg,
          }}
        >
          {st.label}
        </span>

        {/* Copy link */}
        <span style={{ justifySelf: "end" }}>
          {row.canCopy ? (
            <button
              type="button"
              onClick={copyLink}
              disabled={copying}
              title="Copy the folder share link URL to clipboard"
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
            <span style={{ ...cell, fontSize: 10, opacity: 0.5 }}>—</span>
          )}
        </span>

        {/* Revoke (active) or Delete (revoked/expired) */}
        {row.canRevoke ? (
          <button
            type="button"
            onClick={revoke}
            disabled={busy}
            style={{
              ...actionBtn,
              justifySelf: "end",
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
              justifySelf: "end",
              border: "1px solid var(--hairline)",
              background: "transparent",
              color: "var(--faint)",
            }}
          >
            {busy ? "…" : "delete"}
          </button>
        )}
      </div>

      {row.status === "active" && (
        <div
          style={{
            padding: "0 14px 9px",
            borderBottom: "1px solid var(--hairline)",
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 12,
          }}
        >
          <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
            <input type="checkbox" checked={allowComments} onChange={toggleComments} />
            Allow comments folder-wide
          </label>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--faint)" }}>
            {allowComments ? "on" : "off"}
          </span>
        </div>
      )}

      {error && (
        <div style={{ padding: "4px 14px 8px", borderBottom: "1px solid var(--hairline)", fontSize: 11.5, color: "var(--danger-ink)" }}>
          {error}
        </div>
      )}
    </>
  );
}

/**
 * Admin "Folder shares" disclosure on the docs page — the home for directory
 * shares (the per-doc Sharing panel is doc-scoped, so dir shares need their own
 * surface). Collapsed disclosure with a `folder · <prefix>/` chip per row, view
 * count, copy link, revoke (stage 1), delete (stage 2), and a folder-wide
 * comments toggle.
 */
export default function FolderSharesPanel({ rows }: { rows: FolderShareRow[] }) {
  const [open, setOpen] = useState(false);
  if (rows.length === 0) return null;
  const activeCount = rows.filter((r) => r.status === "active").length;

  return (
    <div style={{ marginTop: 28, border: "1px solid var(--hairline)", borderRadius: 12, overflow: "hidden" }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "12px 16px",
          background: "var(--surface)",
          border: "none",
          cursor: "pointer",
          textAlign: "left",
          color: "var(--ink)",
          fontFamily: "var(--font-sans)",
        }}
      >
        <span aria-hidden style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--faint)" }}>
          {open ? "▾" : "▸"}
        </span>
        <span style={{ fontSize: 13.5, fontWeight: 600 }}>Folder shares</span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--faint)" }}>
          {rows.length} {rows.length === 1 ? "link" : "links"}
          {activeCount !== rows.length ? ` · ${activeCount} active` : ""}
        </span>
      </button>
      {open && (
        <div>
          {rows.map((r) => (
            <Row key={r.id} row={r} />
          ))}
        </div>
      )}
    </div>
  );
}
