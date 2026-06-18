"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { ShareRowView } from "./view-model";

type ViewLogEntry = {
  viewedAt: string;
  ip: string | null;
  uaLabel: string;
  rawUa: string | null;
  docVersionId: number;
};

const cell = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--muted)",
} as const;

/**
 * One row of the admin shares table + its expandable view-log timeline.
 *
 * Interactivity (revoke confirm → POST, expand → fetch GET …/views) lives here
 * as a client island; the page stays an RSC.
 *
 * SECURITY: ip / rawUa from the views API are attacker-controlled raw strings.
 * They are interpolated as plain JSX text only (React escapes) — never into an
 * HTML sink, href, or src. uaLabel is the coarse human label.
 */
export default function ShareRow({ row }: { row: ShareRowView }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [expanded, setExpanded] = useState(false);
  const [views, setViews] = useState<ViewLogEntry[] | null>(null);
  const [loadingViews, setLoadingViews] = useState(false);
  const [viewsError, setViewsError] = useState<string | null>(null);

  const [allowComments, setAllowComments] = useState(row.allowComments);
  const [togglingComments, setTogglingComments] = useState(false);

  async function toggleComments() {
    const next = !allowComments;
    setTogglingComments(true);
    setError(null);
    // Optimistic; revert on failure.
    setAllowComments(next);
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

  async function revoke() {
    if (
      !window.confirm(
        `Revoke "${row.label}"? The link dies instantly — indistinguishable from never having existed.`,
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

  async function toggleExpand() {
    const next = !expanded;
    setExpanded(next);
    if (next && views === null && !loadingViews) {
      setLoadingViews(true);
      setViewsError(null);
      try {
        const res = await fetch(`/api/shares/${row.id}/views`);
        if (!res.ok) {
          setViewsError(`Could not load view log (${res.status})`);
          return;
        }
        const data = (await res.json()) as { views: ViewLogEntry[] };
        setViews(data.views);
      } catch {
        setViewsError("Network error loading view log.");
      } finally {
        setLoadingViews(false);
      }
    }
  }

  return (
    <>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1.4fr 1.1fr 0.8fr 0.8fr 0.5fr 0.6fr",
          padding: "9px 14px",
          borderBottom: "1px solid var(--hairline)",
          alignItems: "center",
          opacity: row.isRevoked ? 0.45 : 1,
          background: expanded ? "var(--surface-alt)" : "transparent",
        }}
      >
        <button
          type="button"
          onClick={toggleExpand}
          aria-expanded={expanded}
          title="Toggle view log"
          style={{
            justifySelf: "start",
            textAlign: "left",
            border: "none",
            background: "transparent",
            padding: 0,
            cursor: "pointer",
            color: "var(--ink)",
            fontFamily: "var(--font-sans)",
            fontSize: 12.5,
            fontWeight: 500,
          }}
        >
          <span style={{ color: "var(--faint)", marginRight: 6, fontFamily: "var(--font-mono)" }}>
            {expanded ? "▾" : "▸"}
          </span>
          {row.label}
        </button>
        <span style={cell}>{row.scope}</span>
        <span
          style={{
            ...cell,
            color: row.expiringSoon ? "var(--warn-ink)" : "var(--muted)",
          }}
        >
          {row.expires}
        </span>
        <span style={{ ...cell, color: row.neverViewed ? "var(--faint)" : "var(--muted)" }}>
          {row.lastView}
        </span>
        <span style={{ ...cell, justifySelf: "end" }}>{row.viewCount}</span>
        {row.canRevoke ? (
          <button
            type="button"
            onClick={revoke}
            disabled={pending}
            style={{
              justifySelf: "end",
              fontSize: 11,
              fontWeight: 500,
              padding: "3px 10px",
              borderRadius: 6,
              border: "1px solid var(--danger-border)",
              background: "transparent",
              color: "var(--danger-ink)",
              cursor: "pointer",
              fontFamily: "var(--font-sans)",
            }}
          >
            {pending ? "…" : "revoke"}
          </button>
        ) : (
          <span
            style={{
              justifySelf: "end",
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              color: "var(--faint)",
            }}
          >
            revoked
          </span>
        )}
      </div>

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

      {expanded && (
        <div
          style={{
            padding: "12px 14px 14px 32px",
            borderBottom: "1px solid var(--hairline)",
            background: "var(--surface-alt)",
          }}
        >
          {/* Per-share comment toggle. Disabled for revoked shares (composer is
              gone regardless once revoked). */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 12,
              fontSize: 12.5,
            }}
          >
            <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: row.isRevoked ? "default" : "pointer" }}>
              <input
                type="checkbox"
                checked={allowComments}
                disabled={togglingComments || row.isRevoked}
                onChange={toggleComments}
              />
              Allow comments on this link
            </label>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--faint)" }}>
              {allowComments ? "on" : "off"}
            </span>
          </div>

          {loadingViews && (
            <div style={{ fontSize: 12, color: "var(--muted)" }}>Loading view log…</div>
          )}
          {viewsError && (
            <div style={{ fontSize: 12, color: "var(--danger-ink)" }}>{viewsError}</div>
          )}
          {!loadingViews && !viewsError && views !== null && views.length === 0 && (
            <div>
              <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 2 }}>Never opened</div>
              <div style={{ fontSize: 12, color: "var(--muted)" }}>
                No views recorded for this link yet — the answer is right here when he opens it.
              </div>
            </div>
          )}
          {!loadingViews && views !== null && views.length > 0 && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 10,
                borderLeft: "2px solid var(--hairline)",
                paddingLeft: 14,
              }}
            >
              {views.map((v, i) => (
                <div key={i}>
                  <div style={{ fontSize: 12.5, lineHeight: 1.45 }}>
                    <strong style={{ fontWeight: 600 }}>{row.label}</strong> opened{" "}
                    <span
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: 11,
                        color: "var(--ref-ink)",
                      }}
                    >
                      {row.docSlug}
                    </span>
                  </div>
                  {/* ip / rawUa are raw attacker-controlled strings — plain text only. */}
                  <div
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 10,
                      color: "var(--faint)",
                      marginTop: 2,
                    }}
                    title={v.rawUa ?? undefined}
                  >
                    {formatStamp(v.viewedAt)} · {v.uaLabel}
                    {v.ip ? ` · ${v.ip}` : ""}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}

/** Render an ISO timestamp as "YYYY-MM-DD HH:MM" in UTC (stable, no locale drift). */
function formatStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 16).replace("T", " ");
}
