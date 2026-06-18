"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, useEffect, useRef } from "react";
import Link from "next/link";
import ShareModal from "@/components/ShareModal";
import PathPicker from "@/components/PathPicker";
import { slugFromFilename, titleFromContent, isValidSlug, randomSlug } from "@/lib/slug";
import { isValidPath } from "@/lib/path";
import {
  ACCEPT_EXTENSIONS,
  MAX_UPLOAD_BYTES,
  formatFromFilename,
  acceptFile,
  validateUpload,
} from "./upload-model";

/**
 * Admin-only "Upload" island for the /docs list header.
 *
 * Reads a chosen .md/.markdown/.html/.htm file client-side (File.text()),
 * prefills slug (slugFromFilename) + title (titleFromContent for md, filename
 * for html), then POSTs to /api/docs with sourcePath `upload:<filename>`. A new
 * doc lands in the `private` audience (Audiences v2) — set its audience after
 * from the doc page's Sharing panel; there's no audience picker here anymore. On
 * success it shows confirmation with
 * "Open doc" + "Share now" — Share now embeds the existing ShareModal directly
 * (its props are {docSlug,onClose}; reusing it avoids a navigation round-trip).
 *
 * Server enforcement is the source of truth: the POST route is admin-only and
 * caps content size; this island's checks are friendly fast-fail UX, not gates.
 */

type Selected = {
  filename: string;
  byteSize: number;
  content: string;
  format: "md" | "html";
};

type Phase =
  | { kind: "form" }
  | { kind: "submitting" }
  | { kind: "done"; slug: string; versionNumber: number; isNewDoc: boolean };

