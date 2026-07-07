"use client";

import { useState } from "react";
import { MD_READER_WIDTH } from "./reader-width";

/**
 * Partner-register "suggest an edit" affordance for /s/[token] (md docs only,
 * shown only when the share's owner enabled edits). Mirrors ShareComments: the
 * raw token is the capability, identity is FORCED server-side ("link:<label>"),
 * and nothing here is trusted for auth. The visitor edits a plain-text copy of
 * the current source + an optional note; on submit the suggestion queues as a
 * revision the OWNER reviews (existing diff UI) and accepts (→ git commit) or
 * rejects — the visitor just gets a "the owner will review" confirmation.
 *
 * SECURITY: this is a suggestion, not a publish — the textarea content is sent
 * verbatim to the suggest API and never rendered as HTML here. Every server
 * failure mode is a uniform 404; the UI degrades to a generic error.
 */
export default function SuggestEdit({
  token,
  label,
  source,
  endpoint,
}: {
  token: string;
  label: string;
  /** The current doc source (markdown) — the editor's starting point. */
  source: string;
  /**
   * POST target. Defaults to the doc-share endpoint `/api/s/<token>/suggest`. A
   * directory-share per-doc reader passes `/api/s/<token>/<slug>/suggest`.
   */
  endpoint?: string;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(source);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const content = draft;
    if (content.trim().length === 0 || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const postUrl = endpoint ?? `/api/s/${encodeURIComponent(token)}/suggest`;
      const res = await fetch(postUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content, note: note.trim() || undefined }),
      });
      if (res.status === 429) {
        setError("You're suggesting edits a little fast — give it a while and try again.");
        return;
      }
      if (!res.ok) {
        setError("Sorry, that suggestion couldn't be submitted. Please try again.");
        return;
      }
      setDone(true);
      setOpen(false);
    } catch {
      setError("Network error — your suggestion wasn't submitted.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section
      style={{
        maxWidth: MD_READER_WIDTH,
        margin: "0 auto",
        padding: "0 24px 40px",
        fontFamily: "var(--font-serif)",
      }}
    >
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          letterSpacing: "0.05em",
          textTransform: "uppercase",
          color: "var(--faint)",
          marginBottom: 14,
        }}
      >
        Suggest an edit
      </div>

      {done ? (
        <p style={{ fontSize: 14, color: "var(--muted)", margin: 0 }}>
          Thanks — your suggestion was submitted. The owner will review it.
        </p>
      ) : !open ? (
        <div>
          <p style={{ fontSize: 14, color: "var(--muted)", margin: "0 0 12px" }}>
            Spotted something? Propose a change — the owner reviews every
            suggestion before anything is published.
          </p>
          <button
            type="button"
            onClick={() => setOpen(true)}
            style={{
              fontSize: 13,
              fontWeight: 500,
              padding: "7px 16px",
              borderRadius: 7,
              border: "1px solid var(--accent)",
              background: "transparent",
              color: "var(--accent)",
              cursor: "pointer",
              fontFamily: "var(--font-sans)",
            }}
          >
            Suggest an edit
          </button>
        </div>
      ) : (
        <form onSubmit={submit}>
          <div style={{ fontSize: 12.5, color: "var(--muted)", marginBottom: 6 }}>
            suggesting as <strong style={{ fontWeight: 600 }}>{label}</strong> (via link)
          </div>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-label="Proposed document body"
            rows={16}
            style={{
              width: "100%",
              padding: "10px 12px",
              fontSize: 13,
              fontFamily: "var(--font-mono)",
              border: "1px solid var(--hairline)",
              borderRadius: 8,
              background: "var(--surface)",
              color: "var(--ink)",
              outline: "none",
              resize: "vertical",
            }}
          />
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional note — what did you change?"
            aria-label="Optional note about the change"
            style={{
              width: "100%",
              marginTop: 8,
              padding: "8px 12px",
              fontSize: 13,
              fontFamily: "var(--font-serif)",
              border: "1px solid var(--hairline)",
              borderRadius: 8,
              background: "var(--surface)",
              color: "var(--ink)",
              outline: "none",
            }}
          />
          {error && (
            <div style={{ marginTop: 6, fontSize: 12.5, color: "var(--danger-ink)" }}>{error}</div>
          )}
          <div style={{ marginTop: 8, display: "flex", gap: 10 }}>
            <button
              type="submit"
              disabled={submitting || draft.trim().length === 0}
              style={{
                fontSize: 13,
                fontWeight: 500,
                padding: "7px 16px",
                borderRadius: 7,
                border: "1px solid var(--accent)",
                background: "var(--accent)",
                color: "var(--bg)",
                cursor: draft.trim().length === 0 ? "default" : "pointer",
                opacity: draft.trim().length === 0 || submitting ? 0.5 : 1,
                fontFamily: "var(--font-sans)",
              }}
            >
              {submitting ? "Submitting…" : "Submit suggestion"}
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setError(null);
                setDraft(source);
                setNote("");
              }}
              disabled={submitting}
              style={{
                fontSize: 13,
                fontWeight: 500,
                padding: "7px 16px",
                borderRadius: 7,
                border: "1px solid var(--hairline)",
                background: "var(--surface)",
                color: "var(--muted)",
                cursor: "pointer",
                fontFamily: "var(--font-sans)",
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
