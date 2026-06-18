"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Renders a mermaid diagram client-side. The `mermaid` package is lazy-imported
 * on mount so it never lands in the server bundle or the initial client payload
 * for pages that don't use diagrams.
 *
 * The wrapper carries `data-mermaid` so renderers/tests can detect a mermaid
 * fence without depending on the rendered SVG.
 */
export default function MermaidBlock({ code }: { code: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const id = `mermaid-${Math.random().toString(36).slice(2)}`;

    (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        const dark =
          typeof document !== "undefined" &&
          document.documentElement.getAttribute("data-theme") === "dark";
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: dark ? "dark" : "neutral",
          fontFamily: "var(--font-mono)",
        });
        const { svg } = await mermaid.render(id, code);
        if (!cancelled && ref.current) {
          ref.current.innerHTML = svg;
          setError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Diagram failed to render");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [code]);

  return (
    <div data-mermaid="" className="md-mermaid" aria-label="diagram">
      {error ? (
        <pre data-mermaid-error="">{error}</pre>
      ) : (
        <div ref={ref} />
      )}
    </div>
  );
}
