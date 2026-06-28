"use client";

import { useState } from "react";

/**
 * The "configure this token globally" prompt block, shown ONCE in the just-minted
 * token reveal. The `prompt` string is rendered by `renderTokenSetupPrompt` from
 * the LIVE raw token and carries a real credential — so this view is rendered
 * only inside the fresh-token reveal (same lifecycle as the raw token shown
 * above) and the string is never persisted or logged.
 *
 * Mirrors the SetupPromptView / PushHelp copy pattern: a `<pre>` code block with a
 * copy button. The user pastes the whole prompt (prose + fenced commands) into a
 * coding agent on their local machine; the agent stores the credential globally so
 * future clone/push to this Desk host authenticate without prompts.
 */
export default function TokenSetupPromptView({ prompt }: { prompt: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ marginTop: 14 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          marginBottom: 6,
          gap: 8,
        }}
      >
        <span style={{ fontSize: 11.5, color: "var(--muted)", lineHeight: 1.5 }}>
          Or paste this into a coding agent on your machine to configure git globally —
          future clone/push authenticate automatically.
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
            whiteSpace: "nowrap",
          }}
        >
          {copied ? "copied ✓" : "copy prompt"}
        </button>
      </div>
      <pre
        data-testid="token-setup-prompt"
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 12,
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
