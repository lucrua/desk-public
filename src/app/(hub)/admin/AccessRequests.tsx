"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { AccessRequestRowView } from "./view-model";

const tableHead = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--faint)",
} as const;

const sectionH2 = {
  fontSize: 14,
  fontWeight: 600,
  margin: "0 0 10px",
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

const cell = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--muted)",
} as const;

/**
 * One pending access-request row: an amber-informational line with the email
 * (mono), first/last seen, hits, an inline Approve (name prefilled with the
 * default; creates a member) and Dismiss. Mirrors the UserRow client-island
 * pattern — fetch → router.refresh().
 */
export type AliasOption = { id: number; displayName: string };

function AccessRequestRow({
  row,
  userOptions,
}: {
  row: AccessRequestRowView;
  userOptions: AliasOption[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState(row.defaultDisplayName);
  // "" = create a new user (default); a numeric id = add this email to that user.
  const [aliasOf, setAliasOf] = useState<string>("");
  const [busy, setBusy] = useState<null | "approve" | "dismiss">(null);

  const isAlias = aliasOf !== "";

  async function approve() {
    const value = nameDraft.trim();
    // In alias mode the display name is irrelevant (the existing user keeps
    // theirs); only require a non-empty name when creating a new user.
    if (!isAlias && value.length === 0) {
      setError("Display name can't be empty.");
      return;
    }
    setError(null);
    setBusy("approve");
    try {
      const body = isAlias
        ? { aliasOfUserId: Number(aliasOf) }
        : { displayName: value };
      const res = await fetch(`/api/access-requests/${row.id}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? `Approve failed (${res.status})`);
        return;
      }
      startTransition(() => router.refresh());
    } catch {
      setError("Network error — no change made.");
    } finally {
      setBusy(null);
    }
  }

  async function dismiss() {
    if (!window.confirm(`Dismiss the access request from "${row.email}"?`)) return;
    setError(null);
    setBusy("dismiss");
    try {
      const res = await fetch(`/api/access-requests/${row.id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? `Dismiss failed (${res.status})`);
        return;
      }
      startTransition(() => router.refresh());
    } catch {
      setError("Network error — no change made.");
    } finally {
      setBusy(null);
    }
  }

  const disabled = pending || busy !== null;

  return (
    <>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1.6fr 0.9fr 0.9fr 0.5fr 1.6fr",
          padding: "9px 14px",
          borderBottom: error ? "none" : "1px solid var(--warn-border)",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span style={{ ...cell, color: "var(--ink)", overflowWrap: "anywhere" }}>{row.email}</span>
        <span style={{ ...cell, fontSize: 10 }}>{row.firstSeen}</span>
        <span style={{ ...cell, fontSize: 10 }}>{row.lastSeen}</span>
        <span style={{ ...cell, fontSize: 10 }}>{row.hits}</span>
        <span style={{ display: "inline-flex", gap: 6, justifySelf: "end", alignItems: "center" }}>
          <input
            type="text"
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void approve();
            }}
            placeholder="Display name"
            disabled={disabled || isAlias}
            title={
              isAlias
                ? "Not used when adding to an existing user"
                : "Display name for the new member (prefilled — edit if you like)"
            }
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: 11.5,
              width: 110,
              padding: "4px 8px",
              borderRadius: 6,
              border: "1px solid var(--hairline-strong)",
              background: "var(--surface)",
              color: "var(--ink)",
              minWidth: 0,
              opacity: isAlias ? 0.5 : 1,
            }}
          />
          {userOptions.length > 0 && (
            <select
              value={aliasOf}
              onChange={(e) => setAliasOf(e.target.value)}
              disabled={disabled}
              title="Approve as a new user, or add this email to an existing user"
              style={{
                fontFamily: "var(--font-sans)",
                fontSize: 11.5,
                maxWidth: 130,
                padding: "4px 6px",
                borderRadius: 6,
                border: "1px solid var(--hairline-strong)",
                background: "var(--surface)",
                color: "var(--ink)",
              }}
            >
              <option value="">+ new user</option>
              {userOptions.map((u) => (
                <option key={u.id} value={String(u.id)}>
                  add to: {u.displayName}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            onClick={() => void approve()}
            disabled={disabled}
            style={{
              ...actionBtn,
              border: "1px solid var(--ref-border)",
              color: "var(--ref-ink)",
            }}
          >
            {busy === "approve" ? "…" : "approve"}
          </button>
          <button
            type="button"
            onClick={() => void dismiss()}
            disabled={disabled}
            style={{
              ...actionBtn,
              border: "1px solid var(--hairline)",
              color: "var(--faint)",
            }}
          >
            {busy === "dismiss" ? "…" : "dismiss"}
          </button>
        </span>
      </div>
      {error && (
        <div
          style={{
            padding: "4px 14px 8px",
            borderBottom: "1px solid var(--warn-border)",
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

/**
 * The "Access requests" section, rendered at the TOP of the admin page only
 * when there are pending requests. Amber-informational framing: these are
 * verified visitors (they already passed the CF wall) waiting for content
 * access. Approving creates a member; dismissing clears the request.
 */
export default function AccessRequests({
  rows,
  userOptions = [],
}: {
  rows: AccessRequestRowView[];
  userOptions?: AliasOption[];
}) {
  if (rows.length === 0) return null;

  return (
    <section style={{ marginBottom: 30 }}>
      <h2 style={sectionH2}>
        Access requests{" "}
        <span style={{ fontWeight: 400, color: "var(--warn-ink)", fontSize: 11.5 }}>
          · {rows.length} verified visitor{rows.length === 1 ? "" : "s"} waiting for access
        </span>
      </h2>
      <div
        style={{
          border: "1px solid var(--warn-border)",
          borderRadius: 10,
          background: "var(--warn-bg)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1.6fr 0.9fr 0.9fr 0.5fr 1.6fr",
            padding: "8px 14px",
            borderBottom: "1px solid var(--warn-border)",
            ...tableHead,
          }}
        >
          <span>email</span>
          <span>first seen</span>
          <span>last seen</span>
          <span>hits</span>
          <span style={{ justifySelf: "end" }}>actions</span>
        </div>
        {rows.map((r) => (
          <AccessRequestRow key={r.id} row={r} userOptions={userOptions} />
        ))}
      </div>
      <div style={{ fontSize: 11, color: "var(--faint)", marginTop: 8, lineHeight: 1.5 }}>
        They already passed the wall; approving grants content access.
      </div>
    </section>
  );
}
