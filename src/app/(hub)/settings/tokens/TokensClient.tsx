"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { renderTokenSetupPrompt } from "@/lib/tokens/setup-prompt";
import TokenSetupPromptView from "./TokenSetupPromptView";

export type TokenRow = {
  id: number;
  label: string;
  lastUsedAt: string | null;
  createdAt: string | null;
  revokedAt: string | null;
};

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

const primaryButton = {
  fontSize: 12.5,
  fontWeight: 500,
  padding: "7px 16px",
  borderRadius: 6,
  border: "1px solid var(--accent)",
  background: "var(--accent)",
  color: "#fff",
  fontFamily: "var(--font-sans)",
  whiteSpace: "nowrap" as const,
};

function fmt(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/**
 * The token manager client island: mint (label → raw token shown ONCE in a copy
 * box with a "won't be shown again" warning), list, revoke. POSTs/DELETEs to
 * /api/tokens and re-fetches via router.refresh().
 */
export default function TokensClient({
  initialTokens,
  resolvable,
  gitHostBase,
}: {
  initialTokens: TokenRow[];
  resolvable: boolean;
  /** Git transport origin (scheme + host) used to render the once-shown
   *  global-setup prompt for a just-minted token. */
  gitHostBase: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [minting, setMinting] = useState(false);
  // The just-minted raw token (shown once); null when nothing fresh.
  const [fresh, setFresh] = useState<{ label: string; token: string } | null>(null);
  const [copied, setCopied] = useState(false);

  async function mint(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (label.trim().length === 0) {
      setError("Give the token a label.");
      return;
    }
    setMinting(true);
    try {
      const res = await fetch("/api/tokens", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: label.trim() }),
      });
      const data = (await res.json().catch(() => null)) as
        | { token?: string; label?: string; error?: string }
        | null;
      if (!res.ok || !data?.token) {
        setError(data?.error ?? `Mint failed (${res.status})`);
        return;
      }
      setFresh({ label: data.label ?? label.trim(), token: data.token });
      setCopied(false);
      setLabel("");
      startTransition(() => router.refresh());
    } catch {
      setError("Network error — token not minted.");
    } finally {
      setMinting(false);
    }
  }

  async function revoke(id: number, label: string) {
    setError(null);
    // Revoke is irreversible — any git client using this token stops working
    // immediately. Confirm before the DELETE (matches the doc/link delete
    // confirm pattern elsewhere in the hub).
    if (
      !window.confirm(
        `Revoke the token "${label}"? Any git client using it stops working immediately. This cannot be undone — you'd have to mint a new one.`,
      )
    ) {
      return;
    }
    try {
      const res = await fetch(`/api/tokens/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? `Revoke failed (${res.status})`);
        return;
      }
      startTransition(() => router.refresh());
    } catch {
      setError("Network error — token not revoked.");
    }
  }

  async function copyFresh() {
    if (!fresh) return;
    try {
      await navigator.clipboard.writeText(fresh.token);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  if (!resolvable) {
    return (
      <div
        style={{
          border: "1px solid var(--hairline)",
          borderRadius: 10,
          background: "var(--surface-alt)",
          padding: "16px 18px",
          fontSize: 13,
          color: "var(--muted)",
          lineHeight: 1.55,
        }}
      >
        Your identity could not be resolved to a user account, so tokens can&rsquo;t
        be minted for you. In production this means your sign-in has no Desk user
        row yet — ask an admin to add you.
      </div>
    );
  }

  return (
    <div>
      {/* Fresh-token reveal — shown ONCE, with a copy box + warning. */}
      {fresh && (
        <div
          data-testid="fresh-token"
          style={{
            border: "1px solid var(--accent)",
            borderRadius: 10,
            background: "var(--surface)",
            padding: "16px 18px",
            marginBottom: 18,
          }}
        >
          <div style={{ ...labelStyle, color: "var(--accent)" }}>
            new token — {fresh.label}
          </div>
          <div
            style={{
              display: "flex",
              gap: 8,
              alignItems: "stretch",
              marginTop: 6,
            }}
          >
            <code
              data-testid="fresh-token-value"
              style={{
                flex: 1,
                fontFamily: "var(--font-mono)",
                fontSize: 12.5,
                padding: "9px 11px",
                borderRadius: 6,
                border: "1px solid var(--hairline-strong)",
                background: "var(--surface-alt)",
                color: "var(--ink)",
                wordBreak: "break-all",
              }}
            >
              {fresh.token}
            </code>
            <button type="button" onClick={() => void copyFresh()} style={primaryButton}>
              {copied ? "copied ✓" : "copy"}
            </button>
          </div>
          <p style={{ margin: "10px 0 0", fontSize: 11.5, color: "var(--danger-ink)", lineHeight: 1.5 }}>
            <strong>Store it now — this token won&rsquo;t be shown again.</strong>{" "}
            Desk only keeps its hash. If you lose it, revoke it and mint a new one.
          </p>
          {/* Global-setup prompt: rendered ephemerally from the LIVE token (never
              stored in state or logged — same lifecycle as the token above). */}
          <TokenSetupPromptView
            prompt={renderTokenSetupPrompt({ gitHostBase, token: fresh.token })}
          />
          <button
            type="button"
            onClick={() => setFresh(null)}
            style={{
              marginTop: 10,
              fontSize: 11.5,
              padding: "5px 12px",
              borderRadius: 6,
              border: "1px solid var(--hairline)",
              background: "var(--surface-alt)",
              color: "var(--muted)",
              cursor: "pointer",
            }}
          >
            I&rsquo;ve stored it — dismiss
          </button>
        </div>
      )}

      {/* Mint form */}
      <form
        onSubmit={mint}
        style={{
          border: "1px solid var(--hairline)",
          borderRadius: 10,
          background: "var(--surface)",
          padding: "14px 16px",
          marginBottom: 20,
        }}
      >
        <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 10, alignItems: "end" }}>
          <div>
            <label style={labelStyle} htmlFor="token-label">
              label
            </label>
            <input
              id="token-label"
              style={inputStyle}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="laptop, CI agent, …"
              disabled={minting}
            />
          </div>
          <button type="submit" disabled={minting} style={{ ...primaryButton, cursor: minting ? "default" : "pointer" }}>
            {minting ? "…" : "mint token"}
          </button>
        </div>
        {error && <div style={{ marginTop: 10, fontSize: 11.5, color: "var(--danger-ink)" }}>{error}</div>}
      </form>

      {/* Token list */}
      <div style={labelStyle}>your tokens</div>
      {initialTokens.length === 0 ? (
        <p style={{ fontSize: 13, color: "var(--faint)", marginTop: 8 }}>
          No tokens yet. Mint one above to get a git push credential.
        </p>
      ) : (
        <div
          style={{
            border: "1px solid var(--hairline)",
            borderRadius: 10,
            overflow: "hidden",
            marginTop: 8,
          }}
        >
          {initialTokens.map((t, i) => {
            const revoked = t.revokedAt !== null;
            return (
              <div
                key={t.id}
                data-testid={`token-row-${t.id}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "11px 14px",
                  borderTop: i === 0 ? "none" : "1px solid var(--hairline)",
                  background: "var(--surface)",
                  opacity: revoked ? 0.6 : 1,
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, color: "var(--ink)", fontWeight: 500 }}>
                    {t.label}
                    {revoked && (
                      <span
                        style={{
                          marginLeft: 8,
                          fontFamily: "var(--font-mono)",
                          fontSize: 10,
                          padding: "1px 6px",
                          borderRadius: 999,
                          border: "1px solid var(--hairline)",
                          color: "var(--faint)",
                        }}
                      >
                        revoked
                      </span>
                    )}
                  </div>
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--faint)", marginTop: 3 }}>
                    created {fmt(t.createdAt)} · last used {fmt(t.lastUsedAt)}
                  </div>
                </div>
                {!revoked && (
                  <button
                    type="button"
                    onClick={() => void revoke(t.id, t.label)}
                    disabled={pending}
                    style={{
                      fontSize: 12,
                      padding: "6px 12px",
                      borderRadius: 6,
                      border: "1px solid var(--danger-border, var(--hairline-strong))",
                      background: "var(--surface-alt)",
                      color: "var(--danger-ink)",
                      cursor: pending ? "default" : "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    revoke
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
