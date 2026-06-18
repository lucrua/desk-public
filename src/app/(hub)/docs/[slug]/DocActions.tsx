"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, useEffect, useRef } from "react";
import ShareModal, { type ShareVersionOption } from "@/components/ShareModal";
import PathPicker from "@/components/PathPicker";
import { isValidPath, normalizePath } from "@/lib/path";
import { moveCtaLabel } from "../tree-model";

/**
 * Doc-header action cluster — round-3 design pass.
 *
 * Structure:
 *   PRIMARY  ·  Share (solid green + share-circle glyph)
 *   SECONDARY · Edit (admin, opens editor) | Propose edit (member, proposes revision)
 *   OVERFLOW  · ⋯ 34px square → 224px menu:
 *                 Move… / Copy link / View history (vN hint) / Unpublish / ─ / Delete…
 *
 * Member variant: no secondary/overflow; one-line "propose only" note shown instead.
 *
 * Destructive-confirm ladder (this pass = tier 3):
 *   • Unpublish — still uses window.confirm (tier 1 follow-up; reversible, low cost)
 *   • Delete…   — tier-3 dialog: danger ! chip + title + consequence list +
 *                  type-the-slug gate + filled-danger commit button.
 *                  HONEST COPY: content is purged (no soft-delete), no Undo toast.
 *                  Post-delete: plain "Deleted. Its links now return 404." toast.
 *
 * Routes (unchanged):
 *   Unpublish → POST /api/docs/[slug]/unpublish (stage-1, reversible)
 *   Delete    → DELETE /api/docs/[slug]          (stage-2, DESTRUCTIVE — purges all)
 */

// ── shared style constants ────────────────────────────────────────────────────

const SANS = "'Helvetica Neue', Helvetica, Arial, system-ui, sans-serif";
const MONO = "'JetBrains Mono', 'SFMono-Regular', Menlo, monospace";

// ── ShareCircle glyph (round-1 design token) ─────────────────────────────────

function ShareCircle({ color }: { color: string }) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: 13,
        height: 13,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        border: `1.6px solid ${color}`,
        borderRadius: "50%",
        position: "relative",
        flexShrink: 0,
      }}
    >
      <span
        style={{
          position: "absolute",
          inset: 3,
          borderRadius: "50%",
          border: `1.4px solid ${color}`,
        }}
      />
    </span>
  );
}

// ── DeleteToast ───────────────────────────────────────────────────────────────

function DeleteToast({ onDismiss }: { onDismiss: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 5000);
    return () => clearTimeout(t);
  }, [onDismiss]);

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "fixed",
        top: 62,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 80,
        display: "flex",
        alignItems: "center",
        gap: 12,
        background: "var(--ink)",
        color: "var(--bg)",
        borderRadius: 10,
        padding: "11px 16px",
        boxShadow: "0 14px 40px rgba(0,0,0,0.3)",
        animation: "fadeUp 0.25s ease both",
        fontSize: 13,
        fontFamily: SANS,
        whiteSpace: "nowrap",
      }}
    >
      <span>
        Deleted. Its links now return{" "}
        <span style={{ fontFamily: MONO }}>404</span>.
      </span>
    </div>
  );
}

// ── DeleteDialog ──────────────────────────────────────────────────────────────

