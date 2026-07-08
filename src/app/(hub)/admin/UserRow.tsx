"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, useRef } from "react";

export type UserRowView = {
  id: number;
  displayName: string;
  email: string | null;
  tokenName: string | null;
  /** The stable, unique, URL-safe owner handle (Owner-namespace S1). Null only
   *  transiently before the boot backfill. Admin-editable. */
  handle: string | null;
  role: "admin" | "member";
  active: boolean;
  created: string; // YYYY-MM-DD stamp
  /** True when this row is the signed-in admin's own row. */
  isSelf: boolean;
  /** All of the user's emails (multi-email) — chips + add/remove control. */
  emails: Array<{ email: string; primary: boolean }>;
  /**
   * True when the role chip should be an interactive toggle. False only when
   * this is the last active admin's own row (guard prevents self-lockout).
   */
  canToggleRole: boolean;
};

const cell = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--muted)",
} as const;

const actionBtn = {
  fontSize: 11,
  fontWeight: 500,
  padding: "3px 10px",
  borderRadius: 6,
  background: "transparent",
  cursor: "pointer",
  fontFamily: "var(--font-sans)",
} as const;

/** Truncate a token name for display, keeping the full value in a title attr. */
function truncate(s: string, n = 16): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/**
 * One row of the admin Users table + its inline actions (deactivate/reactivate,
 * token edit, role toggle). The role chip is an admin/member toggle (admin-only)
 * guarded by the last-admin invariant — the only active admin cannot demote
 * themselves. Mirrors ShareRow's client-island pattern: confirm → PATCH →
 * router.refresh(); the page stays RSC.
 */
