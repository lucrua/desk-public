"use client";

import { useState } from "react";

type ExpiryOption = { label: string; value: number | null | undefined };

const EXPIRY_OPTIONS: ExpiryOption[] = [
  { label: "7 days", value: 7 },
  { label: "30 days", value: 30 },
  { label: "90 days", value: 90 },
  { label: "Never", value: null },
];

type Phase =
  | { kind: "form" }
  | { kind: "submitting" }
  | { kind: "done"; shareUrl: string; pinned: boolean }
  | { kind: "error"; message: string };

/** A version the modal can pin a link to. `label` is the rail label (e.g. "v3 · current"). */
export type ShareVersionOption = { id: number; label: string };

/** Bare "vN" from a rail label like "v7 · current" → "v7". */
function shortVersion(label: string): string {
  const m = label.match(/^v\d+/);
  return m ? m[0] : label;
}

/**
 * Admin share-creation modal.
 *
 * Posts to /api/shares and, on success, shows the returned shareUrl exactly
 * ONCE with a copy button and a "won't be shown again" warning — the raw token
 * is never persisted client-side beyond this render and is gone the moment the
 * modal closes (per the product's raw-token-once rule).
 *
 * When `versions` is provided the modal offers a live-vs-pinned choice ("Link
 * shows: latest version / this version (vN)"). Without it (e.g. the just-
 * uploaded flow, where the doc has exactly one version) the link is always live.
 */
