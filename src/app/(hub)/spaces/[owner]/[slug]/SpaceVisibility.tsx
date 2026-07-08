"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

type Visibility = "private" | "unlisted" | "public";

/**
 * Admin/owner visibility control: a <select> that PATCHes
 * /api/spaces/[slug] { visibility } and re-fetches. Visibility governs DISCOVERY
 * only — never the git ACL (membership-based), which the help line makes clear.
 */
export default function SpaceVisibility({
  slug,
  current,
}: {
  slug: string;
  current: Visibility;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [selected, setSelected] = useState<Visibility>(current);
  const [error, setError] = useState<string | null>(null);

  async function apply(next: Visibility) {
    setError(null);
    setSelected(next);
    if (next === current) return;
    try {
      const res = await fetch(`/api/spaces/${slug}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ visibility: next }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? `Change failed (${res.status})`);
        setSelected(current);
        return;
      }
      startTransition(() => router.refresh());
    } catch {
      setError("Network error — visibility unchanged.");
      setSelected(current);
    }
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <select
          aria-label="Space visibility"
          value={selected}
          onChange={(e) => void apply(e.target.value as Visibility)}
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
          <option value="private">private</option>
          <option value="unlisted">unlisted</option>
          <option value="public">public</option>
        </select>
        <span style={{ fontSize: 12, color: "var(--faint)" }}>
          governs discovery only — the git ACL is membership-based
        </span>
      </div>
      {error && <p style={{ margin: "8px 0 0", fontSize: 11.5, color: "var(--danger-ink)" }}>{error}</p>}
    </div>
  );
}
