"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import CodeMirror, { EditorView } from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import Markdown from "@/components/Markdown";
import { MAX_REVISION_NOTE_CHARS } from "@/lib/limits";

/**
 * Markdown editor island for proposing a revision. Lazy-loaded via next/dynamic
 * (ssr:false) from a thin client wrapper so reader routes never pull CodeMirror.
 *
 * SECURITY: the live preview renders the draft ONLY through <Markdown> (escaped
 * — no raw HTML). The note is plain-text. The submit POSTs the draft to the
 * staff-scoped revisions API, which re-validates scope / format / caps.
 */

// A minimal CodeMirror theme keyed to the design tokens. One config serves both
// light and dark — colours come from CSS variables that flip with data-theme,
// so the editor reads correctly in either mode without a second theme object.
const tokenTheme = EditorView.theme({
  "&": {
    backgroundColor: "var(--surface)",
    color: "var(--ink)",
    fontSize: "13.5px",
    border: "1px solid var(--hairline)",
    borderRadius: "8px",
  },
  "&.cm-focused": { outline: "none", borderColor: "var(--accent)" },
  ".cm-content": {
    fontFamily: "var(--font-mono)",
    caretColor: "var(--ink)",
    padding: "12px 0",
  },
  ".cm-gutters": {
    backgroundColor: "var(--surface-alt)",
    color: "var(--faint)",
    border: "none",
    borderRight: "1px solid var(--hairline)",
  },
  ".cm-activeLine": { backgroundColor: "var(--surface-alt)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--surface-alt)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "var(--accent-ring)",
  },
  ".cm-cursor": { borderLeftColor: "var(--ink)" },
});

export default function EditorIsland({
  slug,
  initialContent,
  canPublishDirect = false,
}: {
  slug: string;
  initialContent: string;
  /** When true, saves via POST /publish (direct, no approval); false → /revisions (propose). */
  canPublishDirect?: boolean;
}) {
  const router = useRouter();
  const [content, setContent] = useState(initialContent);
  const [note, setNote] = useState("");
  const [preview, setPreview] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const extensions = useMemo(() => [markdown(), tokenTheme, EditorView.lineWrapping], []);
  const dirty = content !== initialContent;
  const canSubmit = content.trim().length > 0 && !submitting;

  async function submit() {
    setError(null);
    setSubmitting(true);
    try {
      if (canPublishDirect) {
        // Owner / admin path: POST directly to /publish, return to doc.
        const res = await fetch(`/api/docs/${encodeURIComponent(slug)}/publish`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => null)) as { error?: string } | null;
          setError(data?.error ?? `Could not publish (${res.status})`);
          setSubmitting(false);
          return;
        }
        // Return to doc — new version is live.
        router.push(`/docs/${encodeURIComponent(slug)}`);
        router.refresh();
      } else {
        // Member path: propose a revision for review.
        const res = await fetch(`/api/docs/${encodeURIComponent(slug)}/revisions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content, note: note.trim() || undefined }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => null)) as { error?: string } | null;
          setError(data?.error ?? `Could not propose edit (${res.status})`);
          setSubmitting(false);
          return;
        }
        // Back to the doc page with a confirmation flag the page reads.
        router.push(`/docs/${encodeURIComponent(slug)}?proposed=1`);
        router.refresh();
      }
    } catch {
      setError(canPublishDirect ? "Network error — version not published." : "Network error — edit not proposed.");
      setSubmitting(false);
    }
  }

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginBottom: 12,
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", gap: 4 }}>
          <ToggleBtn active={!preview} onClick={() => setPreview(false)}>
            Edit
          </ToggleBtn>
          <ToggleBtn active={preview} onClick={() => setPreview(true)}>
            Preview
          </ToggleBtn>
        </div>
        <span style={{ fontSize: 12, color: "var(--faint)", fontFamily: "var(--font-mono)" }}>
          {dirty ? "unsaved changes" : "no changes yet"}
        </span>
      </div>

      {preview ? (
        <div
          style={{
            border: "1px solid var(--hairline)",
            borderRadius: 8,
            padding: "16px 20px",
            background: "var(--surface)",
            minHeight: 200,
          }}
        >
          {/* Draft renders ONLY through the escaped Markdown component. */}
          <Markdown content={content} register="operator" />
        </div>
      ) : (
        <CodeMirror
          value={content}
          onChange={(v) => setContent(v)}
          extensions={extensions}
          basicSetup={{ lineNumbers: true, foldGutter: false, highlightActiveLine: true }}
          aria-label="Markdown editor"
        />
      )}

      {/* Note is only meaningful for the propose path — owners publish directly. */}
      {!canPublishDirect && (
        <div style={{ marginTop: 16 }}>
          <label
            htmlFor="revision-note"
            style={{
              display: "block",
              fontSize: 12,
              fontFamily: "var(--font-mono)",
              color: "var(--muted)",
              marginBottom: 6,
            }}
          >
            Note (optional)
          </label>
          <input
            id="revision-note"
            value={note}
            maxLength={MAX_REVISION_NOTE_CHARS}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What did you change, and why?"
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
            }}
          />
        </div>
      )}

      {error && (
        <div style={{ marginTop: 10, fontSize: 12.5, color: "var(--danger-ink)" }}>{error}</div>
      )}

      <div style={{ marginTop: 16, display: "flex", gap: 10, alignItems: "center" }}>
        <button
          type="button"
          onClick={submit}
          disabled={!canSubmit}
          style={{
            fontSize: 12.5,
            fontWeight: 500,
            padding: "7px 16px",
            borderRadius: 7,
            border: "1px solid var(--accent)",
            background: "var(--accent)",
            color: "var(--bg)",
            cursor: canSubmit ? "pointer" : "default",
            opacity: canSubmit ? 1 : 0.5,
            fontFamily: "var(--font-sans)",
          }}
        >
          {submitting
            ? (canPublishDirect ? "Publishing…" : "Submitting…")
            : (canPublishDirect ? "Publish new version" : "Propose edit")}
        </button>
        <button
          type="button"
          onClick={() => router.push(`/docs/${encodeURIComponent(slug)}`)}
          style={{
            fontSize: 12.5,
            fontWeight: 500,
            padding: "7px 14px",
            borderRadius: 7,
            border: "1px solid var(--hairline)",
            background: "var(--surface)",
            color: "var(--ink)",
            cursor: "pointer",
            fontFamily: "var(--font-sans)",
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function ToggleBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        fontSize: 12,
        fontWeight: 500,
        padding: "5px 12px",
        borderRadius: 6,
        border: `1px solid ${active ? "var(--accent)" : "var(--hairline)"}`,
        background: active ? "var(--accent)" : "var(--surface)",
        color: active ? "var(--bg)" : "var(--muted)",
        cursor: "pointer",
        fontFamily: "var(--font-mono)",
      }}
    >
      {children}
    </button>
  );
}
