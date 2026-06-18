"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { type DocShareRow, gridTemplate } from "./shares-view-model";

const cell = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--muted)",
} as const;

const statusStyle: Record<DocShareRow["status"], { fg: string; label: string }> = {
  active: { fg: "var(--ok-ink, var(--accent))", label: "active" },
  revoked: { fg: "var(--danger-ink)", label: "revoked" },
  expired: { fg: "var(--faint)", label: "expired" },
};

/** Mode chip: "live" borderless quiet / "pinned vN" purple-family fact chip. */
function ModeChip({ chip }: { chip: DocShareRow["modeChip"] }) {
  if (chip.kind === "live") {
    return (
      <span
        title={chip.title}
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          padding: "2px 7px",
          borderRadius: 4,
          color: "var(--muted)",
          border: "1px solid var(--hairline)",
        }}
      >
        live
      </span>
    );
  }
  return (
    <span
      title={chip.title}
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: 10,
        padding: "2px 7px",
        borderRadius: 4,
        background: "var(--pin-bg, var(--badge-bob-bg, var(--surface-alt)))",
        color: "var(--pin-ink, var(--badge-bob-ink, var(--muted)))",
        border: "1px solid var(--pin-border, var(--hairline))",
      }}
    >
      {chip.label}
    </span>
  );
}

/**
 * One row of the per-doc "Share links" table.
 *
 * Admin controls (two-stage lifecycle):
 *   • Copy link — enabled when canCopy; calls GET /api/shares/[id]/reveal, copies
 *     the URL to clipboard, toasts. Disabled when no token_enc (pre-migration) or
 *     for revoked/expired links.
 *   • Revoke — stage 1, for active links. The link dies; row stays listed (dimmed).
 *   • Delete — stage 2, shows in place of Revoke once revoked. Permanently removes
 *     the link record from the list (confirm required).
 *
 * Members see a fully read-only row.
 */
export default function DocShareLinkRow({
  row,
  isAdmin,
}: {
  row: DocShareRow;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [allowComments, setAllowComments] = useState(row.allowComments);
  const [togglingComments, setTogglingComments] = useState(false);
  const [copying, setCopying] = useState(false);
  const [copySuccess, setCopySuccess] = useState(false);

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
    if (
      !window.confirm(
        `Revoke "${row.label}"? The link dies instantly — it 404s for anyone who has it.`,
      )
    ) {
      return;
    }
    setError(null);
    try {
      const res = await fetch(`/api/shares/${row.id}/revoke`, { method: "POST" });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? `Revoke failed (${res.status})`);
        return;
      }
      startTransition(() => router.refresh());
    } catch {
      setError("Network error — share not revoked.");
    }
  }

  async function deleteShare() {
    if (
      !window.confirm(
        `Permanently remove "${row.label}" from the link list?\n\nThis cannot be undone.`,
      )
    ) {
      return;
    }
    setError(null);
    try {
      const res = await fetch(`/api/shares/${row.id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? `Delete failed (${res.status})`);
        return;
      }
      startTransition(() => router.refresh());
    } catch {
      setError("Network error — share not deleted.");
    }
  }

  async function toggleComments() {
    const next = !allowComments;
    setTogglingComments(true);
    setError(null);
    setAllowComments(next); // optimistic
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
    } finally {
      setTogglingComments(false);
    }
  }

  const st = statusStyle[row.status];

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
          gridTemplateColumns: gridTemplate(isAdmin),
          padding: "9px 14px",
          borderBottom: "1px solid var(--hairline)",
          alignItems: "center",
          opacity: row.status === "active" ? 1 : 0.55,
        }}
      >
        <span style={{ fontSize: 12.5, fontWeight: 500, color: "var(--ink)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {row.label}
        </span>
        <span>
          <ModeChip chip={row.modeChip} />
        </span>
        <span style={cell}>{row.created}</span>
        <span style={cell}>{row.expires}</span>
        <span style={{ ...cell, color: row.neverViewed ? "var(--faint)" : "var(--muted)" }}>
          {row.lastView}
        </span>
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

        {/* Copy link button — enabled when canCopy */}
        {isAdmin && (
          <span style={{ justifySelf: "end" }}>
            {row.canCopy ? (
              <button
                type="button"
                onClick={copyLink}
                disabled={copying}
                title="Copy the share link URL to clipboard"
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
              <span
                title={row.status === "active" ? "Link was created before encryption was enabled — URL cannot be retrieved" : "Link is not active"}
                style={{ ...cell, fontSize: 10, opacity: 0.5 }}
              >
                —
              </span>
            )}
          </span>
        )}

        {/* Revoke (active) or Delete (revoked/expired) */}
        {isAdmin && (
          row.canRevoke ? (
            <button
              type="button"
              onClick={revoke}
              disabled={pending}
              style={{
                ...actionBtn,
                justifySelf: "end",
                border: "1px solid var(--danger-border)",
                background: "transparent",
                color: "var(--danger-ink)",
              }}
            >
              {pending ? "…" : "revoke"}
            </button>
          ) : (
            <button
              type="button"
              onClick={deleteShare}
              disabled={pending}
              title="Permanently removes this link record"
              style={{
                ...actionBtn,
                justifySelf: "end",
                border: "1px solid var(--hairline)",
                background: "transparent",
                color: "var(--faint)",
              }}
            >
              {pending ? "…" : "delete"}
            </button>
          )
        )}
      </div>

      {/* Comments toggle — admin-only, and only meaningful for an active link. */}
      {isAdmin && row.status === "active" && (
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
            <input
              type="checkbox"
              checked={allowComments}
              disabled={togglingComments}
              onChange={toggleComments}
            />
            Allow comments on this link
          </label>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--faint)" }}>
            {allowComments ? "on" : "off"}
          </span>
        </div>
      )}

      {error && (
        <div
          style={{
            padding: "4px 14px 8px",
            borderBottom: "1px solid var(--hairline)",
            fontSize: 11.5,
            color: "var(--danger-ink)",
          }}
        >
          {error}
        </div>
      )}
    </>
  );
}
