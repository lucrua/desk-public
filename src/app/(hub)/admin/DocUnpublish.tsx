"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

/**
 * Unpublish action for a docs/versions table row: confirm → DELETE
 * /api/docs/[slug] → router.refresh. Client island; the page stays an RSC.
 */
export default function DocUnpublish({ slug }: { slug: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  async function unpublish() {
    if (
      !window.confirm(
        `Unpublish "${slug}"? Its share links will 404 until re-published.`,
      )
    ) {
      return;
    }
    setError(null);
    try {
      const res = await fetch(`/api/docs/${slug}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? `Unpublish failed (${res.status})`);
        return;
      }
      startTransition(() => router.refresh());
    } catch {
      setError("Network error — doc not unpublished.");
    }
  }

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, justifySelf: "end" }}>
      {error && <span style={{ fontSize: 10.5, color: "var(--danger-ink)" }}>{error}</span>}
      <button
        type="button"
        onClick={unpublish}
        disabled={pending}
        style={{
          fontSize: 11,
          fontWeight: 500,
          padding: "3px 10px",
          borderRadius: 6,
          border: "1px solid var(--danger-border)",
          background: "transparent",
          color: "var(--danger-ink)",
          cursor: "pointer",
          fontFamily: "var(--font-sans)",
        }}
      >
        {pending ? "…" : "unpublish"}
      </button>
    </span>
  );
}
