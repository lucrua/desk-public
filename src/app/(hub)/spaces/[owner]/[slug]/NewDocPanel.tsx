"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

/**
 * New-doc panel (Web-author W1.4). An owner/writer types a title + body and
 * POSTs to /api/spaces/[slug]/docs — the server turns the save into ONE git
 * commit and re-projects. Under `proposal` push-policy a non-owner writer's save
 * opens a `proposals/<handle>` ref instead of touching main; the panel reports
 * which happened.
 *
 * Token-styled like MembersPanel (inline styles over CSS variables). The body is
 * a plain <textarea> — the CodeMirror editor stays on the dedicated edit page;
 * this is a fast "dump a note" affordance, the core of Lucas's use case.
 */
export default function NewDocPanel({
  slug,
  pushPolicy,
  canPublishDirect,
}: {
  slug: string;
  pushPolicy: "direct" | "proposal";
  /** True for owner/admin — direct commit to main. False → a writer under
   * proposal policy, whose save opens a proposal. */
  canPublishDirect: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [folder, setFolder] = useState("");
  const [content, setContent] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const willPropose = !canPublishDirect && pushPolicy === "proposal";
  const canSubmit = content.trim().length > 0 && !submitting;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setDone(null);
    setSubmitting(true);
    try {
      const res = await fetch(`/api/spaces/${slug}/docs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: title.trim() || undefined,
          path: folder.trim() || undefined,
          content,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? `Could not save (${res.status})`);
        setSubmitting(false);
        return;
      }
      const data = (await res.json()) as { target: string; slug?: string };
      setTitle("");
      setFolder("");
      setContent("");
      setSubmitting(false);
      setDone(
        data.target === "proposal"
          ? "Saved as a proposal — the owner can review and accept it."
          : "Saved and published.",
      );
      startTransition(() => router.refresh());
    } catch {
      setError("Network error — nothing was saved.");
      setSubmitting(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={primaryBtn}
        disabled={pending}
      >
        + New doc
      </button>
    );
  }

  return (
    <form onSubmit={submit} style={{ display: "grid", gap: 10 }}>
      <input
        aria-label="Title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Title (optional)"
        style={inputStyle}
      />
      <input
        aria-label="Folder path"
        value={folder}
        onChange={(e) => setFolder(e.target.value)}
        placeholder="folder/path (optional, e.g. notes)"
        style={inputStyle}
      />
      <textarea
        aria-label="Body"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="Write markdown here…"
        rows={8}
        style={{ ...inputStyle, fontFamily: "var(--font-mono)", resize: "vertical" }}
      />
      {willPropose && (
        <p style={{ margin: 0, fontSize: 11.5, color: "var(--muted)" }}>
          This space requires proposals — your save will open a PR for the owner.
        </p>
      )}
      {error && <p style={{ margin: 0, fontSize: 11.5, color: "var(--danger-ink)" }}>{error}</p>}
      {done && <p style={{ margin: 0, fontSize: 11.5, color: "var(--accent)" }}>{done}</p>}
      <div style={{ display: "flex", gap: 8 }}>
        <button type="submit" disabled={!canSubmit} style={{ ...primaryBtn, opacity: canSubmit ? 1 : 0.5 }}>
          {submitting ? "Saving…" : willPropose ? "Save as proposal" : "Save doc"}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setError(null);
            setDone(null);
          }}
          style={secondaryBtn}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

const inputStyle = {
  width: "100%",
  padding: "8px 12px",
  fontSize: 13.5,
  fontFamily: "var(--font-sans)",
  border: "1px solid var(--hairline)",
  borderRadius: 8,
  background: "var(--surface)",
  color: "var(--ink)",
  outline: "none",
  boxSizing: "border-box" as const,
} as const;

const primaryBtn = {
  fontSize: 12.5,
  fontWeight: 500,
  padding: "7px 16px",
  borderRadius: 7,
  border: "1px solid var(--accent)",
  background: "var(--accent)",
  color: "#fff",
  cursor: "pointer",
  fontFamily: "var(--font-sans)",
} as const;

const secondaryBtn = {
  fontSize: 12.5,
  fontWeight: 500,
  padding: "7px 14px",
  borderRadius: 7,
  border: "1px solid var(--hairline)",
  background: "var(--surface)",
  color: "var(--ink)",
  cursor: "pointer",
  fontFamily: "var(--font-sans)",
} as const;
