"use client";

import { useState } from "react";
import Markdown from "@/components/Markdown";
import {
  authorChip,
  commentStamp,
  type CommentDTO,
} from "@/app/(hub)/docs/[slug]/comments-view-model";
import { MD_READER_WIDTH } from "./reader-width";

/**
 * Partner-register comment thread + minimal composer for /s/[token]. Rendered
 * BELOW the footer divider, only when the share permits comments.
 *
 * The visitor comments AS the share's label ("commenting as <label> (via
 * link)"); the server forces the author, so nothing here is trusted for
 * identity. Posting refreshes the thread via the public share-comment API.
 *
 * SECURITY: bodies render ONLY through the escaped <Markdown> component; author
 * labels are plain JSX text. The thread shows only unresolved comments (the API
 * enforces this) — resolved feedback disappears from the visitor's view.
 */
export default function ShareComments({
  token,
  label,
  initial,
  endpoint,
}: {
  token: string;
  label: string;
  initial: CommentDTO[];
  /**
   * POST target for new comments. Defaults to the doc-share endpoint
   * `/api/s/<token>/comments`. A directory-share per-doc reader passes the
   * slug-scoped endpoint `/api/s/<token>/<slug>/comments` (same guard).
   */
  endpoint?: string;
}) {
  const [comments, setComments] = useState<CommentDTO[]>(initial);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const body = draft.trim();
    if (body.length === 0 || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const postUrl =
        endpoint ?? `/api/s/${encodeURIComponent(token)}/comments`;
      const res = await fetch(postUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body }),
      });
      if (res.status === 429) {
        setError("You're commenting a little fast — give it a minute and try again.");
        return;
      }
      if (!res.ok) {
        setError("Sorry, that comment couldn't be posted. Please try again.");
        return;
      }
      const data = (await res.json()) as { comment: CommentDTO };
      setComments((prev) => [...prev, data.comment]);
      setDraft("");
    } catch {
      setError("Network error — your comment wasn't posted.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section
      style={{
        maxWidth: MD_READER_WIDTH,
        margin: "0 auto",
        padding: "0 24px 96px",
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
        Comments
      </div>

      {comments.length === 0 ? (
        <p style={{ fontSize: 14, color: "var(--muted)", margin: "0 0 18px" }}>
          No comments yet — add the first below.
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14, marginBottom: 20 }}>
          {comments.map((c) => {
            const chip = authorChip(c);
            return (
              <div
                key={c.id}
                style={{
                  border: "1px solid var(--hairline)",
                  borderRadius: 10,
                  padding: "12px 14px",
                  background: "var(--surface)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                  <span
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 10.5,
                      padding: "3px 8px",
                      borderRadius: 99,
                      whiteSpace: "nowrap",
                      background:
                        chip.kind === "link" ? "var(--badge-external-bg)" : "var(--badge-team-bg)",
                      color: chip.kind === "link" ? "var(--badge-external-ink)" : "var(--badge-team-ink)",
                    }}
                  >
                    {chip.label}
                  </span>
                  <span
                    style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--faint)" }}
                  >
                    {commentStamp(c.createdAt)}
                  </span>
                </div>
                {/* Body rendered ONLY through the escaped Markdown component. */}
                <Markdown content={c.body} register="partner" />
              </div>
            );
          })}
        </div>
      )}

      <form onSubmit={submit}>
        <div style={{ fontSize: 12.5, color: "var(--muted)", marginBottom: 6 }}>
          commenting as <strong style={{ fontWeight: 600 }}>{label}</strong> (via link)
        </div>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Leave a comment…"
          rows={3}
          aria-label="Leave a comment"
          style={{
            width: "100%",
            padding: "10px 12px",
            fontSize: 14,
            fontFamily: "var(--font-serif)",
            border: "1px solid var(--hairline)",
            borderRadius: 8,
            background: "var(--surface)",
            color: "var(--ink)",
            outline: "none",
            resize: "vertical",
          }}
        />
        {error && (
          <div style={{ marginTop: 6, fontSize: 12.5, color: "var(--danger-ink)" }}>{error}</div>
        )}
        <div style={{ marginTop: 8 }}>
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
            {submitting ? "Posting…" : "Comment"}
          </button>
        </div>
      </form>
    </section>
  );
}
