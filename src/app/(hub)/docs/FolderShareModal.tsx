"use client";

import { useState } from "react";

type ExpiryOption = { label: string; value: number | undefined };

const EXPIRY_OPTIONS: ExpiryOption[] = [
  { label: "Never", value: undefined },
  { label: "7 days", value: 7 },
  { label: "30 days", value: 30 },
  { label: "90 days", value: 90 },
];

type Phase =
  | { kind: "form" }
  | { kind: "submitting" }
  | { kind: "done"; shareUrl: string }
  | { kind: "error"; message: string };

/**
 * Admin directory-share creation modal — created from a folder row on the docs
 * tree. Label + expiry + comments toggle; NO pin (it's a whole folder, live by
 * definition). Posts directory mode to /api/shares and shows the one-time URL.
 *
 * Like ShareModal, the raw token is shown EXACTLY once and is gone the moment
 * the modal closes (raw-token-once rule).
 */
export default function FolderShareModal({
  space,
  pathPrefix,
  onClose,
}: {
  /** The space slug the folder lives in — a directory share is space-scoped
   *  (Slice 1, finding 3), so the create call must carry it. */
  space: string;
  pathPrefix: string;
  onClose: () => void;
}) {
  const [label, setLabel] = useState("");
  const [expiryIdx, setExpiryIdx] = useState(0);
  const [allowComments, setAllowComments] = useState(true);
  const [phase, setPhase] = useState<Phase>({ kind: "form" });
  const [copied, setCopied] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = label.trim();
    if (!trimmed) {
      setPhase({ kind: "error", message: "A label is required." });
      return;
    }
    setPhase({ kind: "submitting" });
    try {
      const res = await fetch("/api/shares", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          space,
          pathPrefix,
          label: trimmed,
          expiresInDays: EXPIRY_OPTIONS[expiryIdx].value,
          allowComments,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setPhase({ kind: "error", message: data?.error ?? `Request failed (${res.status})` });
        return;
      }
      const data = (await res.json()) as { shareUrl: string };
      setPhase({ kind: "done", shareUrl: data.shareUrl });
    } catch {
      setPhase({ kind: "error", message: "Network error — share not created." });
    }
  }

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // clipboard blocked — the URL is still selectable.
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Share folder"
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
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
          <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>Share folder</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--muted)", fontSize: 18, lineHeight: 1, padding: 0 }}
          >
            ×
          </button>
        </div>
        <p style={{ margin: "0 0 16px", fontSize: 12.5, color: "var(--muted)" }}>
          One link to{" "}
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--ref-ink, var(--accent))" }}>
            {pathPrefix}/
          </span>
          . Every published doc under it is readable; new ones appear automatically. One revoke kills the lot.
        </p>

        {phase.kind === "done" ? (
          <div>
            <p style={{ margin: "0 0 10px", fontSize: 13, color: "var(--muted)" }}>
              Folder link created. Copy it now —{" "}
              <strong style={{ color: "var(--warn-ink)" }}>this URL won&rsquo;t be shown again.</strong>
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
            <label style={{ display: "block", fontSize: 11.5, fontWeight: 600, color: "var(--muted)", marginBottom: 6 }}>
              Label (required)
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="e.g. Microsoft partner review"
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

            <label style={{ display: "block", fontSize: 11.5, fontWeight: 600, color: "var(--muted)", margin: "14px 0 6px" }}>
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

            <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 14, fontSize: 13, cursor: "pointer" }}>
              <input type="checkbox" checked={allowComments} onChange={(e) => setAllowComments(e.target.checked)} />
              Allow comments on docs opened through this link
            </label>

            {phase.kind === "error" && (
              <p style={{ margin: "12px 0 0", fontSize: 12.5, color: "var(--danger-ink)" }}>{phase.message}</p>
            )}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
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
                {phase.kind === "submitting" ? "Creating…" : "Create folder link"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
