"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { visibilityPreview } from "./sharing-preview";

/** One audience the doc can be assigned to, with its visibility shape. */
export type AudienceChoice = {
  key: string;
  label: string;
  memberVisible: boolean;
  /** Display names of the audience's explicit members (for the preview line). */
  memberNames: string[];
};

/**
 * Admin-only visibility control inside the consolidated Sharing panel: an
 * audience <select> that PATCHes /api/docs/[slug] { audience } plus a live
 * "Visible to:" preview computed from the chosen audience's flag + members
 * (Audiences v2). The preview updates as the admin picks (before save) and the
 * page re-fetches on a successful change so the rest of the page stays in sync.
 */
export default function DocVisibilityControl({
  slug,
  currentAudience,
  choices,
}: {
  slug: string;
  currentAudience: string;
  choices: AudienceChoice[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [selected, setSelected] = useState(currentAudience);
  const [error, setError] = useState<string | null>(null);

  const chosen = choices.find((c) => c.key === selected);
  const preview = chosen
    ? visibilityPreview({ memberVisible: chosen.memberVisible, memberNames: chosen.memberNames })
    : "—";

  async function apply(nextKey: string) {
    setError(null);
    setSelected(nextKey);
    if (nextKey === currentAudience) return; // no-op
    try {
      const res = await fetch(`/api/docs/${slug}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ audience: nextKey }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? `Change failed (${res.status})`);
        setSelected(currentAudience); // revert the picker
        return;
      }
      startTransition(() => router.refresh());
    } catch {
      setError("Network error — audience unchanged.");
      setSelected(currentAudience);
    }
  }

  return (
    <div
      style={{
        border: "1px solid var(--hairline)",
        borderRadius: 10,
        padding: "12px 14px",
        marginBottom: 14,
        background: "var(--surface)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
        }}
      >
        <label
          style={{
            fontSize: 11.5,
            fontWeight: 600,
            color: "var(--muted)",
          }}
          htmlFor="doc-audience"
        >
          Audience
        </label>
        <select
          id="doc-audience"
          value={selected}
          onChange={(e) => void apply(e.target.value)}
          disabled={pending}
          style={{
            fontSize: 13,
            fontFamily: "var(--font-sans)",
            padding: "6px 10px",
            borderRadius: 8,
            border: "1px solid var(--hairline-strong)",
            background: "var(--surface-alt)",
            color: "var(--ink)",
          }}
        >
          {choices.map((c) => (
            <option key={c.key} value={c.key}>
              {c.label}
            </option>
          ))}
        </select>
        <span style={{ fontSize: 12.5, color: "var(--faint)" }}>
          Visible to:{" "}
          <strong style={{ color: "var(--ink)", fontWeight: 600 }}>{preview}</strong>
        </span>
      </div>
      {error && (
        <p style={{ margin: "8px 0 0", fontSize: 11.5, color: "var(--danger-ink)" }}>{error}</p>
      )}
    </div>
  );
}