export default function ShareModal({
  docSlug,
  onClose,
  versions,
}: {
  docSlug: string;
  onClose: () => void;
  versions?: ShareVersionOption[];
}) {
  const [label, setLabel] = useState("");
  const [expiryIdx, setExpiryIdx] = useState(0);
  // Mode radio cards: "live" follows the doc; "pinned" pins to the CURRENT
  // version (the rail's newest) — the common case the mock offers.
  const [mode, setMode] = useState<"live" | "pinned">("live");
  const [phase, setPhase] = useState<Phase>({ kind: "form" });
  const [copied, setCopied] = useState(false);

  const canPin = versions !== undefined && versions.length > 0;
  // The current version = the newest rail entry (its label carries "· current").
  const currentVersion = canPin ? versions![0] : undefined;
  const currentVersionShort = currentVersion ? shortVersion(currentVersion.label) : "";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = label.trim();
    setPhase({ kind: "submitting" });
    try {
      const isPinned = canPin && mode === "pinned" && currentVersion !== undefined;
      const pinnedVersionId = isPinned ? currentVersion!.id : undefined;
      const expiryValue = EXPIRY_OPTIONS[expiryIdx].value;
      const res = await fetch("/api/shares", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          docSlug,
          ...(trimmed ? { label: trimmed } : {}),
          expiresInDays: expiryValue,
          ...(pinnedVersionId !== undefined ? { pinnedVersionId } : {}),
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setPhase({
          kind: "error",
          message: data?.error ?? `Request failed (${res.status})`,
        });
        return;
      }
      const data = (await res.json()) as { shareUrl: string };
      setPhase({ kind: "done", shareUrl: data.shareUrl, pinned: !!isPinned });
    } catch {
      setPhase({ kind: "error", message: "Network error — share not created." });
    }
  }

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // clipboard blocked — the URL is still selectable in the field.
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Create share link"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.42)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 60,
        padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: 440,
          background: "var(--surface)",
          border: "1px solid var(--hairline)",
          borderRadius: 14,
          padding: "22px 22px 20px",
          color: "var(--ink)",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            marginBottom: 14,
          }}
        >
          <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>Create share link</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              color: "var(--muted)",
              fontSize: 18,
              lineHeight: 1,
              padding: 0,
            }}
          >
            ×
          </button>
        </div>

        {phase.kind === "done" ? (
          <div>
            <p style={{ margin: "0 0 10px", fontSize: 13, color: "var(--muted)" }}>
              Share link created. Copy it now —{" "}
              <strong style={{ color: "var(--warn-ink)" }}>
                this URL won&rsquo;t be shown again.
              </strong>
            </p>
            <p style={{ margin: "0 0 10px", fontSize: 12, color: "var(--muted)", lineHeight: 1.5 }}>
              {phase.pinned
                ? `This link is pinned to ${currentVersionShort || "this version"} — re-share after future publishes if they should see updates.`
                : "This link follows the doc — readers see each new published version."}
            </p>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                readOnly
                value={phase.shareUrl}
                onFocus={(e) => e.currentTarget.select()}
                style={{
                  flex: 1,
                  minWidth: 0,
                  padding: "9px 12px",
                  fontFamily: "var(--font-mono)",
                  fontSize: 12,
                  border: "1px solid var(--hairline)",
                  borderRadius: 8,
                  background: "var(--surface-alt)",
                  color: "var(--ink)",
                }}
              />
              <button
                type="button"
                onClick={() => copy(phase.shareUrl)}
                style={{
                  fontSize: 12.5,
                  fontWeight: 500,
                  padding: "8px 14px",
                  borderRadius: 8,
                  border: "none",
                  background: "var(--accent)",
                  color: "#fff",
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <div style={{ marginTop: 16, textAlign: "right" }}>
              <button
                type="button"
                onClick={onClose}
                style={{
                  fontSize: 12.5,
                  padding: "7px 14px",
                  borderRadius: 8,
                  border: "1px solid var(--hairline)",
                  background: "var(--surface)",
                  color: "var(--ink)",
                  cursor: "pointer",
                }}
              >
                Done
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={submit}>
            <label
              style={{
                display: "block",
                fontSize: 11.5,
                fontWeight: 600,
                color: "var(--muted)",
                marginBottom: 6,
              }}
            >
              Label
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="auto-named from doc title"
                autoFocus
                style={{
                  display: "block",
                  width: "100%",
                  marginTop: 6,
                  padding: "9px 12px",
                  fontSize: 13.5,
                  fontFamily: "var(--font-sans)",
                  fontWeight: 400,
                  border: "1px solid var(--hairline)",
                  borderRadius: 8,
                  background: "var(--surface-alt)",
                  color: "var(--ink)",
                  outline: "none",
                }}
              />
            </label>

            <label
              style={{
                display: "block",
                fontSize: 11.5,
                fontWeight: 600,
                color: "var(--muted)",
                margin: "14px 0 6px",
              }}
            >
              Expires
              <select
                value={expiryIdx}
                onChange={(e) => setExpiryIdx(Number(e.target.value))}
                style={{
                  display: "block",
                  width: "100%",
                  marginTop: 6,
                  padding: "9px 12px",
                  fontSize: 13.5,
                  fontFamily: "var(--font-sans)",
                  fontWeight: 400,
                  border: "1px solid var(--hairline)",
                  borderRadius: 8,
                  background: "var(--surface-alt)",
                  color: "var(--ink)",
                }}
              >
                {EXPIRY_OPTIONS.map((opt, i) => (
                  <option key={opt.label} value={i}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>

            {canPin && (
              <div style={{ margin: "14px 0 0" }}>
                <div
                  style={{
                    fontSize: 11.5,
                    fontWeight: 600,
                    color: "var(--muted)",
                    marginBottom: 8,
                  }}
                >
                  Link shows
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {(
                    [
                      {
                        key: "live" as const,
                        title: "Latest version (live)",
                        detail:
                          "Follows future edits — readers always see the newest published version.",
                      },
                      {
                        key: "pinned" as const,
                        title: `This version (${currentVersionShort})`,
                        detail:
                          "Stays at the snapshot you verified today, even as the doc evolves.",
                      },
                    ]
                  ).map((opt) => {
                    const active = mode === opt.key;
                    return (
                      <button
                        key={opt.key}
                        type="button"
                        onClick={() => {
                          setMode(opt.key);
                          // clear a prior error so switching mode re-enables the form cleanly
                          if (phase.kind === "error") setPhase({ kind: "form" });
                        }}
                        aria-pressed={active}
                        style={{
                          display: "flex",
                          alignItems: "flex-start",
                          gap: 10,
                          textAlign: "left",
                          padding: "10px 12px",
                          border: `1px solid ${active ? "var(--accent)" : "var(--hairline)"}`,
                          borderRadius: 10,
                          background: active ? "var(--accent-ring)" : "transparent",
                          cursor: "pointer",
                          fontFamily: "var(--font-sans)",
                        }}
                      >
                        <span
                          aria-hidden
                          style={{
                            width: 15,
                            height: 15,
                            borderRadius: "50%",
                            border: `1.5px solid ${active ? "var(--accent)" : "var(--hairline)"}`,
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            flex: "none",
                            marginTop: 1,
                          }}
                        >
                          <span
                            style={{
                              width: 7,
                              height: 7,
                              borderRadius: "50%",
                              background: active ? "var(--accent)" : "transparent",
                              display: "inline-block",
                            }}
                          />
                        </span>
                        <span style={{ flex: 1 }}>
                          <span style={{ display: "block", fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>
                            {opt.title}
                          </span>
                          <span
                            style={{
                              display: "block",
                              fontSize: 12,
                              color: "var(--muted)",
                              lineHeight: 1.5,
                              marginTop: 2,
                            }}
                          >
                            {opt.detail}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {phase.kind === "error" && (
              <p style={{ margin: "12px 0 0", fontSize: 12.5, color: "var(--danger-ink)" }}>
                {phase.message}
              </p>
            )}

            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                gap: 8,
                marginTop: 18,
              }}
            >
              <button
                type="button"
                onClick={onClose}
                style={{
                  fontSize: 12.5,
                  padding: "8px 14px",
                  borderRadius: 8,
                  border: "1px solid var(--hairline)",
                  background: "var(--surface)",
                  color: "var(--ink)",
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={phase.kind === "submitting"}
                style={{
                  fontSize: 12.5,
                  fontWeight: 500,
                  padding: "8px 16px",
                  borderRadius: 8,
                  border: "none",
                  background: "var(--accent)",
                  color: "#fff",
                  cursor: phase.kind === "submitting" ? "default" : "pointer",
                  opacity: phase.kind === "submitting" ? 0.7 : 1,
                }}
              >
                {phase.kind === "submitting" ? "Creating…" : "Create link"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