export default function UserRow({ row }: { row: UserRowView }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // ── role toggle state ──────────────────────────────────────────────────────
  const [roleError, setRoleError] = useState<string | null>(null);
  const [rolePending, setRolePending] = useState(false);

  // ── token editing state ────────────────────────────────────────────────────
  const [editingToken, setEditingToken] = useState(false);
  const [tokenDraft, setTokenDraft] = useState("");
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [tokenSaving, setTokenSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // ── display-name editing state ───────────────────────────────────────────────
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [nameSaving, setNameSaving] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);

  // ── handle editing state (Owner-namespace S1) ────────────────────────────────
  const [editingHandle, setEditingHandle] = useState(false);
  const [handleDraft, setHandleDraft] = useState("");
  const [handleError, setHandleError] = useState<string | null>(null);
  const [handleSaving, setHandleSaving] = useState(false);
  const handleInputRef = useRef<HTMLInputElement>(null);

  // ── email management state (multi-email) ─────────────────────────────────────
  const [addingEmail, setAddingEmail] = useState(false);
  const [emailDraft, setEmailDraft] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [emailBusy, setEmailBusy] = useState(false);
  const emailInputRef = useRef<HTMLInputElement>(null);

  function openAddEmail() {
    setEmailDraft("");
    setEmailError(null);
    setAddingEmail(true);
    setTimeout(() => emailInputRef.current?.focus(), 0);
  }

  async function addEmail() {
    const value = emailDraft.trim();
    if (value.length === 0) {
      setEmailError("Email can't be empty.");
      return;
    }
    setEmailError(null);
    setEmailBusy(true);
    try {
      const res = await fetch(`/api/users/${row.id}/emails`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: value }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setEmailError(data?.error ?? `Add failed (${res.status})`);
        return;
      }
      setAddingEmail(false);
      startTransition(() => router.refresh());
    } catch {
      setEmailError("Network error — no change made.");
    } finally {
      setEmailBusy(false);
    }
  }

  async function removeEmail(email: string) {
    if (!window.confirm(`Remove ${email} from "${row.displayName}"?`)) return;
    setEmailError(null);
    setEmailBusy(true);
    try {
      const res = await fetch(
        `/api/users/${row.id}/emails/${encodeURIComponent(email)}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setEmailError(data?.error ?? `Remove failed (${res.status})`);
        return;
      }
      startTransition(() => router.refresh());
    } catch {
      setEmailError("Network error — no change made.");
    } finally {
      setEmailBusy(false);
    }
  }

  async function toggleRole() {
    const next = row.role === "admin" ? "member" : "admin";
    const confirmMsg =
      next === "admin"
        ? `Promote "${row.displayName}" to admin? They will gain full admin access.`
        : `Demote "${row.displayName}" to member? They will lose admin access.`;
    if (!window.confirm(confirmMsg)) return;
    setRoleError(null);
    setRolePending(true);
    try {
      const res = await fetch(`/api/users/${row.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: next }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setRoleError(data?.error ?? `Role change failed (${res.status})`);
        return;
      }
      startTransition(() => router.refresh());
    } catch {
      setRoleError("Network error — no change made.");
    } finally {
      setRolePending(false);
    }
  }

  async function patch(body: Record<string, unknown>, confirmMsg: string) {
    if (!window.confirm(confirmMsg)) return;
    setError(null);
    try {
      const res = await fetch(`/api/users/${row.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? `Update failed (${res.status})`);
        return;
      }
      startTransition(() => router.refresh());
    } catch {
      setError("Network error — no change made.");
    }
  }

  function toggleActive() {
    const next = !row.active;
    patch(
      { active: next },
      next
        ? `Reactivate "${row.displayName}"? They regain access on next request.`
        : `Deactivate "${row.displayName}"? They drop to the pending screen until reactivated.`,
    );
  }

  function openTokenEdit() {
    setTokenDraft(row.tokenName ?? "");
    setTokenError(null);
    setEditingToken(true);
    // Focus happens after render via the ref
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  function cancelTokenEdit() {
    setEditingToken(false);
    setTokenError(null);
  }

  function openNameEdit() {
    setNameDraft(row.displayName);
    setNameError(null);
    setEditingName(true);
    setTimeout(() => nameInputRef.current?.focus(), 0);
  }

  function cancelNameEdit() {
    setEditingName(false);
    setNameError(null);
  }

  function openHandleEdit() {
    setHandleDraft(row.handle ?? "");
    setHandleError(null);
    setEditingHandle(true);
    setTimeout(() => handleInputRef.current?.focus(), 0);
  }

  function cancelHandleEdit() {
    setEditingHandle(false);
    setHandleError(null);
  }

  async function saveHandle() {
    const value = handleDraft.trim();
    if (value.length === 0) {
      setHandleError("Handle can't be empty.");
      return;
    }
    if (value === row.handle) {
      setEditingHandle(false);
      return;
    }
    setHandleError(null);
    setHandleSaving(true);
    try {
      const res = await fetch(`/api/users/${row.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handle: value }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setHandleError(data?.error ?? `Save failed (${res.status})`);
        return;
      }
      setEditingHandle(false);
      startTransition(() => router.refresh());
    } catch {
      setHandleError("Network error — no change made.");
    } finally {
      setHandleSaving(false);
    }
  }

  async function saveName() {
    const value = nameDraft.trim();
    if (value.length === 0) {
      setNameError("Display name can't be empty.");
      return;
    }
    if (value === row.displayName) {
      setEditingName(false);
      return;
    }
    setNameError(null);
    setNameSaving(true);
    try {
      const res = await fetch(`/api/users/${row.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: value }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setNameError(data?.error ?? `Save failed (${res.status})`);
        return;
      }
      setEditingName(false);
      startTransition(() => router.refresh());
    } catch {
      setNameError("Network error — no change made.");
    } finally {
      setNameSaving(false);
    }
  }

  async function saveToken() {
    setTokenError(null);
    setTokenSaving(true);
    const value = tokenDraft.trim();
    try {
      const res = await fetch(`/api/users/${row.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tokenName: value.length > 0 ? value : null }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setTokenError(data?.error ?? `Save failed (${res.status})`);
        return;
      }
      setEditingToken(false);
      startTransition(() => router.refresh());
    } catch {
      setTokenError("Network error — no change made.");
    } finally {
      setTokenSaving(false);
    }
  }

  return (
    <>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1.2fr 1.3fr 1fr 0.7fr 0.8fr 0.8fr 1fr",
          padding: "9px 14px",
          borderBottom:
            editingToken || editingName || editingHandle || addingEmail || emailError
              ? "none"
              : "1px solid var(--hairline)",
          alignItems: "center",
          opacity: row.active ? 1 : 0.45,
        }}
      >
        <span
          style={{
            fontSize: 12.5,
            fontWeight: 500,
            color: "var(--ink)",
            display: "flex",
            flexDirection: "column",
            gap: 3,
          }}
        >
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <span>{row.displayName}</span>
            {row.isSelf && (
              <span style={{ color: "var(--faint)", fontWeight: 400, fontSize: 11 }}>· you</span>
            )}
            <button
              type="button"
              onClick={openNameEdit}
              title="Edit display name"
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                padding: "0 2px",
                color: "var(--faint)",
                fontSize: 10,
                lineHeight: 1,
              }}
            >
              ✎
            </button>
          </span>
          {/* owner handle (Owner-namespace S1) — the stable @identity + edit. */}
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              fontFamily: "var(--font-mono)",
              fontSize: 10.5,
              fontWeight: 400,
              color: "var(--faint)",
            }}
          >
            <span title="Owner handle — stable, unique identity for repo paths & URLs">
              {row.handle ? `@${row.handle}` : "@—"}
            </span>
            <button
              type="button"
              onClick={openHandleEdit}
              title="Edit owner handle"
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                padding: "0 2px",
                color: "var(--faint)",
                fontSize: 10,
                lineHeight: 1,
              }}
            >
              ✎
            </button>
          </span>
        </span>
        {/* email cell — chips (primary flagged) + add control. */}
        <span
          style={{
            ...cell,
            display: "flex",
            flexWrap: "wrap",
            gap: 3,
            alignItems: "center",
          }}
        >
          {row.emails.length === 0 && <span>—</span>}
          {row.emails.map((e) => (
            <span
              key={e.email}
              title={e.primary ? `${e.email} (primary / display)` : e.email}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 3,
                fontFamily: "var(--font-mono)",
                fontSize: 10,
                padding: "1px 6px",
                borderRadius: 999,
                border: "1px solid var(--hairline-strong)",
                background: e.primary ? "var(--surface-alt)" : "var(--surface)",
                color: "var(--muted)",
              }}
            >
              <span style={{ overflowWrap: "anywhere" }}>{e.email}</span>
              {e.primary && (
                <span style={{ color: "var(--faint)", fontSize: 8.5, letterSpacing: "0.04em" }}>
                  ★
                </span>
              )}
              <button
                type="button"
                onClick={() => void removeEmail(e.email)}
                disabled={emailBusy}
                title={`Remove ${e.email}`}
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  padding: 0,
                  marginLeft: 1,
                  color: "var(--faint)",
                  fontSize: 11,
                  lineHeight: 1,
                }}
              >
                ×
              </button>
            </span>
          ))}
          {!addingEmail && (
            <button
              type="button"
              onClick={openAddEmail}
              title="Add an email to this user"
              style={{
                background: "none",
                border: "1px solid var(--hairline)",
                borderRadius: 999,
                cursor: "pointer",
                padding: "1px 7px",
                color: "var(--faint)",
                fontSize: 10,
                lineHeight: 1.3,
              }}
            >
              + email
            </button>
          )}
        </span>
        {/* token cell — truncated display + pencil trigger */}
        <span style={{ ...cell, display: "inline-flex", alignItems: "center", gap: 4 }}>
          <span title={row.tokenName ?? undefined}>
            {row.tokenName ? truncate(row.tokenName) : "—"}
          </span>
          <button
            type="button"
            onClick={openTokenEdit}
            title="Edit service-token Client ID"
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              padding: "0 2px",
              color: "var(--faint)",
              fontSize: 10,
              lineHeight: 1,
            }}
          >
            ✎
          </button>
        </span>
        <span style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          {row.canToggleRole ? (
            <button
              type="button"
              onClick={() => void toggleRole()}
              disabled={rolePending}
              title={
                row.role === "admin"
                  ? "Click to demote to member"
                  : "Click to promote to admin"
              }
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 10,
                padding: "2px 7px",
                borderRadius: 999,
                border: "1px solid",
                borderColor: row.role === "admin" ? "var(--ref-border)" : "var(--hairline)",
                background: row.role === "admin" ? "var(--ref-bg)" : "var(--surface-alt)",
                color: row.role === "admin" ? "var(--ref-ink)" : "var(--faint)",
                cursor: rolePending ? "default" : "pointer",
              }}
            >
              {rolePending ? "…" : row.role}
            </button>
          ) : (
            <span
              title="You are the only active admin — promote another user before changing your role"
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 10,
                padding: "2px 7px",
                borderRadius: 999,
                border: "1px solid var(--ref-border)",
                background: "var(--ref-bg)",
                color: "var(--ref-ink)",
                cursor: "default",
              }}
            >
              {row.role}
            </span>
          )}
          {roleError && (
            <span style={{ fontSize: 10, color: "var(--danger-ink)", lineHeight: 1.3 }}>
              {roleError}
            </span>
          )}
        </span>
        <span
          style={{
            ...cell,
            fontSize: 10,
            color: row.active ? "var(--faint)" : "var(--warn-ink)",
          }}
        >
          {row.active ? "active" : "inactive"}
        </span>
        <span style={cell}>{row.created}</span>
        <span style={{ display: "inline-flex", gap: 6, justifySelf: "end" }}>
          {row.isSelf && row.active ? (
            <button
              type="button"
              disabled
              title="you can't deactivate yourself"
              style={{
                ...actionBtn,
                border: "1px solid var(--hairline)",
                color: "var(--faint)",
                cursor: "default",
              }}
            >
              deactivate
            </button>
          ) : (
            <button
              type="button"
              onClick={toggleActive}
              disabled={pending}
              style={{
                ...actionBtn,
                border: `1px solid ${row.active ? "var(--danger-border)" : "var(--ref-border)"}`,
                color: row.active ? "var(--danger-ink)" : "var(--ref-ink)",
              }}
            >
              {pending ? "…" : row.active ? "deactivate" : "reactivate"}
            </button>
          )}
        </span>
      </div>
      {/* ── inline display-name editor ── */}
      {/* ── inline add-email editor ── */}
      {addingEmail && (
        <div
          style={{
            padding: "8px 14px 10px",
            borderBottom: "1px solid var(--hairline)",
            background: "var(--surface-alt)",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <input
            ref={emailInputRef}
            type="email"
            value={emailDraft}
            onChange={(e) => setEmailDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void addEmail();
              if (e.key === "Escape") setAddingEmail(false);
            }}
            placeholder="new email — any of a user's emails signs in as them"
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: 12.5,
              flex: 1,
              padding: "4px 8px",
              borderRadius: 6,
              border: "1px solid var(--hairline-strong)",
              background: "var(--surface)",
              color: "var(--ink)",
              minWidth: 0,
            }}
          />
          <button
            type="button"
            onClick={() => void addEmail()}
            disabled={emailBusy}
            style={{ ...actionBtn, border: "1px solid var(--ref-border)", color: "var(--ref-ink)" }}
          >
            {emailBusy ? "…" : "add"}
          </button>
          <button
            type="button"
            onClick={() => setAddingEmail(false)}
            disabled={emailBusy}
            style={{ ...actionBtn, border: "1px solid var(--hairline)", color: "var(--faint)" }}
          >
            cancel
          </button>
          {emailError && (
            <span style={{ fontSize: 11, color: "var(--danger-ink)" }}>{emailError}</span>
          )}
        </div>
      )}
      {/* email error outside the add form (e.g. a failed remove) */}
      {!addingEmail && emailError && (
        <div
          style={{
            padding: "4px 14px 8px",
            borderBottom: "1px solid var(--hairline)",
            fontSize: 11.5,
            color: "var(--danger-ink)",
          }}
        >
          {emailError}
        </div>
      )}
      {editingName && (
        <div
          style={{
            padding: "8px 14px 10px",
            borderBottom: "1px solid var(--hairline)",
            background: "var(--surface-alt)",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <input
            ref={nameInputRef}
            type="text"
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void saveName();
              if (e.key === "Escape") cancelNameEdit();
            }}
            placeholder="Display name"
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: 12.5,
              flex: 1,
              padding: "4px 8px",
              borderRadius: 6,
              border: "1px solid var(--hairline-strong)",
              background: "var(--surface)",
              color: "var(--ink)",
              minWidth: 0,
            }}
          />
          <button
            type="button"
            onClick={() => void saveName()}
            disabled={nameSaving}
            style={{
              ...actionBtn,
              border: "1px solid var(--ref-border)",
              color: "var(--ref-ink)",
            }}
          >
            {nameSaving ? "…" : "save"}
          </button>
          <button
            type="button"
            onClick={cancelNameEdit}
            disabled={nameSaving}
            style={{
              ...actionBtn,
              border: "1px solid var(--hairline)",
              color: "var(--faint)",
            }}
          >
            cancel
          </button>
          {nameError && (
            <span style={{ fontSize: 11, color: "var(--danger-ink)" }}>{nameError}</span>
          )}
        </div>
      )}
      {/* ── inline handle editor (Owner-namespace S1) ── */}
      {editingHandle && (
        <div
          style={{
            padding: "8px 14px 10px",
            borderBottom: "1px solid var(--hairline)",
            background: "var(--surface-alt)",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <input
            ref={handleInputRef}
            type="text"
            value={handleDraft}
            onChange={(e) => setHandleDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void saveHandle();
              if (e.key === "Escape") cancelHandleEdit();
            }}
            placeholder="owner handle — ^[a-z0-9][a-z0-9-]*$, ≤ 39 chars"
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              flex: 1,
              padding: "4px 8px",
              borderRadius: 6,
              border: "1px solid var(--hairline-strong)",
              background: "var(--surface)",
              color: "var(--ink)",
              minWidth: 0,
            }}
          />
          <button
            type="button"
            onClick={() => void saveHandle()}
            disabled={handleSaving}
            style={{
              ...actionBtn,
              border: "1px solid var(--ref-border)",
              color: "var(--ref-ink)",
            }}
          >
            {handleSaving ? "…" : "save"}
          </button>
          <button
            type="button"
            onClick={cancelHandleEdit}
            disabled={handleSaving}
            style={{
              ...actionBtn,
              border: "1px solid var(--hairline)",
              color: "var(--faint)",
            }}
          >
            cancel
          </button>
          {handleError && (
            <span style={{ fontSize: 11, color: "var(--danger-ink)" }}>{handleError}</span>
          )}
        </div>
      )}
      {/* ── inline token editor ── */}
      {editingToken && (
        <div
          style={{
            padding: "8px 14px 10px",
            borderBottom: "1px solid var(--hairline)",
            background: "var(--surface-alt)",
            display: "flex",
            alignItems: "flex-start",
            gap: 8,
          }}
        >
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
            <input
              ref={inputRef}
              type="text"
              value={tokenDraft}
              onChange={(e) => setTokenDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void saveToken();
                if (e.key === "Escape") cancelTokenEdit();
              }}
              placeholder="<client-id>.access  (leave empty to clear)"
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                width: "100%",
                padding: "4px 8px",
                borderRadius: 6,
                border: "1px solid var(--hairline-strong)",
                background: "var(--surface)",
                color: "var(--ink)",
                minWidth: 0,
                boxSizing: "border-box",
              }}
            />
            <span style={{ fontSize: 10.5, lineHeight: 1.4, color: "var(--faint)" }}>
              Paste the Cloudflare Access service token{" "}
              <strong style={{ fontWeight: 600 }}>Client ID</strong> (the{" "}
              <span style={{ fontFamily: "var(--font-mono)" }}>…access</span> value
              from Zero Trust → Access → Service Auth) — <strong style={{ fontWeight: 600 }}>not</strong>{" "}
              the Client Secret (that goes only in the agent&rsquo;s config).{" "}
              <a href="/help#mcp" style={{ color: "var(--accent)", textDecoration: "none" }}>
                What&rsquo;s this?
              </a>
            </span>
          </div>
          <button
            type="button"
            onClick={() => void saveToken()}
            disabled={tokenSaving}
            style={{
              ...actionBtn,
              border: "1px solid var(--ref-border)",
              color: "var(--ref-ink)",
              alignSelf: "flex-start",
            }}
          >
            {tokenSaving ? "…" : "save"}
          </button>
          <button
            type="button"
            onClick={cancelTokenEdit}
            disabled={tokenSaving}
            style={{
              ...actionBtn,
              border: "1px solid var(--hairline)",
              color: "var(--faint)",
              alignSelf: "flex-start",
            }}
          >
            cancel
          </button>
          {tokenError && (
            <span style={{ fontSize: 11, color: "var(--danger-ink)" }}>{tokenError}</span>
          )}
        </div>
      )}
      {error && (
        <div
          style={{
            padding: "4px 14px 8px",
            borderBottom: "1px solid var(--hairline)",
            fontSize: 11.5,
            color: "var(--danger-ink)",
          }}
        >
          {error}
        </div>
      )}
    </>
  );
}
