"use client";

import { useState } from "react";

/**
 * "Push to this space" help block: the exact `git remote add` + `git push`
 * commands for this space's git URL, with a copy button, pointing at
 * /settings/tokens for a credential. `canPush` tailors the copy (writers/owners
 * push; readers clone only).
 */
export default function PushHelp({ repoUrl, canPush }: { repoUrl: string; canPush: boolean }) {
  const [copied, setCopied] = useState(false);

  const snippet = canPush
    ? [
        `git remote add desk ${repoUrl}`,
        `git push desk HEAD:main`,
        ``,
        `# username = anything, password = your token (from /settings/tokens)`,
      ].join("\n")
    : [
        `git clone ${repoUrl}`,
        ``,
        `# username = anything, password = your token (from /settings/tokens)`,
      ].join("\n");

  async function copy() {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div
      style={{
        border: "1px solid var(--hairline)",
        borderRadius: 10,
        background: "var(--surface)",
        padding: "14px 16px",
      }}
    >
      <p style={{ margin: "0 0 10px", fontSize: 13, color: "var(--muted)", lineHeight: 1.55 }}>
        {canPush
          ? "Push files here over HTTPS smart-HTTP. A push re-renders the affected docs within seconds."
          : "You can clone/fetch this space (reader access). Pushing requires writer or owner."}{" "}
        Authenticate with a{" "}
        <a href="/settings/tokens" style={{ color: "var(--accent)", textDecoration: "none" }}>
          principal token
        </a>{" "}
        as the HTTP&nbsp;Basic password (any username).
      </p>
      {canPush && (
        <p
          data-testid="push-render-note"
          style={{ margin: "0 0 10px", fontSize: 12.5, color: "var(--muted)", lineHeight: 1.5 }}
        >
          Desk renders the <code style={{ fontFamily: "var(--font-mono)" }}>main</code> branch — that&rsquo;s
          why the push targets <code style={{ fontFamily: "var(--font-mono)" }}>HEAD:main</code> (your
          local branch may be <code style={{ fontFamily: "var(--font-mono)" }}>master</code>).
        </p>
      )}
      <div style={{ position: "relative" }}>
        <pre
          data-testid="push-snippet"
          style={{
            margin: 0,
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            lineHeight: 1.6,
            padding: "12px 14px",
            borderRadius: 8,
            border: "1px solid var(--hairline-strong)",
            background: "var(--surface-alt)",
            color: "var(--ink)",
            overflowX: "auto",
            whiteSpace: "pre",
          }}
        >
          {snippet}
        </pre>
        <button
          type="button"
          onClick={() => void copy()}
          style={{
            position: "absolute",
            top: 8,
            right: 8,
            fontSize: 11,
            padding: "4px 10px",
            borderRadius: 6,
            border: "1px solid var(--hairline-strong)",
            background: "var(--surface)",
            color: "var(--muted)",
            cursor: "pointer",
          }}
        >
          {copied ? "copied ✓" : "copy"}
        </button>
      </div>
    </div>
  );
}
