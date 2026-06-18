"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

const inputStyle = {
  fontFamily: "var(--font-sans)",
  fontSize: 12.5,
  padding: "6px 9px",
  borderRadius: 6,
  border: "1px solid var(--hairline-strong)",
  background: "var(--surface)",
  color: "var(--ink)",
  width: "100%",
} as const;

const labelStyle = {
  fontFamily: "var(--font-mono)",
  fontSize: 9.5,
  letterSpacing: "0.06em",
  textTransform: "uppercase" as const,
  color: "var(--faint)",
  display: "block",
  marginBottom: 4,
};

/**
 * Add-user form. Display name is required; supply email OR a service-token
 * Client ID (at least one). POST /api/users → router.refresh() on success;
 * inline error on 409 (duplicate) / 400. Mirrors the client-island pattern.
 */
export default function AddUser() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [tokenName, setTokenName] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (displayName.trim().length === 0) {
      setError("Display name is required.");
      return;
    }
    if (email.trim().length === 0 && tokenName.trim().length === 0) {
      setError("Provide an email or a service-token Client ID.");
      return;
    }

    const body: Record<string, unknown> = { displayName: displayName.trim() };
    if (email.trim().length > 0) body.email = email.trim();
    if (tokenName.trim().length > 0) body.tokenName = tokenName.trim();

    try {
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? `Add failed (${res.status})`);
        return;
      }
      setDisplayName("");
      setEmail("");
      setTokenName("");
      startTransition(() => router.refresh());
    } catch {
      setError("Network error — user not added.");
    }
  }

  return (
    <form
      onSubmit={submit}
      style={{
        border: "1px solid var(--hairline)",
        borderRadius: 10,
        background: "var(--surface)",
        padding: "14px 16px",
        marginTop: 12,
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1.1fr 1.3fr 1.1fr auto",
          gap: 10,
          alignItems: "end",
        }}
      >
        <div>
          <label style={labelStyle} htmlFor="add-user-name">
            display name *
          </label>
          <input
            id="add-user-name"
            style={inputStyle}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Alex"
            disabled={pending}
          />
        </div>
        <div>
          <label style={labelStyle} htmlFor="add-user-email">
            email
          </label>
          <input
            id="add-user-email"
            type="email"
            style={inputStyle}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="alex@example.com"
            disabled={pending}
          />
        </div>
        <div>
          <label style={labelStyle} htmlFor="add-user-token">
            service-token Client ID
          </label>
          <input
            id="add-user-token"
            style={{ ...inputStyle, fontFamily: "var(--font-mono)" }}
            value={tokenName}
            onChange={(e) => setTokenName(e.target.value)}
            placeholder="<client-id>.access"
            disabled={pending}
          />
        </div>
        <button
          type="submit"
          disabled={pending}
          style={{
            fontSize: 12.5,
            fontWeight: 500,
            padding: "7px 16px",
            borderRadius: 6,
            border: "1px solid var(--accent)",
            background: "var(--accent)",
            color: "#fff",
            cursor: pending ? "default" : "pointer",
            fontFamily: "var(--font-sans)",
            whiteSpace: "nowrap",
          }}
        >
          {pending ? "…" : "add user"}
        </button>
      </div>

      {error && (
        <div style={{ marginTop: 10, fontSize: 11.5, color: "var(--danger-ink)" }}>{error}</div>
      )}

      <div style={{ marginTop: 12, fontSize: 11, lineHeight: 1.5, color: "var(--faint)" }}>
        Provide an <strong style={{ fontWeight: 600 }}>email</strong> for a human or a{" "}
        <strong style={{ fontWeight: 600 }}>service-token Client ID</strong> for an agent (at least
        one). For humans, also add the email to the Cloudflare Access allowlist
        (Zero Trust → Access → Desk) — the wall and this list are separate.
        Everyone is added as a member; use the role chip on the user row to grant admin access.
      </div>

      <div style={{ marginTop: 8, fontSize: 11, lineHeight: 1.5, color: "var(--faint)" }}>
        The token field wants the Cloudflare Access{" "}
        <strong style={{ fontWeight: 600 }}>Client ID</strong> — the{" "}
        <span style={{ fontFamily: "var(--font-mono)" }}>…access</span> value from
        Zero Trust → Access → Service Auth (e.g.{" "}
        <span style={{ fontFamily: "var(--font-mono)" }}>88f1a0….access</span>),{" "}
        <strong style={{ fontWeight: 600 }}>not</strong> the Client Secret (that
        goes only in the agent&rsquo;s config, never into Desk).{" "}
        <a href="/help#mcp" style={{ color: "var(--accent)", textDecoration: "none" }}>
          How agents connect →
        </a>
      </div>
    </form>
  );
}
