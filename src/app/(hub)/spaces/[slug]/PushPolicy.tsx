"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

type Policy = "direct" | "proposal";

/**
 * Admin/owner push-policy control (External Collaboration, E1): a <select> that
 * PATCHes /api/spaces/[slug] { push_policy } and re-fetches. `direct` lets
 * writers push the hosted `main` branch; `proposal` routes a non-owner writer's
 * pushes to `proposals/*` (ENFORCED in E2 — here it only changes the setting,
 * which the setup prompt + push help reflect).
 */
export default function PushPolicy({
  slug,
  current,
}: {
  slug: string;
  current: Policy;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [selected, setSelected] = useState<Policy>(current);
  const [error, setError] = useState<string | null>(null);

  async function apply(next: Policy) {
    setError(null);
    setSelected(next);
    if (next === current) return;
    try {
      const res = await fetch(`/api/spaces/${slug}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ push_policy: next }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? `Change failed (${res.status})`);
        setSelected(current);
        return;
      }
      startTransition(() => router.refresh());
    } catch {
      setError("Network error — push policy unchanged.");
      setSelected(current);
    }
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <select
          aria-label="Push policy"
          value={selected}
          onChange={(e) => void apply(e.target.value as Policy)}
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
          <option value="direct">direct — writers push main</option>
          <option value="proposal">proposal — non-owner writers push proposals/*</option>
        </select>
        <span style={{ fontSize: 12, color: "var(--faint)" }}>
          {selected === "proposal"
            ? "non-owner pushes open a PR for the owner (enforced soon)"
            : "every writer pushes the hosted main branch directly"}
        </span>
      </div>
      {error && <p style={{ margin: "8px 0 0", fontSize: 11.5, color: "var(--danger-ink)" }}>{error}</p>}
    </div>
  );
}
