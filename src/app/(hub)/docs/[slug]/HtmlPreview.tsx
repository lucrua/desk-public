"use client";

import { useState } from "react";
import SandboxedHtml from "@/components/SandboxedHtml";

type Mode = "rendered" | "source";

/**
 * Hub doc viewer for HTML docs. Defaults to the sandboxed render (the same
 * SandboxedHtml the public share reader uses) and lets an operator flip to a
 * true raw-source view for inspection / QA before sharing.
 *
 * The Source view is inert text in a <pre> — it never executes. The Rendered
 * view runs only inside the opaque-origin iframe. Toggle state is purely
 * client-side; no new fetch or route.
 */
export default function HtmlPreview({
  content,
  title,
}: {
  content: string;
  title: string;
}) {
  const [mode, setMode] = useState<Mode>("rendered");

  return (
    <div>
      <div
        role="group"
        aria-label="HTML view mode"
        style={{
          display: "inline-flex",
          gap: 2,
          padding: 2,
          marginBottom: 14,
          border: "1px solid var(--hairline)",
          borderRadius: 8,
          background: "var(--surface-alt)",
        }}
      >
        <ModeButton label="Rendered" active={mode === "rendered"} onClick={() => setMode("rendered")} />
        <ModeButton label="Source" active={mode === "source"} onClick={() => setMode("source")} />
      </div>

      {mode === "rendered" ? (
        <SandboxedHtml content={content} title={title} />
      ) : (
        <pre
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 12.5,
            lineHeight: 1.7,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            overflowX: "auto",
            margin: 0,
            padding: "16px 18px",
            border: "1px solid var(--hairline)",
            borderRadius: 10,
            background: "var(--surface-alt)",
            color: "var(--ink)",
          }}
        >
          {content}
        </pre>
      )}
    </div>
  );
}

function ModeButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        appearance: "none",
        cursor: "pointer",
        fontFamily: "var(--font-mono)",
        fontSize: 11.5,
        letterSpacing: "0.03em",
        padding: "5px 12px",
        borderRadius: 6,
        border: "none",
        background: active ? "var(--bg)" : "transparent",
        color: active ? "var(--accent)" : "var(--muted)",
        fontWeight: active ? 600 : 500,
      }}
    >
      {label}
    </button>
  );
}
