"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

const inputStyle = {
  fontFamily: "var(--font-mono)",
  fontSize: 12.5,
  padding: "6px 9px",
  borderRadius: 6,
  border: "1px solid var(--hairline-strong)",
  background: "var(--surface)",
  color: "var(--ink)",
  width: "100%",
} as const;

const labelStyle = {
  fontFamily: "var(--font-mono)",
  fontSize: 9.5,
  letterSpacing: "0.06em",
  textTransform: "uppercase" as const,
  color: "var(--faint)",
  display: "block",
  marginBottom: 4,
};

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * New-space form (admin-only — this slice keeps space creation an operator
 * action, matching Phase-1 "create = admin"). Slug + visibility → POST
 * /api/spaces owned by the creator, then router.refresh().
 */
export default function NewSpace() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [slug, setSlug] = useState("");
  const [visibility, setVisibility] = useState<"private" | "unlisted" | "public">("private");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const s = slug.trim();
    if (!SLUG_RE.test(s)) {
      setError("Slug must be lowercase letters, digits and dashes (e.g. my-project).");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/spaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: s, visibility }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? `Create failed (${res.status})`);
        return;
      }
      setSlug("");
      setVisibility("private");
      setOpen(false);
      startTransition(() => router.refresh());
    } catch {
      setError("Network error — space not created.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={{
          fontSize: 12.5,
          fontWeight: 500,
          padding: "7px 16px",
          borderRadius: 6,
          border: "1px solid var(--accent)",
          background: "var(--accent)",
          color: "#fff",
          cursor: "pointer",
          fontFamily: "var(--font-sans)",
        }}
      >
        + New space
      </button>
    );
  }

  return (
    <form
      onSubmit={submit}
      style={{
        border: "1px solid var(--hairline)",
        borderRadius: 10,
        background: "var(--surface)",
        padding: "14px 16px",
      }}
    >
      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr auto auto", gap: 10, alignItems: "end" }}>
        <div>
          <label style={labelStyle} htmlFor="space-slug">
            slug
          </label>
          <input
            id="space-slug"
            style={inputStyle}
            value={slug}
            onChange={(e) => {
              setSlug(e.target.value);
              // Clear any stale submit error as soon as the operator edits the
              // slug (e.g. after a "slug already in use" 400) — don't leave the
              // old message hanging until the next submit.
              if (error) setError(null);
            }}
            placeholder="my-project"
            disabled={busy}
          />
        </div>
        <div>
          <label style={labelStyle} htmlFor="space-visibility">
            visibility
          </label>
          <select
            id="space-visibility"
            value={visibility}
            onChange={(e) => setVisibility(e.target.value as typeof visibility)}
            disabled={busy}
            style={{ ...inputStyle, fontFamily: "var(--font-sans)" }}
          >
            <option value="private">private</option>
            <option value="unlisted">unlisted</option>
            <option value="public">public</option>
          </select>
        </div>
        <button
          type="submit"
          disabled={busy}
          style={{
            fontSize: 12.5,
            fontWeight: 500,
            padding: "7px 16px",
            borderRadius: 6,
            border: "1px solid var(--accent)",
            background: "var(--accent)",
            color: "#fff",
            cursor: busy ? "default" : "pointer",
            fontFamily: "var(--font-sans)",
            whiteSpace: "nowrap",
          }}
        >
          {busy ? "…" : "create"}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
          disabled={busy}
          style={{
            fontSize: 12.5,
            padding: "7px 12px",
            borderRadius: 6,
            border: "1px solid var(--hairline)",
            background: "var(--surface-alt)",
            color: "var(--muted)",
            cursor: "pointer",
            fontFamily: "var(--font-sans)",
          }}
        >
          cancel
        </button>
      </div>
      <p style={{ margin: "10px 0 0", fontSize: 11, color: "var(--faint)", lineHeight: 1.5 }}>
        Visibility governs <strong>discovery</strong> only — never the git ACL,
        which is membership-based. You become the space owner. After creating it,
        mint a token in{" "}
        <a href="/settings/tokens" style={{ color: "var(--accent)", textDecoration: "none" }}>
          Tokens
        </a>{" "}
        and push.
      </p>
      {error && <div style={{ marginTop: 10, fontSize: 11.5, color: "var(--danger-ink)" }}>{error}</div>}
    </form>
  );
}
