"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";

/**
 * Upload panel (Web-author W1.4). An owner/writer drops a file; the panel POSTs
 * a multipart body to /api/spaces/[owner]/[slug]/docs and the server commits the
 * bytes byte-for-byte into the space's git repo (truth-in-git). A markdown/HTML
 * upload projects + renders as a doc; any other file is served raw and appears in
 * the file view. Token-styled, matches MembersPanel/NewDocPanel.
 */
export default function UploadPanel({
  owner,
  slug,
  pushPolicy,
  canPublishDirect,
}: {
  owner: string;
  slug: string;
  pushPolicy: "direct" | "proposal";
  canPublishDirect: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [folder, setFolder] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const willPropose = !canPublishDirect && pushPolicy === "proposal";
  const canSubmit = file != null && !submitting;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setError(null);
    setDone(null);
    setSubmitting(true);
    try {
      const fd = new FormData();
      fd.set("file", file);
      if (folder.trim()) fd.set("path", folder.trim());
      const res = await fetch(`/api/spaces/${owner}/${slug}/docs`, { method: "POST", body: fd });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? `Upload failed (${res.status})`);
        setSubmitting(false);
        return;
      }
      const data = (await res.json()) as { target: string; path?: string };
      setFile(null);
      if (inputRef.current) inputRef.current.value = "";
      setSubmitting(false);
      setDone(
        data.target === "proposal"
          ? `Uploaded as a proposal (${data.path}).`
          : `Uploaded ${data.path}.`,
      );
      startTransition(() => router.refresh());
    } catch {
      setError("Network error — nothing was uploaded.");
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} style={{ display: "grid", gap: 10 }}>
      <input
        ref={inputRef}
        type="file"
        aria-label="File to upload"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        style={{ fontSize: 12.5, color: "var(--ink)" }}
      />
      <input
        aria-label="Folder path"
        value={folder}
        onChange={(e) => setFolder(e.target.value)}
        placeholder="folder/path (optional, e.g. assets)"
        style={{
          width: "100%",
          padding: "8px 12px",
          fontSize: 13.5,
          fontFamily: "var(--font-sans)",
          border: "1px solid var(--hairline)",
          borderRadius: 8,
          background: "var(--surface)",
          color: "var(--ink)",
          outline: "none",
          boxSizing: "border-box",
        }}
      />
      {willPropose && (
        <p style={{ margin: 0, fontSize: 11.5, color: "var(--muted)" }}>
          This space requires proposals — your upload will open a PR for the owner.
        </p>
      )}
      {error && <p style={{ margin: 0, fontSize: 11.5, color: "var(--danger-ink)" }}>{error}</p>}
      {done && <p style={{ margin: 0, fontSize: 11.5, color: "var(--accent)" }}>{done}</p>}
      <button
        type="submit"
        disabled={!canSubmit || pending}
        style={{
          justifySelf: "start",
          fontSize: 12.5,
          fontWeight: 500,
          padding: "7px 16px",
          borderRadius: 7,
          border: "1px solid var(--accent)",
          background: "var(--accent)",
          color: "#fff",
          cursor: canSubmit ? "pointer" : "default",
          opacity: canSubmit ? 1 : 0.5,
          fontFamily: "var(--font-sans)",
        }}
      >
        {submitting ? "Uploading…" : "Upload file"}
      </button>
    </form>
  );
}
