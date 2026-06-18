"use client";

import { useState, useTransition } from "react";
import Markdown from "@/components/Markdown";
import {
  authorChip,
  commentStamp,
  groupThread,
  type CommentDTO,
} from "./comments-view-model";

/**
 * Operator-register comment thread + composer for /docs/[slug].
 *
 * Client island: the page server-renders the initial thread; this component owns
 * post / resolve / delete interactions and keeps local state in sync without a
 * full page refresh.
 *
 * SECURITY: comment bodies are rendered ONLY through <Markdown> (escaped — no
 * raw HTML). authorName / the chip label are attacker-influenced strings on the
 * link path → rendered as plain JSX text (React escapes). Never interpolated
 * into an HTML sink, href, or src.
 */
export default function Comments({
  slug,
  isAdmin,
  initial,
}: {
  slug: string;
  isAdmin: boolean;
  initial: CommentDTO[];
}) {
  const [comments, setComments] = useState<CommentDTO[]>(initial);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const [pending, startTransition] = useTransition();

  const { open, resolved, resolvedCount } = groupThread(comments);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const body = draft.trim();
    if (body.length === 0) return;
    setError(null);
    try {
      const res = await fetch(`/api/docs/${encodeURIComponent(slug)}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? `Could not post comment (${res.status})`);
        return;
      }
      const data = (await res.json()) as { comment: CommentDTO };
      setComments((prev) => [...prev, data.comment]);
      setDraft("");
    } catch {
      setError("Network error — comment not posted.");
    }
  }

  async function resolve(id: number) {
    setError(null);
    try {
      const res = await fetch(`/api/comments/${id}/resolve`, { method: "POST" });
      if (!res.ok) {
        setError(`Could not resolve (${res.status})`);
        return;
      }
      setComments((prev) =>
        prev.map((c) => (c.id === id ? { ...c, resolvedAt: new Date().toISOString() } : c)),
      );
    } catch {
      setError("Network error — not resolved.");
    }
  }

  async function remove(id: number) {
    if (!window.confirm("Delete this comment? This can't be undone.")) return;
    setError(null);
    try {
      const res = await fetch(`/api/comments/${id}`, { method: "DELETE" });
      if (!res.ok) {
        setError(`Could not delete (${res.status})`);
        return;
      }
      setComments((prev) => prev.filter((c) => c.id !== id));
    } catch {
      setError("Network error — not deleted.");
    }
  }

  return (
    <section style={{ marginTop: 48, borderTop: "1px solid var(--hairline)", paddingTop: 28 }}>
      <h2
        style={{
          fontSize: 13,
          fontWeight: 600,
          fontFamily: "var(--font-mono)",
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          color: "var(--muted)",
          margin: "0 0 16px",
        }}
      >
        Comments{open.length > 0 ? ` · ${open.length}` : ""}
      </h2>

      {open.length === 0 && (
        <p style={{ fontSize: 13, color: "var(--faint)", margin: "0 0 16px" }}>
          No open comments yet.
        </p>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {open.map((c) => (
          <CommentCard key={c.id} c={c} isAdmin={isAdmin} onResolve={resolve} onDelete={remove} />
        ))}
      </div>

      {resolvedCount > 0 && (
        <div style={{ marginTop: 16 }}>
          <button
            type="button"
            onClick={() => setShowResolved((v) => !v)}
            style={{
              border: "none",
              background: "transparent",
              padding: 0,
              cursor: "pointer",
              fontSize: 12,
              color: "var(--muted)",
              fontFamily: "var(--font-mono)",
            }}
          >
            {showResolved ? "▾" : "▸"} {resolvedCount} resolved
          </button>
          {showResolved && (
            <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 12, opacity: 0.6 }}>
              {resolved.map((c) => (
                <CommentCard key={c.id} c={c} isAdmin={isAdmin} onResolve={resolve} onDelete={remove} resolved />
              ))}
            </div>
          )}
        </div>
      )}

      <form onSubmit={submit} style={{ marginTop: 20 }}>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Add a comment… (markdown supported)"
          rows={3}
          aria-label="Add a comment"
          style={{
            width: "100%",
            padding: "9px 12px",
            fontSize: 13.5,
            fontFamily: "var(--font-sans)",
            border: "1px solid var(--hairline)",
            borderRadius: 8,
            background: "var(--surface)",
            color: "var(--ink)",
            outline: "none",
            resize: "vertical",
          }}
        />
        {error && (
          <div style={{ marginTop: 6, fontSize: 12, color: "var(--danger-ink)" }}>{error}</div>
        )}
        <div style={{ marginTop: 8 }}>
          <button
            type="submit"
            disabled={pending || draft.trim().length === 0}
            style={{
              fontSize: 12.5,
              fontWeight: 500,
              padding: "6px 14px",
              borderRadius: 7,
              border: "1px solid var(--accent)",
              background: "var(--accent)",
              color: "var(--bg)",
              cursor: draft.trim().length === 0 ? "default" : "pointer",
              opacity: draft.trim().length === 0 ? 0.5 : 1,
              fontFamily: "var(--font-sans)",
            }}
            onClick={() => startTransition(() => {})}
          >
            Comment
          </button>
        </div>
      </form>
    </section>
  );
}

function CommentCard({
  c,
  isAdmin,
  onResolve,
  onDelete,
  resolved = false,
}: {
  c: CommentDTO;
  isAdmin: boolean;
  onResolve: (id: number) => void;
  onDelete: (id: number) => void;
  resolved?: boolean;
}) {
  const chip = authorChip(c);
  return (
    <div
      style={{
        border: "1px solid var(--hairline)",
        borderRadius: 10,
        padding: "12px 14px",
        background: "var(--surface)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginBottom: 6,
        }}
      >
        <AuthorChipView chip={chip} />
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--faint)" }}>
          {commentStamp(c.createdAt)}
        </span>
        {resolved && (
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--faint)" }}>
            resolved
          </span>
        )}
        {isAdmin && (
          <span style={{ marginLeft: "auto", display: "flex", gap: 10 }}>
            {!resolved && (
              <button
                type="button"
                onClick={() => onResolve(c.id)}
                style={adminActionStyle}
              >
                resolve
              </button>
            )}
            <button
              type="button"
              onClick={() => onDelete(c.id)}
              style={{ ...adminActionStyle, color: "var(--danger-ink)" }}
            >
              delete
            </button>
          </span>
        )}
      </div>
      {/* Body is rendered ONLY through the escaped Markdown component. */}
      <div style={{ fontSize: 13.5 }}>
        <Markdown content={c.body} register="operator" />
      </div>
    </div>
  );
}

const adminActionStyle = {
  border: "none",
  background: "transparent",
  padding: 0,
  cursor: "pointer",
  fontSize: 11,
  fontFamily: "var(--font-mono)",
  color: "var(--muted)",
} as const;

/**
 * Author chip — reuses the audience-badge visual language. `link:` authors get
 * the amber-ish external treatment so it reads as an outside voice. The label is
 * plain text (React escapes).
 */
function AuthorChipView({ chip }: { chip: ReturnType<typeof authorChip> }) {
  const isLink = chip.kind === "link";
  return (
    <span
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: 10.5,
        padding: "3px 8px",
        borderRadius: 99,
        whiteSpace: "nowrap",
        background: isLink ? "var(--badge-external-bg)" : "var(--badge-team-bg)",
        color: isLink ? "var(--badge-external-ink)" : "var(--badge-team-ink)",
      }}
      title={isLink ? "via share link" : undefined}
    >
      {chip.label}
      {isLink ? " · link" : ""}
    </span>
  );
}
