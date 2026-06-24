"use client";

import { useState } from "react";

/**
 * The invite accept form (public, share-host). Collects the accepter's email and
 * POSTs to /api/invite/[token]/accept. On success it renders the one-time
 * principal token + the paste-able setup prompt (the token is the git
 * credential — shown ONCE, never re-fetchable). On any failure the server
 * returns a uniform 404, which we surface as a neutral "this link is no longer
 * valid" message (no leak of why).
 */
type AcceptOk = {
  ok: true;
  token: string;
  cloneUrl: string;
  setupPrompt: string;
  space: string;
  role: string;
};

const codeBlock: React.CSSProperties = {
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
  margin: "0 0 14px",
};

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
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
  );
}

export default function AcceptForm({
  token,
  spaceLabel,
}: {
  token: string;
  spaceLabel: string;
}) {
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AcceptOk | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (email.trim().length === 0) {
      setError("Enter your email to join.");
      return;
    }
    setPending(true);
    try {
      const res = await fetch(`/api/invite/${token}/accept`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      if (!res.ok) {
        if (res.status === 404) {
          setError("This invite link is no longer valid.");
        } else {
          const data = (await res.json().catch(() => null)) as { error?: string } | null;
          setError(data?.error ?? `Could not join (${res.status}).`);
        }
        return;
      }
      const data = (await res.json()) as AcceptOk;
      setResult(data);
    } catch {
      setError("Network error — please try again.");
    } finally {
      setPending(false);
    }
  }

  if (result) {
    return (
      <div>
        <h2 style={{ fontSize: 18, fontWeight: 600, margin: "0 0 6px" }}>
          You&rsquo;re in — welcome to {spaceLabel}
        </h2>
        <p style={{ fontSize: 14, color: "var(--muted)", lineHeight: 1.6, margin: "0 0 18px" }}>
          You joined as <strong>{result.role}</strong>. The token below is your git
          credential — it is shown <strong>once</strong>. Copy the setup prompt and
          give it to your agent.
        </p>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--faint)" }}>
            access token (shown once)
          </span>
          <CopyButton text={result.token} />
        </div>
        <div style={codeBlock}>{result.token}</div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--faint)" }}>
            setup prompt
          </span>
          <CopyButton text={result.setupPrompt} />
        </div>
        <div style={codeBlock}>{result.setupPrompt}</div>
      </div>
    );
  }

  return (
    <form onSubmit={submit}>
      <h1 style={{ fontSize: 22, fontWeight: 600, margin: "0 0 8px" }}>
        You&rsquo;re invited to {spaceLabel}
      </h1>
      <p style={{ fontSize: 14, color: "var(--muted)", lineHeight: 1.6, margin: "0 0 20px" }}>
        Enter your email to join this space. We&rsquo;ll set you up with a git
        access token and a setup prompt for your agent.
      </p>
      <label
        htmlFor="invite-email"
        style={{ display: "block", fontSize: 12, color: "var(--muted)", marginBottom: 6 }}
      >
        Email
      </label>
      <input
        id="invite-email"
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@company.com"
        autoComplete="email"
        disabled={pending}
        style={{
          width: "100%",
          fontSize: 14,
          fontFamily: "var(--font-sans)",
          padding: "10px 12px",
          borderRadius: 8,
          border: "1px solid var(--hairline-strong)",
          background: "var(--surface-alt)",
          color: "var(--ink)",
          boxSizing: "border-box",
          marginBottom: 14,
        }}
      />
      <button
        type="submit"
        disabled={pending}
        style={{
          fontSize: 14,
          fontWeight: 500,
          padding: "10px 18px",
          borderRadius: 8,
          border: "none",
          background: "var(--accent)",
          color: "var(--on-accent, #fff)",
          cursor: pending ? "default" : "pointer",
          opacity: pending ? 0.6 : 1,
        }}
      >
        {pending ? "Joining…" : "Join space"}
      </button>
      {error && (
        <p style={{ margin: "12px 0 0", fontSize: 13, color: "var(--danger-ink, #b00)" }}>{error}</p>
      )}
    </form>
  );
}
