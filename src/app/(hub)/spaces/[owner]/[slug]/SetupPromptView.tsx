"use client";

import { useState } from "react";

/**
 * The setup-prompt block shown to a MEMBER on the space page. The prompt is a
 * TEMPLATE — it carries a `<token>` placeholder rather than a live credential
 * (the live token is handed out exactly once at invite-accept time, or minted by
 * the member at /settings/tokens). The push line already reflects the space's
 * push_policy (server-rendered into `prompt`).
 */
export default function SetupPromptView({ prompt }: { prompt: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
        <span style={{ fontSize: 12, color: "var(--muted)" }}>
          Replace <code style={{ fontFamily: "var(--font-mono)" }}>&lt;token&gt;</code> with a
          token from <a href="/settings/tokens" style={{ color: "var(--accent)", textDecoration: "none" }}>/settings/tokens</a>.
        </span>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(prompt).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            padding: "4px 10px",
            borderRadius: 6,
            border: "1px solid var(--hairline-strong)",
            background: "var(--surface-alt)",
            color: "var(--muted)",
            cursor: "pointer",
          }}
        >
          {copied ? "copied" : "copy"}
        </button>
      </div>
      <pre
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 12.5,
          lineHeight: 1.6,
          background: "var(--surface-alt)",
          border: "1px solid var(--hairline)",
          borderRadius: 8,
          padding: "12px 14px",
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
          color: "var(--ink)",
          margin: 0,
        }}
      >
        {prompt}
      </pre>
    </div>
  );
}
