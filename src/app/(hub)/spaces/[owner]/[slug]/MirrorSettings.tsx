"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

type SourceMode = "hosted" | "mirrored";

type MirrorState = {
  lastMirroredSha: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
} | null;

const inputStyle = {
  fontSize: 13,
  fontFamily: "var(--font-sans)",
  padding: "6px 10px",
  borderRadius: 8,
  border: "1px solid var(--hairline-strong)",
  background: "var(--surface-alt)",
  color: "var(--ink)",
} as const;

const btnStyle = {
  fontSize: 12,
  fontWeight: 500,
  padding: "6px 14px",
  borderRadius: 7,
  border: "1px solid var(--hairline-strong)",
  background: "var(--surface)",
  color: "var(--ink)",
  cursor: "pointer",
  fontFamily: "var(--font-sans)",
} as const;

function fmtStamp(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

/**
 * Owner/admin GitHub mirror controls (convergence fix-pass, Slice 4c;
 * decisions D-C3/D-C4/D-C5): source mode, mirror remote URL, a "Mirror now"
 * button + the last-attempt status, and an advanced deploy-key paste field.
 * Every mutation PATCHes/POSTs the owner/admin-gated `/mirror*` routes under
 * this space and re-fetches (`router.refresh()`), mirroring `PushPolicy` /
 * `SpaceVisibility`'s island pattern.
 */
export default function MirrorSettings({
  owner,
  slug,
  sourceMode: initialSourceMode,
  mirrorRemoteUrl: initialRemoteUrl,
  mirrorState: initialState,
  hasDeployKey: initialHasDeployKey,
}: {
  owner: string;
  slug: string;
  sourceMode: SourceMode;
  mirrorRemoteUrl: string | null;
  mirrorState: MirrorState;
  hasDeployKey: boolean;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [sourceMode, setSourceMode] = useState<SourceMode>(initialSourceMode);
  const [remoteUrl, setRemoteUrl] = useState(initialRemoteUrl ?? "");
  const [mirrorState, setMirrorState] = useState<MirrorState>(initialState);
  const [hasDeployKey, setHasDeployKey] = useState(initialHasDeployKey);
  const [deployKeyPem, setDeployKeyPem] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);
  const [mirroring, setMirroring] = useState(false);
  const [savingKey, setSavingKey] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function saveConfig(patch: { source_mode?: SourceMode; mirror_remote_url?: string | null }) {
    setError(null);
    setSavingConfig(true);
    try {
      const res = await fetch(`/api/spaces/${owner}/${slug}/mirror`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? `Change failed (${res.status})`);
        return;
      }
      const body = await res.json();
      setSourceMode(body.sourceMode);
      setRemoteUrl(body.mirrorRemoteUrl ?? "");
      setMirrorState(body.mirrorState ?? null);
      startTransition(() => router.refresh());
    } catch {
      setError("Network error — mirror config unchanged.");
    } finally {
      setSavingConfig(false);
    }
  }

  async function mirrorNow() {
    setError(null);
    setMirroring(true);
    try {
      const res = await fetch(`/api/spaces/${owner}/${slug}/mirror/now`, { method: "POST" });
      const data = (await res.json().catch(() => null)) as
        | { ok: true; state: MirrorState }
        | { error?: string }
        | null;
      if (!res.ok) {
        setError((data as { error?: string } | null)?.error ?? `Mirror failed (${res.status})`);
        return;
      }
      setMirrorState((data as { state: MirrorState }).state);
      startTransition(() => router.refresh());
    } catch {
      setError("Network error — mirror not triggered.");
    } finally {
      setMirroring(false);
    }
  }

  async function saveDeployKey() {
    if (deployKeyPem.trim().length === 0) return;
    setError(null);
    setSavingKey(true);
    try {
      const res = await fetch(`/api/spaces/${owner}/${slug}/mirror/deploy-key`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ privateKeyPem: deployKeyPem }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(d?.error ?? `Save failed (${res.status})`);
        return;
      }
      setHasDeployKey(true);
      setDeployKeyPem("");
    } catch {
      setError("Network error — deploy key unchanged.");
    } finally {
      setSavingKey(false);
    }
  }

  async function clearDeployKey() {
    setError(null);
    setSavingKey(true);
    try {
      const res = await fetch(`/api/spaces/${owner}/${slug}/mirror/deploy-key`, { method: "DELETE" });
      if (!res.ok) {
        const d = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(d?.error ?? `Clear failed (${res.status})`);
        return;
      }
      setHasDeployKey(false);
    } catch {
      setError("Network error — deploy key unchanged.");
    } finally {
      setSavingKey(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <select
          aria-label="Source mode"
          value={sourceMode}
          disabled={savingConfig}
          onChange={(e) => void saveConfig({ source_mode: e.target.value as SourceMode })}
          style={inputStyle}
        >
          <option value="hosted">hosted — Desk is canon, mirrors OUT to GitHub</option>
          <option value="mirrored">mirrored — GitHub is canon, Desk receives pushes</option>
        </select>
      </div>
      <p style={{ margin: 0, fontSize: 12, color: "var(--faint)" }}>
        {sourceMode === "mirrored"
          ? "Desk refuses its own content writes here (web authoring, accepting a proposed revision or a proposal) — content arrives only via a git push from the GitHub Action. See docs/remotes.md."
          : "After every push/commit that advances main, Desk pushes it out to the remote below (fire-and-forget; failures never block your write)."}
      </p>

      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <label htmlFor="mirror-remote-url" style={{ fontSize: 12, color: "var(--muted)" }}>
          GitHub remote URL
        </label>
        <input
          id="mirror-remote-url"
          type="text"
          value={remoteUrl}
          onChange={(e) => setRemoteUrl(e.target.value)}
          onBlur={() => {
            if ((remoteUrl || null) !== (initialRemoteUrl || null)) {
              void saveConfig({ mirror_remote_url: remoteUrl.trim().length > 0 ? remoteUrl.trim() : null });
            }
          }}
          placeholder="https://github.com/org/repo.git"
          disabled={savingConfig}
          style={{ ...inputStyle, flex: "1 1 320px", fontFamily: "var(--font-mono)" }}
        />
        {sourceMode === "hosted" && (
          <button
            type="button"
            onClick={() => void mirrorNow()}
            disabled={mirroring || !remoteUrl}
            style={{ ...btnStyle, opacity: mirroring || !remoteUrl ? 0.55 : 1 }}
          >
            {mirroring ? "Mirroring…" : "Mirror now"}
          </button>
        )}
      </div>

      {sourceMode === "hosted" && (
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11.5,
            color: "var(--faint)",
            display: "flex",
            gap: 14,
            flexWrap: "wrap",
          }}
        >
          <span>
            last mirrored sha:{" "}
            <strong style={{ color: "var(--muted)" }}>
              {mirrorState?.lastMirroredSha ? mirrorState.lastMirroredSha.slice(0, 10) : "—"}
            </strong>
          </span>
          <span>
            last attempt: <strong style={{ color: "var(--muted)" }}>{fmtStamp(mirrorState?.lastAttemptAt ?? null)}</strong>
          </span>
          {mirrorState?.lastError && (
            <span style={{ color: "var(--danger-ink)" }}>error: {mirrorState.lastError}</span>
          )}
        </div>
      )}

      {error && <p style={{ margin: 0, fontSize: 11.5, color: "var(--danger-ink)" }}>{error}</p>}

      <div>
        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          style={{
            border: "none",
            background: "transparent",
            padding: 0,
            cursor: "pointer",
            fontSize: 11.5,
            color: "var(--muted)",
            fontFamily: "var(--font-mono)",
          }}
        >
          {showAdvanced ? "▾" : "▸"} advanced: per-space deploy key {hasDeployKey ? "(configured ✓)" : "(not configured — uses the instance PAT)"}
        </button>
        {showAdvanced && (
          <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
            <p style={{ margin: 0, fontSize: 11.5, color: "var(--faint)", lineHeight: 1.5 }}>
              Optional override, preferred over the instance PAT when set. Generate a keypair yourself
              (<code style={{ fontFamily: "var(--font-mono)" }}>ssh-keygen -t ed25519 -f key -N &quot;&quot;</code>),
              add the <strong>public</strong> half to the GitHub repo&rsquo;s Deploy Keys (write access), and paste
              the <strong>private</strong> half below. Write-only — it is never shown again after saving.
            </p>
            <textarea
              aria-label="Deploy key (private, paste-once)"
              value={deployKeyPem}
              onChange={(e) => setDeployKeyPem(e.target.value)}
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;…&#10;-----END OPENSSH PRIVATE KEY-----"
              rows={4}
              style={{ ...inputStyle, fontFamily: "var(--font-mono)", resize: "vertical" }}
            />
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                onClick={() => void saveDeployKey()}
                disabled={savingKey || deployKeyPem.trim().length === 0}
                style={{ ...btnStyle, opacity: savingKey || deployKeyPem.trim().length === 0 ? 0.55 : 1 }}
              >
                {savingKey ? "Saving…" : "Save deploy key"}
              </button>
              {hasDeployKey && (
                <button
                  type="button"
                  onClick={() => void clearDeployKey()}
                  disabled={savingKey}
                  style={{ ...btnStyle, color: "var(--danger-ink)", opacity: savingKey ? 0.55 : 1 }}
                >
                  Clear deploy key
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