export default function UploadDoc({ folders = [] }: { folders?: string[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [, startTransition] = useTransition();

  const [selected, setSelected] = useState<Selected | null>(null);
  const [slug, setSlug] = useState("");
  const [title, setTitle] = useState("");
  const [path, setPath] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "form" });
  const [error, setError] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  // Existing slugs, fetched once when the modal opens, so we can honestly warn
  // that publishing to a known slug adds a new version rather than a new doc.
  const [existingSlugs, setExistingSlugs] = useState<Set<string> | null>(null);

  // Full-page drag-to-upload overlay state.
  // dragDepth tracks enter/leave pairs to avoid flicker when moving over children.
  const [dragOver, setDragOver] = useState(false);
  const [dragError, setDragError] = useState<string | null>(null);
  const dragDepth = useRef(0);

  useEffect(() => {
    function onDragEnter(e: DragEvent) {
      e.preventDefault();
      dragDepth.current += 1;
      if (dragDepth.current === 1) setDragOver(true);
    }
    function onDragOver(e: DragEvent) {
      // Must preventDefault so the browser treats this as a valid drop target.
      e.preventDefault();
    }
    function onDragLeave() {
      dragDepth.current -= 1;
      if (dragDepth.current <= 0) {
        dragDepth.current = 0;
        setDragOver(false);
        setDragError(null);
      }
    }
    async function onDrop(e: DragEvent) {
      e.preventDefault();
      dragDepth.current = 0;
      setDragOver(false);
      const file = e.dataTransfer?.files?.[0] ?? null;
      if (!file) return;
      const fmt = acceptFile(file.name);
      if (fmt === null) {
        setDragError("Unsupported type — drop a .md or .html file.");
        // Clear the transient error after 3 s.
        setTimeout(() => setDragError(null), 3000);
        return;
      }
      setDragError(null);
      // Open the upload panel and prefill with the dropped file.
      await openModal();
      await onFile(file);
    }
    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function reset() {
    setSelected(null);
    setSlug("");
    setTitle("");
    setPath("");
    setPhase({ kind: "form" });
    setError(null);
    setShareOpen(false);
  }

  function close() {
    setOpen(false);
    reset();
  }

  async function openModal() {
    setOpen(true);
    // Best-effort: a failed fetch just means no warning (the API still treats a
    // duplicate slug as a re-publish either way).
    try {
      const res = await fetch("/api/docs");
      if (res.ok) {
        const data = (await res.json()) as { docs?: Array<{ slug?: string }> };
        setExistingSlugs(new Set((data.docs ?? []).map((d) => d.slug).filter((s): s is string => !!s)));
      }
    } catch {
      // ignore — warning is informational only
    }
  }

  async function onFile(file: File | null) {
    setError(null);
    if (!file) {
      setSelected(null);
      return;
    }
    const format = formatFromFilename(file.name);
    if (format === null) {
      setSelected(null);
      setError("Unsupported file type — upload .md, .markdown, .html, or .htm.");
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setSelected(null);
      setError("File too large — the limit is 2 MB.");
      return;
    }
    const content = await file.text();
    setSelected({ filename: file.name, byteSize: file.size, content, format });
    setSlug(randomSlug());
    setTitle(
      format === "md"
        ? titleFromContent(content, file.name)
        : file.name,
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!selected) {
      setError("Choose a file first.");
      return;
    }
    const v = validateUpload({
      filename: selected.filename,
      byteSize: selected.byteSize,
      slug,
      title,
    });
    if (!v.ok) {
      setError(v.error);
      return;
    }
    const trimmedPath = path.trim();
    if (trimmedPath.length > 0 && !isValidPath(trimmedPath)) {
      setError("Invalid folder — use lowercase letters, digits, dashes; slashes for sub-folders (max 6 deep).");
      return;
    }
    setError(null);
    setPhase({ kind: "submitting" });
    try {
      const res = await fetch("/api/docs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug,
          title: title.trim(),
          sourcePath: `upload:${selected.filename}`,
          // No audience → server defaults the new doc to `private` (Audiences
          // v2). Set the audience afterward from the doc page's Sharing panel.
          format: v.format,
          content: selected.content,
          ...(trimmedPath.length > 0 ? { path: trimmedPath } : {}),
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? `Upload failed (${res.status})`);
        setPhase({ kind: "form" });
        return;
      }
      const data = (await res.json()) as { slug: string; versionNumber: number; isNewDoc: boolean };
      // Refresh the list behind the modal so the new doc appears.
      startTransition(() => router.refresh());
      setPhase({ kind: "done", slug: data.slug, versionNumber: data.versionNumber, isNewDoc: data.isNewDoc });
    } catch {
      setError("Network error — doc not uploaded.");
      setPhase({ kind: "form" });
    }
  }

  const slugValid = slug === "" || isValidSlug(slug);
  const isRepublish =
    isValidSlug(slug) && existingSlugs !== null && existingSlugs.has(slug);

  const headerBtn = {
    fontSize: 13.5,
    fontWeight: 500,
    padding: "9px 14px",
    borderRadius: 8,
    border: "none",
    background: "var(--accent)",
    color: "#fff",
    cursor: "pointer",
    fontFamily: "var(--font-sans)",
    whiteSpace: "nowrap" as const,
  };

  const fieldLabel = {
    display: "block" as const,
    fontSize: 11.5,
    fontWeight: 600,
    color: "var(--muted)",
    marginBottom: 6,
  };

  const fieldInput = {
    display: "block" as const,
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
  };

  return (
    <>
      <button type="button" onClick={openModal} style={headerBtn}>
        Upload
      </button>

      {/* Full-page drag overlay — shown when a file is dragged anywhere over the page */}
      {(dragOver || dragError) && (
        <div
          aria-live="assertive"
          aria-label={dragError ?? "Drop to upload"}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 80,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "none",
            background: dragError
              ? "rgba(220, 38, 38, 0.08)"
              : "rgba(var(--accent-rgb, 99, 102, 241), 0.08)",
          }}
        >
          <div
            style={{
              border: `2px dashed ${dragError ? "var(--danger-border, #ef4444)" : "var(--accent, #6366f1)"}`,
              borderRadius: 16,
              padding: "48px 64px",
              background: "var(--surface)",
              textAlign: "center",
              boxShadow: "0 8px 32px rgba(0,0,0,0.12)",
            }}
          >
            <div
              style={{
                fontSize: 32,
                marginBottom: 12,
                color: dragError ? "var(--danger-ink, #dc2626)" : "var(--accent, #6366f1)",
              }}
            >
              {dragError ? "✕" : "↓"}
            </div>
            <div
              style={{
                fontSize: 16,
                fontWeight: 600,
                color: dragError ? "var(--danger-ink, #dc2626)" : "var(--ink)",
                marginBottom: 6,
              }}
            >
              {dragError ?? "Drop to upload"}
            </div>
            {!dragError && (
              <div style={{ fontSize: 12.5, color: "var(--muted)", fontFamily: "var(--font-mono)" }}>
                .md / .html
              </div>
            )}
          </div>
        </div>
      )}

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Upload a doc"
          onClick={close}
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
              padding: "22px 22px 20px",
              color: "var(--ink)",
              maxHeight: "calc(100vh - 40px)",
              overflowY: "auto",
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
              <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>
                {phase.kind === "done" ? "Published" : "Upload a doc"}
              </h2>
              <button
                type="button"
                onClick={close}
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
                <p style={{ margin: "0 0 14px", fontSize: 13, color: "var(--muted)" }}>
                  Published <strong style={{ color: "var(--ink)" }}>{phase.slug}</strong>{" "}
                  (v{phase.versionNumber}).{!phase.isNewDoc && " Uploading to an existing slug adds a new version."}
                </p>
                <div style={{ display: "flex", gap: 8 }}>
                  <Link
                    href={`/docs/${phase.slug}`}
                    style={{
                      fontSize: 12.5,
                      fontWeight: 500,
                      padding: "8px 14px",
                      borderRadius: 8,
                      border: "1px solid var(--hairline)",
                      background: "var(--surface)",
                      color: "var(--ink)",
                      cursor: "pointer",
                      textDecoration: "none",
                    }}
                  >
                    Open doc
                  </Link>
                  <button
                    type="button"
                    onClick={() => setShareOpen(true)}
                    style={{
                      fontSize: 12.5,
                      fontWeight: 500,
                      padding: "8px 16px",
                      borderRadius: 8,
                      border: "none",
                      background: "var(--accent)",
                      color: "#fff",
                      cursor: "pointer",
                    }}
                  >
                    Share now
                  </button>
                </div>
              </div>
            ) : (
              <form onSubmit={submit}>
                <label style={fieldLabel}>
                  File (.md, .markdown, .html, .htm)
                  <input
                    type="file"
                    accept={ACCEPT_EXTENSIONS}
                    onChange={(e) => onFile(e.target.files?.[0] ?? null)}
                    style={{
                      display: "block",
                      width: "100%",
                      marginTop: 6,
                      fontSize: 12.5,
                      color: "var(--ink)",
                    }}
                  />
                </label>

                {selected && (
                  <>
                    <label style={{ ...fieldLabel, margin: "14px 0 0" }}>
                      Slug
                      <input
                        value={slug}
                        onChange={(e) => setSlug(e.target.value)}
                        style={{
                          ...fieldInput,
                          borderColor: slugValid ? "var(--hairline)" : "var(--danger-border)",
                        }}
                      />
                    </label>
                    {!slugValid && (
                      <p style={{ margin: "6px 0 0", fontSize: 11.5, color: "var(--danger-ink)" }}>
                        Must match ^[a-z0-9][a-z0-9-]*$ — lowercase letters, digits, dashes.
                      </p>
                    )}
                    {slugValid && isRepublish && (
                      <p style={{ margin: "6px 0 0", fontSize: 11.5, color: "var(--warn-ink)" }}>
                        Publishes a new version of <strong>{slug}</strong> (an existing doc).
                      </p>
                    )}

                    <label style={{ ...fieldLabel, margin: "14px 0 0" }}>
                      Title
                      <input
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        style={fieldInput}
                      />
                    </label>

                    <div style={{ marginTop: 14 }}>
                      <label style={fieldLabel}>Folder (optional)</label>
                      <PathPicker
                        value={path}
                        onChange={setPath}
                        existingFolders={folders}
                        placeholder="(root) — or type a path"
                        invalid={path.trim() !== "" && !isValidPath(path.trim())}
                      />
                    </div>
                    {path.trim() !== "" && !isValidPath(path.trim()) && (
                      <p style={{ margin: "6px 0 0", fontSize: 11.5, color: "var(--danger-ink)" }}>
                        Folders are lowercase letters, digits, dashes; use “/” for sub-folders (max 6 deep).
                      </p>
                    )}

                    <p
                      style={{
                        margin: "14px 0 0",
                        fontSize: 11.5,
                        lineHeight: 1.5,
                        color: "var(--faint)",
                      }}
                    >
                      New docs publish as <strong style={{ color: "var(--muted)" }}>private</strong> (only you +
                      admins). Set who sees it from the doc&rsquo;s <strong style={{ color: "var(--muted)" }}>Sharing</strong> panel after.
                    </p>

                    <label style={{ ...fieldLabel, margin: "14px 0 0" }}>
                      Format
                      <input
                        readOnly
                        value={selected.format}
                        style={{
                          ...fieldInput,
                          fontFamily: "var(--font-mono)",
                          color: "var(--muted)",
                          cursor: "default",
                        }}
                      />
                    </label>
                  </>
                )}

                {error && (
                  <p style={{ margin: "12px 0 0", fontSize: 12.5, color: "var(--danger-ink)" }}>
                    {error}
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
                    onClick={close}
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
                    disabled={phase.kind === "submitting" || !selected}
                    style={{
                      fontSize: 12.5,
                      fontWeight: 500,
                      padding: "8px 16px",
                      borderRadius: 8,
                      border: "none",
                      background: "var(--accent)",
                      color: "#fff",
                      cursor: phase.kind === "submitting" || !selected ? "default" : "pointer",
                      opacity: phase.kind === "submitting" || !selected ? 0.6 : 1,
                    }}
                  >
                    {phase.kind === "submitting" ? "Publishing…" : "Publish"}
                  </button>
                </div>
              </form>
            )}
          </div>

          {shareOpen && phase.kind === "done" && (
            <ShareModal docSlug={phase.slug} onClose={() => setShareOpen(false)} />
          )}
        </div>
      )}
    </>
  );
}