function DeleteDialog({
  slug,
  title,
  onClose,
  onDeleted,
}: {
  slug: string;
  title: string;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [confirmText, setConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [, startTransition] = useTransition();
  const router = useRouter();

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Dismiss on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const confirmed = confirmText.trim() === slug;

  async function handleDelete() {
    if (!confirmed || deleting) return;
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/docs/${slug}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? `Delete failed (${res.status})`);
        setDeleting(false);
        return;
      }
      onDeleted();
      startTransition(() => {
        router.push("/docs");
        router.refresh();
      });
    } catch {
      setError("Network error — doc not deleted.");
      setDeleting(false);
    }
  }

  const consequences = [
    { text: `Live links 404 immediately — anyone holding one loses access.`, danger: true },
    { text: `Members lose access to it in the hub.`, danger: true },
    { text: `Content is purged — this can’t be undone.`, danger: true },
    { text: `The slug “${slug}” frees up — you can publish a new doc there.`, danger: false },
  ];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-dialog-title"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        background: "rgba(15,12,9,0.44)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: 460,
          background: "var(--surface)",
          border: "1px solid var(--hairline)",
          borderRadius: 14,
          boxShadow: "0 24px 70px rgba(15,12,9,0.32)",
          overflow: "hidden",
          animation: "fadeUp 0.2s ease both",
        }}
      >
        {/* Body */}
        <div style={{ padding: "22px 24px 18px" }}>
          {/* Header row: danger ! chip + title */}
          <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 8 }}>
            <span
              aria-hidden="true"
              style={{
                width: 22,
                height: 22,
                borderRadius: 6,
                background: "var(--danger-bg)",
                border: "1px solid var(--danger-border)",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                color: "var(--danger-ink)",
                fontSize: 14,
                fontWeight: 700,
                flexShrink: 0,
              }}
            >
              !
            </span>
            <h2
              id="delete-dialog-title"
              style={{
                fontSize: 17,
                fontWeight: 600,
                margin: 0,
                color: "var(--ink)",
                fontFamily: SANS,
              }}
            >
              Delete &ldquo;{title}&rdquo;?
            </h2>
          </div>

          <p
            style={{
              margin: "0 0 16px",
              fontSize: 13,
              color: "var(--muted)",
              lineHeight: 1.6,
              fontFamily: SANS,
            }}
          >
            This removes the doc and revokes its share links. Here&rsquo;s exactly what happens:
          </p>

          {/* Consequence list */}
          <div style={{ display: "flex", flexDirection: "column", gap: 9, marginBottom: 18 }}>
            {consequences.map((c, i) => (
              <div key={i} style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                <span
                  aria-hidden="true"
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: c.danger ? "var(--danger-ink)" : "var(--muted)",
                    flexShrink: 0,
                    transform: "translateY(-1px)",
                  }}
                />
                <span
                  style={{
                    fontSize: 13,
                    lineHeight: 1.5,
                    color: "var(--ink)",
                    fontFamily: SANS,
                  }}
                >
                  {c.text}
                </span>
              </div>
            ))}
          </div>

          {/* Type-to-confirm */}
          <label
            htmlFor="delete-confirm-input"
            style={{
              display: "block",
              fontSize: 12.5,
              color: "var(--muted)",
              marginBottom: 7,
              fontFamily: SANS,
            }}
          >
            Type{" "}
            <span
              style={{
                fontFamily: MONO,
                color: "var(--ink)",
                background: "var(--hover)",
                padding: "1px 6px",
                borderRadius: 4,
                fontSize: 12,
              }}
            >
              {slug}
            </span>{" "}
            to confirm
          </label>
          <input
            id="delete-confirm-input"
            ref={inputRef}
            type="text"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && confirmed) handleDelete(); }}
            placeholder={slug}
            autoComplete="off"
            spellCheck={false}
            style={{
              width: "100%",
              padding: "9px 12px",
              fontSize: 13,
              fontFamily: MONO,
              border: `1px solid ${
                confirmText.length === 0
                  ? "var(--hairline)"
                  : confirmed
                  ? "var(--danger-ink)"
                  : "var(--hairline)"
              }`,
              borderRadius: 8,
              background: "var(--bg)",
              color: "var(--ink)",
              outline: "none",
              transition: "border-color 0.15s ease",
            }}
          />

          {error && (
            <p style={{ margin: "10px 0 0", fontSize: 12, color: "var(--danger-ink)", fontFamily: SANS }}>
              {error}
            </p>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 8,
            padding: "14px 24px",
            borderTop: "1px solid var(--hairline)",
            background: "var(--surface-alt)",
          }}
        >
          <span
            style={{
              fontSize: 11.5,
              color: "var(--faint)",
              fontFamily: SANS,
            }}
          >
            Content is purged. The slug becomes reusable.
          </span>
          <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
            <button
              type="button"
              onClick={onClose}
              style={{
                fontSize: 13,
                fontWeight: 500,
                padding: "7px 14px",
                borderRadius: 8,
                border: "1px solid var(--hairline)",
                background: "var(--surface)",
                color: "var(--muted)",
                cursor: "pointer",
                fontFamily: SANS,
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleDelete}
              disabled={!confirmed || deleting}
              aria-disabled={!confirmed || deleting}
              style={{
                fontSize: 13,
                fontWeight: 600,
                padding: "7px 16px",
                borderRadius: 8,
                border: "none",
                background: "var(--danger-solid)",
                color: "var(--danger-solid-ink)",
                cursor: confirmed && !deleting ? "pointer" : "not-allowed",
                opacity: confirmed && !deleting ? 1 : 0.5,
                fontFamily: SANS,
                transition: "opacity 0.15s ease",
              }}
            >
              {deleting ? "Deleting…" : "Delete doc"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── MoveDialog (kept from previous implementation, styled to match) ─────────

function MoveDialog({
  slug,
  path,
  folders,
  onClose,
}: {
  slug: string;
  path: string;
  folders: string[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [movePath, setMovePath] = useState(path);
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function moveDoc() {
    const trimmed = movePath.trim();
    if (trimmed !== "" && !isValidPath(trimmed)) {
      setError('Invalid folder — lowercase letters, digits, dashes; "/" for sub-folders (max 6 deep).');
      return;
    }
    const dest = normalizePath(trimmed) ?? "";
    setMoving(true);
    setError(null);
    try {
      const res = await fetch(`/api/docs/${slug}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: dest }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? `Move failed (${res.status})`);
        setMoving(false);
        return;
      }
      onClose();
      startTransition(() => router.refresh());
    } catch {
      setError("Network error — doc not moved.");
      setMoving(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Move doc to a folder"
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
          maxWidth: 460,
          background: "var(--surface)",
          border: "1px solid var(--hairline)",
          borderRadius: 14,
          padding: "22px 24px",
          color: "var(--ink)",
          animation: "fadeUp 0.2s ease both",
        }}
      >
        <h2 style={{ fontSize: 16, fontWeight: 600, margin: "0 0 4px", fontFamily: SANS }}>
          Move &ldquo;{slug}&rdquo;
        </h2>
        <p style={{ fontSize: 12.5, color: "var(--muted)", margin: "0 0 16px", fontFamily: SANS }}>
          Currently in{" "}
          <span style={{ fontFamily: MONO, fontSize: 11.5, color: "var(--ref-ink, var(--accent))" }}>
            {path ? path + "/" : "(root)"}
          </span>
          . Folders are implicit — moving the last doc out of a folder removes the folder.
        </p>

        <label
          style={{
            display: "block",
            fontFamily: MONO,
            fontSize: 10,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--faint)",
            marginBottom: 6,
          }}
        >
          destination folder
        </label>
        <PathPicker
          value={movePath}
          onChange={setMovePath}
          existingFolders={folders}
          onEnter={moveDoc}
          onEscape={onClose}
          autoFocus
          invalid={movePath.trim() !== "" && !isValidPath(movePath.trim())}
        />

        {error && (
          <p style={{ margin: "10px 0 0", fontSize: 12, color: "var(--danger-ink)", fontFamily: SANS }}>{error}</p>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button
            type="button"
            onClick={onClose}
            style={{
              fontSize: 13,
              fontWeight: 500,
              padding: "7px 14px",
              borderRadius: 8,
              border: "1px solid var(--hairline)",
              background: "var(--surface)",
              color: "var(--muted)",
              cursor: "pointer",
              fontFamily: SANS,
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={moveDoc}
            disabled={moving}
            style={{
              fontSize: 13,
              fontWeight: 500,
              padding: "7px 14px",
              borderRadius: 8,
              border: "none",
              background: "var(--accent)",
              color: "#fff",
              cursor: moving ? "default" : "pointer",
              opacity: moving ? 0.7 : 1,
              fontFamily: SANS,
            }}
          >
            {moving ? "Moving…" : moveCtaLabel(movePath, folders)}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── OverflowMenu ──────────────────────────────────────────────────────────────

type OverflowItem =
  | { kind: "item"; label: string; hint?: string; danger?: boolean; onClick: () => void }
  | { kind: "divider" };

function OverflowMenu({
  items,
  onClose,
}: {
  items: OverflowItem[];
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on click outside / Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    function onClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="Doc actions"
      style={{
        position: "absolute",
        top: 42,
        right: 0,
        width: 224,
        background: "var(--surface)",
        border: "1px solid var(--hairline)",
        borderRadius: 11,
        boxShadow: "0 16px 44px rgba(15,12,9,0.18)",
        padding: 5,
        zIndex: 40,
        animation: "menuIn 0.13s ease both",
      }}
    >
      {items.map((item, i) => {
        if (item.kind === "divider") {
          return (
            <div
              key={i}
              role="separator"
              style={{
                height: 1,
                background: "var(--hairline)",
                margin: "5px 6px",
              }}
            />
          );
        }
        return (
          <button
            key={i}
            type="button"
            role="menuitem"
            onClick={() => {
              onClose();
              item.onClick();
            }}
            style={{
              width: "100%",
              textAlign: "left",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 10,
              fontSize: 13,
              padding: "8px 10px",
              borderRadius: 7,
              border: "none",
              background: "transparent",
              color: item.danger ? "var(--danger-ink)" : "var(--ink)",
              cursor: "pointer",
              fontFamily: SANS,
              fontWeight: item.danger ? 600 : 500,
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = item.danger
                ? "var(--danger-bg)"
                : "var(--hover)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = "transparent";
            }}
          >
            <span>{item.label}</span>
            {item.hint && (
              <span
                style={{
                  fontFamily: MONO,
                  fontSize: 10,
                  color: "var(--faint)",
                }}
              >
                {item.hint}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ── UploadVersionDialog ───────────────────────────────────────────────────────

function UploadVersionDialog({
  slug,
  onClose,
  onPublished,
}: {
  slug: string;
  onClose: () => void;
  onPublished: () => void;
}) {
  const [content, setContent] = useState("");
  const [filename, setFilename] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFilename(file.name);
    const reader = new FileReader();
    reader.onload = (ev) => setContent(ev.target?.result as string ?? "");
    reader.readAsText(file);
  }

  async function handleUpload() {
    if (!content.trim() || uploading) return;
    setError(null);
    setUploading(true);
    try {
      const res = await fetch(`/api/docs/${encodeURIComponent(slug)}/publish`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? `Upload failed (${res.status})`);
        setUploading(false);
        return;
      }
      onPublished();
      onClose();
      startTransition(() => router.refresh());
    } catch {
      setError("Network error — version not uploaded.");
      setUploading(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Upload new version"
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.42)",
        display: "flex", alignItems: "center", justifyContent: "center",
        zIndex: 60, padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%", maxWidth: 460,
          background: "var(--surface)", border: "1px solid var(--hairline)",
          borderRadius: 14, padding: "22px 24px",
          color: "var(--ink)", animation: "fadeUp 0.2s ease both",
        }}
      >
        <h2 style={{ fontSize: 16, fontWeight: 600, margin: "0 0 4px", fontFamily: SANS }}>
          Upload new version
        </h2>
        <p style={{ fontSize: 12.5, color: "var(--muted)", margin: "0 0 16px", fontFamily: SANS }}>
          Replaces the live content of{" "}
          <span style={{ fontFamily: MONO, fontSize: 11.5, color: "var(--ink)" }}>{slug}</span>{" "}
          immediately. No approval needed.
        </p>

        <label
          style={{
            display: "block", fontFamily: MONO, fontSize: 10,
            letterSpacing: "0.08em", textTransform: "uppercase",
            color: "var(--faint)", marginBottom: 6,
          }}
        >
          file (.md or .html)
        </label>
        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <input
            ref={fileRef}
            type="file"
            accept=".md,.html,text/markdown,text/html,text/plain"
            onChange={handleFile}
            style={{ display: "none" }}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            style={{
              fontSize: 13, padding: "7px 14px", borderRadius: 8,
              border: "1px solid var(--hairline)", background: "var(--surface)",
              color: "var(--ink)", cursor: "pointer", fontFamily: SANS,
            }}
          >
            Choose file
          </button>
          {filename && (
            <span style={{ fontSize: 12.5, color: "var(--muted)", alignSelf: "center", fontFamily: SANS }}>
              {filename}
            </span>
          )}
        </div>

        {error && (
          <p style={{ margin: "0 0 10px", fontSize: 12, color: "var(--danger-ink)", fontFamily: SANS }}>{error}</p>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
          <button
            type="button" onClick={onClose}
            style={{
              fontSize: 13, fontWeight: 500, padding: "7px 14px", borderRadius: 8,
              border: "1px solid var(--hairline)", background: "var(--surface)",
              color: "var(--muted)", cursor: "pointer", fontFamily: SANS,
            }}
          >
            Cancel
          </button>
          <button
            type="button" onClick={handleUpload}
            disabled={!content.trim() || uploading}
            style={{
              fontSize: 13, fontWeight: 500, padding: "7px 14px", borderRadius: 8,
              border: "none", background: "var(--accent)", color: "#fff",
              cursor: content.trim() && !uploading ? "pointer" : "default",
              opacity: content.trim() && !uploading ? 1 : 0.5,
              fontFamily: SANS,
            }}
          >
            {uploading ? "Uploading…" : "Publish version"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── SetOwnerDialog ────────────────────────────────────────────────────────────

function SetOwnerDialog({
  slug,
  currentOwnerName,
  onClose,
  onChanged,
}: {
  slug: string;
  currentOwnerName: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [userId, setUserId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const router = useRouter();

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function handleSave() {
    const id = parseInt(userId.trim(), 10);
    if (isNaN(id) || id <= 0) { setError("Enter a valid numeric user ID."); return; }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/docs/${encodeURIComponent(slug)}/owner`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ownerUserId: id }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? `Failed (${res.status})`);
        setSaving(false);
        return;
      }
      onChanged();
      onClose();
      startTransition(() => router.refresh());
    } catch {
      setError("Network error.");
      setSaving(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Set doc owner"
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.42)",
        display: "flex", alignItems: "center", justifyContent: "center",
        zIndex: 60, padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%", maxWidth: 420,
          background: "var(--surface)", border: "1px solid var(--hairline)",
          borderRadius: 14, padding: "22px 24px",
          color: "var(--ink)", animation: "fadeUp 0.2s ease both",
        }}
      >
        <h2 style={{ fontSize: 16, fontWeight: 600, margin: "0 0 4px", fontFamily: SANS }}>
          Set owner
        </h2>
        <p style={{ fontSize: 12.5, color: "var(--muted)", margin: "0 0 16px", fontFamily: SANS }}>
          {currentOwnerName
            ? <>Current owner: <strong>{currentOwnerName}</strong>. Enter a user ID to reassign.</>
            : "This doc has no owner. Enter a user ID to assign one."}
        </p>

        <label
          htmlFor="owner-user-id"
          style={{
            display: "block", fontFamily: MONO, fontSize: 10,
            letterSpacing: "0.08em", textTransform: "uppercase",
            color: "var(--faint)", marginBottom: 6,
          }}
        >
          user id (numeric)
        </label>
        <input
          id="owner-user-id"
          type="number"
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleSave(); }}
          placeholder="e.g. 3"
          autoFocus
          style={{
            width: "100%", padding: "9px 12px", fontSize: 13, fontFamily: MONO,
            border: "1px solid var(--hairline)", borderRadius: 8,
            background: "var(--bg)", color: "var(--ink)", outline: "none",
          }}
        />
        <p style={{ fontSize: 11.5, color: "var(--faint)", margin: "6px 0 0", fontFamily: SANS }}>
          Find user IDs in <a href="/admin" style={{ color: "var(--accent)" }}>/admin → Users</a>.
        </p>

        {error && (
          <p style={{ margin: "10px 0 0", fontSize: 12, color: "var(--danger-ink)", fontFamily: SANS }}>{error}</p>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button
            type="button" onClick={onClose}
            style={{
              fontSize: 13, fontWeight: 500, padding: "7px 14px", borderRadius: 8,
              border: "1px solid var(--hairline)", background: "var(--surface)",
              color: "var(--muted)", cursor: "pointer", fontFamily: SANS,
            }}
          >
            Cancel
          </button>
          <button
            type="button" onClick={handleSave} disabled={saving}
            style={{
              fontSize: 13, fontWeight: 500, padding: "7px 14px", borderRadius: 8,
              border: "none", background: "var(--accent)", color: "#fff",
              cursor: saving ? "default" : "pointer", opacity: saving ? 0.7 : 1,
              fontFamily: SANS,
            }}
          >
            {saving ? "Saving…" : "Set owner"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── DocActions (main export) ──────────────────────────────────────────────────

export default function DocActions({
  slug,
  title,
  path,
  isPublished,
  isAdmin,
  canEdit,
  canPublishDirect = false,
  ownerDisplayName,
  versions,
  folders = [],
  versionCount,
}: {
  slug: string;
  /** Doc title — used in the delete dialog heading. */
  title: string;
  path: string;
  isPublished: boolean;
  /** Admin vs member — controls which actions are shown. */
  isAdmin: boolean;
  /** True when the doc is md format + has a published version (controls Edit/Propose edit). */
  canEdit: boolean;
  /** True when this principal can publish a new version directly (owner or admin). */
  canPublishDirect?: boolean;
  /** Display name of the doc owner (null when unassigned). */
  ownerDisplayName?: string | null;
  versions?: ShareVersionOption[];
  folders?: string[];
  /** Total version count for the history hint label (e.g. "v7"). */
  versionCount?: number;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  // Overlay state
  const [shareOpen, setShareOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [showToast, setShowToast] = useState(false);
  const [uploadVersionOpen, setUploadVersionOpen] = useState(false);
  const [setOwnerOpen, setSetOwnerOpen] = useState(false);

  // Unpublish in-flight state
  const [unpublishing, setUnpublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function unpublishDoc() {
    if (
      !window.confirm(
        `Unpublish "${slug}"?\n\n` +
          `• All share links stop working immediately (404).\n` +
          `• Members lose access.\n` +
          `• Version history and content are retained — re-publishing restores it.`,
      )
    ) {
      return;
    }
    setError(null);
    setUnpublishing(true);
    try {
      const res = await fetch(`/api/docs/${slug}/unpublish`, { method: "POST" });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? `Unpublish failed (${res.status})`);
        return;
      }
      startTransition(() => {
        router.push("/docs");
        router.refresh();
      });
    } catch {
      setError("Network error — doc not unpublished.");
    } finally {
      setUnpublishing(false);
    }
  }

  function handleCopyLink() {
    // "Copy link" in the overflow maps to the ShareModal which has a reveal+copy flow.
    // We open the share modal — the user can copy from there.
    setShareOpen(true);
  }

  function handleViewHistory() {
    // "View history" scrolls the user to the version rail / diff section.
    // The version rail is in the page sidebar; we just smooth-scroll to it.
    const rail = document.getElementById("version-rail");
    if (rail) {
      rail.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  const historyHint = versionCount != null && versionCount > 0
    ? `v${versionCount}`
    : undefined;

  const overflowItems: OverflowItem[] = [
    { kind: "item", label: "Move…", hint: path || undefined, onClick: () => setMoveOpen(true) },
    { kind: "item", label: "Copy link", onClick: handleCopyLink },
    { kind: "item", label: "View history", hint: historyHint, onClick: handleViewHistory },
    // "Upload new version" — owner or admin may publish a new version via file upload.
    ...(canPublishDirect
      ? [{ kind: "item" as const, label: "Upload new version", onClick: () => setUploadVersionOpen(true) }]
      : []),
    // "Set owner…" — admin-only action to reassign the doc owner.
    ...(isAdmin
      ? [{ kind: "item" as const, label: "Set owner…", onClick: () => setSetOwnerOpen(true) }]
      : []),
    ...(isPublished
      ? [{ kind: "item" as const, label: unpublishing ? "Unpublishing…" : "Unpublish", onClick: unpublishDoc }]
      : []),
    { kind: "divider" },
    { kind: "item", label: "Delete…", danger: true, onClick: () => setDeleteOpen(true) },
  ];

  // ── Render ──────────────────────────────────────────────────────────────────

  if (!isAdmin && !canPublishDirect) {
    // Member variant (no ownership): primary Share + optional "Propose edit" + one-line note.
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 20 }}>
        {/* Primary Share */}
        <button
          type="button"
          onClick={() => setShareOpen(true)}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 7,
            fontSize: 13,
            fontWeight: 500,
            padding: "7px 15px",
            borderRadius: 8,
            border: "none",
            background: "var(--accent)",
            color: "#fff",
            cursor: "pointer",
            fontFamily: SANS,
          }}
        >
          <ShareCircle color="#fff" />
          Share
        </button>

        {/* Secondary — Propose edit */}
        {canEdit && (
          <a
            href={`/docs/${slug}/edit`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              fontSize: 13,
              fontWeight: 500,
              padding: "7px 14px",
              borderRadius: 8,
              border: "1px solid var(--hairline)",
              background: "var(--surface)",
              color: "var(--ink)",
              cursor: "pointer",
              fontFamily: SANS,
              textDecoration: "none",
              lineHeight: 1,
            }}
          >
            Propose edit
          </a>
        )}

        {/* Owner meta */}
        {ownerDisplayName && (
          <span style={{ fontSize: 11.5, color: "var(--faint)", fontFamily: MONO }}>
            owner: {ownerDisplayName}
          </span>
        )}

        {/* Member note */}
        <div
          style={{
            fontSize: 12.5,
            color: "var(--muted)",
            display: "flex",
            alignItems: "baseline",
            gap: 8,
            fontFamily: SANS,
          }}
        >
          <span
            style={{
              fontFamily: MONO,
              fontSize: 10,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              color: "var(--faint)",
            }}
          >
            member
          </span>
          <span>
            You can propose edits. Publishing, sharing, moving and deleting are admin-only.
          </span>
        </div>

        {shareOpen && (
          <ShareModal docSlug={slug} versions={versions} onClose={() => setShareOpen(false)} />
        )}
      </div>
    );
  }

  // ── Admin / owner variant ───────────────────────────────────────────────────
  return (
    <>
      {/* Keyframe styles (only injected once — safe in React, idempotent in DOM) */}
      <style>{`
        @keyframes fadeUp {
          from { opacity: 0; transform: translateY(6px); }
          to   { opacity: 1; transform: none; }
        }
        @keyframes menuIn {
          from { opacity: 0; transform: translateY(-4px) scale(0.98); }
          to   { opacity: 1; transform: none; }
        }
      `}</style>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 20,
          flexWrap: "wrap",
        }}
      >
        {/* PRIMARY — Share */}
        <button
          type="button"
          onClick={() => setShareOpen(true)}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 7,
            fontSize: 13,
            fontWeight: 500,
            padding: "7px 15px",
            borderRadius: 8,
            border: "none",
            background: "var(--accent)",
            color: "#fff",
            cursor: "pointer",
            fontFamily: SANS,
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.opacity = "0.9"; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.opacity = "1"; }}
        >
          <ShareCircle color="#fff" />
          Share
        </button>

        {/* SECONDARY — Edit (admin/owner opens editor that publishes directly) */}
        {canEdit && (
          <a
            href={`/docs/${slug}/edit`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              fontSize: 13,
              fontWeight: 500,
              padding: "7px 14px",
              borderRadius: 8,
              border: "1px solid var(--hairline)",
              background: "var(--surface)",
              color: "var(--ink)",
              cursor: "pointer",
              fontFamily: SANS,
              textDecoration: "none",
              lineHeight: 1,
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLAnchorElement).style.background = "var(--hover)";
              (e.currentTarget as HTMLAnchorElement).style.borderColor = "var(--hairline-strong)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLAnchorElement).style.background = "var(--surface)";
              (e.currentTarget as HTMLAnchorElement).style.borderColor = "var(--hairline)";
            }}
          >
            Edit
          </a>
        )}

        {/* Owner meta — shown near the action cluster for both admin and owner variants */}
        {ownerDisplayName && (
          <span style={{ fontSize: 11.5, color: "var(--faint)", fontFamily: MONO }}>
            owner: {ownerDisplayName}
          </span>
        )}

        {/* OVERFLOW ⋯ */}
        <div style={{ position: "relative" }}>
          <button
            type="button"
            aria-label="More actions"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((o) => !o);
            }}
            style={{
              width: 34,
              height: 34,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 8,
              border: `1px solid ${menuOpen ? "var(--hairline-strong)" : "var(--hairline)"}`,
              background: menuOpen ? "var(--hover)" : "var(--surface)",
              color: "var(--ink)",
              cursor: "pointer",
              fontSize: 17,
              lineHeight: 1,
              fontFamily: SANS,
            }}
            onMouseEnter={(e) => {
              if (!menuOpen) {
                (e.currentTarget as HTMLButtonElement).style.background = "var(--hover)";
                (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--hairline-strong)";
              }
            }}
            onMouseLeave={(e) => {
              if (!menuOpen) {
                (e.currentTarget as HTMLButtonElement).style.background = "var(--surface)";
                (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--hairline)";
              }
            }}
          >
            ⋯
          </button>

          {menuOpen && (
            <OverflowMenu items={overflowItems} onClose={() => setMenuOpen(false)} />
          )}
        </div>

        {error && (
          <span style={{ fontSize: 12, color: "var(--danger-ink)", fontFamily: SANS }}>{error}</span>
        )}
      </div>

      {/* Overlays */}
      {shareOpen && (
        <ShareModal docSlug={slug} versions={versions} onClose={() => setShareOpen(false)} />
      )}

      {moveOpen && (
        <MoveDialog
          slug={slug}
          path={path}
          folders={folders}
          onClose={() => setMoveOpen(false)}
        />
      )}

      {deleteOpen && (
        <DeleteDialog
          slug={slug}
          title={title}
          onClose={() => setDeleteOpen(false)}
          onDeleted={() => {
            setDeleteOpen(false);
            setShowToast(true);
          }}
        />
      )}

      {uploadVersionOpen && (
        <UploadVersionDialog
          slug={slug}
          onClose={() => setUploadVersionOpen(false)}
          onPublished={() => setUploadVersionOpen(false)}
        />
      )}

      {setOwnerOpen && (
        <SetOwnerDialog
          slug={slug}
          currentOwnerName={ownerDisplayName ?? null}
          onClose={() => setSetOwnerOpen(false)}
          onChanged={() => setSetOwnerOpen(false)}
        />
      )}

      {showToast && <DeleteToast onDismiss={() => setShowToast(false)} />}
    </>
  );
}
