"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { slugFromFilename, isValidSlug } from "@/lib/slug";
import AudienceBadge from "@/components/AudienceBadge";

export type AudienceMemberChip = { userId: number; displayName: string };
export type UserOption = { id: number; displayName: string };

export type AudienceRowView = {
  id: number;
  key: string;
  label: string;
  memberVisible: boolean;
  docCount: number;
  /** Users explicitly added to this audience (group membership). */
  members: AudienceMemberChip[];
};

const tableHead = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--faint)",
} as const;

const cell = { fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--muted)" } as const;

const actionBtn = {
  fontSize: 11,
  fontWeight: 500,
  padding: "3px 10px",
  borderRadius: 6,
  background: "transparent",
  cursor: "pointer",
  fontFamily: "var(--font-sans)",
} as const;

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

const GRID = "1.2fr 1fr 1.1fr 0.7fr 0.8fr";

const chipStyle = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  fontSize: 11,
  fontFamily: "var(--font-sans)",
  padding: "2px 4px 2px 9px",
  borderRadius: 999,
  border: "1px solid var(--hairline-strong)",
  background: "var(--surface-alt)",
  color: "var(--ink)",
} as const;

const chipX = {
  ...actionBtn,
  padding: "0 5px",
  fontSize: 12,
  lineHeight: 1,
  border: "none",
  color: "var(--faint)",
} as const;

/** One audience row + its inline toggle / delete actions + member management. */
function AudienceRow({ row, userOptions }: { row: AudienceRowView; userOptions: UserOption[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [addUserId, setAddUserId] = useState<string>("");

  async function mutate(method: "PATCH" | "DELETE", body?: Record<string, unknown>) {
    setError(null);
    try {
      const res = await fetch(`/api/audiences/${row.id}`, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? `Request failed (${res.status})`);
        return;
      }
      startTransition(() => router.refresh());
    } catch {
      setError("Network error — no change made.");
    }
  }

  // Membership writes hit the /members sub-resource (POST add, DELETE remove).
  async function addMember(userId: number) {
    setError(null);
    try {
      const res = await fetch(`/api/audiences/${row.id}/members`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? `Add failed (${res.status})`);
        return;
      }
      setAddUserId("");
      startTransition(() => router.refresh());
    } catch {
      setError("Network error — member not added.");
    }
  }

  async function removeMember(userId: number) {
    setError(null);
    try {
      const res = await fetch(`/api/audiences/${row.id}/members/${userId}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? `Remove failed (${res.status})`);
        return;
      }
      startTransition(() => router.refresh());
    } catch {
      setError("Network error — member not removed.");
    }
  }

  function toggleVisible() {
    const next = !row.memberVisible;
    const msg = next
      ? `Make "${row.label}" visible to ALL members? Every signed-in member will then see all docs in this audience (membership list stops mattering).`
      : `Switch "${row.label}" to listed-members-only? Only users in its member list (below) will see its docs.`;
    if (!window.confirm(msg)) return;
    void mutate("PATCH", { memberVisible: next });
  }

  // Users not already in this audience — the add-member picker's options.
  const memberIds = new Set(row.members.map((m) => m.userId));
  const candidates = userOptions.filter((u) => !memberIds.has(u.id));

  function remove() {
    if (row.docCount > 0) return; // disabled — guard anyway
    if (!window.confirm(`Delete audience "${row.label}" (${row.key})? It has no docs.`)) return;
    void mutate("DELETE");
  }

  const inUse = row.docCount > 0;

  return (
    <>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: GRID,
          padding: "9px 14px",
          borderBottom: "1px solid var(--hairline)",
          alignItems: "center",
        }}
      >
        <span>
          <AudienceBadge audience={row.key} label={row.label} />
        </span>
        <span style={cell}>{row.key}</span>
        <span>
          <button
            type="button"
            onClick={toggleVisible}
            disabled={pending}
            title={
              row.memberVisible
                ? "All members see this audience's docs — click to restrict to listed members only"
                : "Only listed members see this audience's docs — click to make it visible to all members"
            }
            style={{
              ...actionBtn,
              border: "1px solid",
              borderColor: row.memberVisible ? "var(--ref-border)" : "var(--hairline)",
              background: row.memberVisible ? "var(--ref-bg)" : "var(--surface-alt)",
              color: row.memberVisible ? "var(--ref-ink)" : "var(--faint)",
            }}
          >
            {row.memberVisible ? "all members" : "only listed"}
          </button>
        </span>
        <span style={cell}>{row.docCount}</span>
        <span style={{ justifySelf: "end" }}>
          <button
            type="button"
            onClick={remove}
            disabled={pending || inUse}
            title={inUse ? `In use by ${row.docCount} doc${row.docCount === 1 ? "" : "s"} — re-point them first` : "Delete audience"}
            style={{
              ...actionBtn,
              border: `1px solid ${inUse ? "var(--hairline)" : "var(--danger-border)"}`,
              color: inUse ? "var(--faint)" : "var(--danger-ink)",
              cursor: inUse ? "default" : "pointer",
            }}
          >
            delete
          </button>
        </span>
      </div>
      {/* members sub-row — group membership (who sees this audience's docs even
          when it's not member-visible). */}
      <div
        style={{
          padding: "2px 14px 10px 14px",
          borderBottom: "1px solid var(--hairline)",
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 6,
        }}
      >
        <span style={{ ...labelStyle, marginBottom: 0, marginRight: 4 }}>members</span>
        {row.members.length === 0 ? (
          <span style={{ fontSize: 11, color: "var(--faint)" }}>
            {row.memberVisible ? "all members (member-visible)" : "none yet"}
          </span>
        ) : (
          row.members.map((m) => (
            <span key={m.userId} style={chipStyle}>
              {m.displayName}
              <button
                type="button"
                onClick={() => removeMember(m.userId)}
                disabled={pending}
                title={`Remove ${m.displayName} from ${row.label}`}
                style={chipX}
              >
                ×
              </button>
            </span>
          ))
        )}
        {candidates.length > 0 && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4, marginLeft: 4 }}>
            <select
              value={addUserId}
              onChange={(e) => setAddUserId(e.target.value)}
              disabled={pending}
              style={{
                ...inputStyle,
                width: "auto",
                fontSize: 11.5,
                padding: "3px 6px",
              }}
            >
              <option value="">add member…</option>
              {candidates.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.displayName}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => {
                const id = parseInt(addUserId, 10);
                if (!Number.isNaN(id)) void addMember(id);
              }}
              disabled={pending || addUserId === ""}
              style={{
                ...actionBtn,
                border: "1px solid var(--accent)",
                background: addUserId === "" ? "var(--surface-alt)" : "var(--accent)",
                color: addUserId === "" ? "var(--faint)" : "#fff",
                cursor: addUserId === "" ? "default" : "pointer",
              }}
            >
              add
            </button>
          </span>
        )}
      </div>
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

/** Add-audience form. Label is required; key auto-derives from the label (editable). */
function AddAudience() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [label, setLabel] = useState("");
  const [key, setKey] = useState("");
  const [keyDirty, setKeyDirty] = useState(false);
  const [memberVisible, setMemberVisible] = useState(false);

  function onLabel(v: string) {
    setLabel(v);
    // Auto-derive the key from the label until the admin edits the key by hand.
    if (!keyDirty) setKey(slugFromFilename(v));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (label.trim().length === 0) {
      setError("Label is required.");
      return;
    }
    if (!isValidSlug(key)) {
      setError("Key must match ^[a-z0-9][a-z0-9-]*$ (lowercase letters, digits, dashes; no leading dash).");
      return;
    }
    try {
      const res = await fetch("/api/audiences", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: key.trim(), label: label.trim(), memberVisible }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? `Add failed (${res.status})`);
        return;
      }
      setLabel("");
      setKey("");
      setKeyDirty(false);
      setMemberVisible(false);
      startTransition(() => router.refresh());
    } catch {
      setError("Network error — audience not added.");
    }
  }

  const keyValid = key === "" || isValidSlug(key);

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
      <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1.2fr auto auto", gap: 10, alignItems: "end" }}>
        <div>
          <label style={labelStyle} htmlFor="add-aud-label">label *</label>
          <input
            id="add-aud-label"
            style={inputStyle}
            value={label}
            onChange={(e) => onLabel(e.target.value)}
            placeholder="Microsoft"
            disabled={pending}
          />
        </div>
        <div>
          <label style={labelStyle} htmlFor="add-aud-key">key (auto from label, editable)</label>
          <input
            id="add-aud-key"
            style={{
              ...inputStyle,
              fontFamily: "var(--font-mono)",
              borderColor: keyValid ? "var(--hairline-strong)" : "var(--danger-border)",
            }}
            value={key}
            onChange={(e) => {
              setKeyDirty(true);
              setKey(e.target.value);
            }}
            placeholder="microsoft"
            disabled={pending}
          />
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--muted)", paddingBottom: 7 }}>
          <input
            type="checkbox"
            checked={memberVisible}
            onChange={(e) => setMemberVisible(e.target.checked)}
            disabled={pending}
          />
          visible to all members
        </label>
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
          {pending ? "…" : "add audience"}
        </button>
      </div>

      {error && <div style={{ marginTop: 10, fontSize: 11.5, color: "var(--danger-ink)" }}>{error}</div>}

      <div style={{ marginTop: 12, fontSize: 11, lineHeight: 1.5, color: "var(--faint)" }}>
        An audience is a <strong style={{ fontWeight: 600 }}>group</strong>. The{" "}
        <strong style={{ fontWeight: 600 }}>key</strong> is what docs store.{" "}
        <strong style={{ fontWeight: 600 }}>Visible to all members</strong> ON means every signed-in member
        sees its docs; OFF means only the users you add to its member list do (e.g. add a partner&rsquo;s user to
        a <code>bob</code> audience so they — and only they — see <code>bob</code> docs).
      </div>
    </form>
  );
}

export default function Audiences({
  rows,
  userOptions,
}: {
  rows: AudienceRowView[];
  userOptions: UserOption[];
}) {
  return (
    <div
      style={{
        border: "1px solid var(--hairline)",
        borderRadius: 10,
        background: "var(--surface)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: GRID,
          padding: "8px 14px",
          borderBottom: "1px solid var(--hairline)",
          background: "var(--surface-alt)",
          ...tableHead,
        }}
      >
        <span>label</span>
        <span>key</span>
        <span>visibility</span>
        <span>docs</span>
        <span style={{ justifySelf: "end" }}>actions</span>
      </div>
      {rows.length === 0 ? (
        <div style={{ padding: "24px 14px", fontSize: 12.5, color: "var(--muted)" }}>
          No audiences yet — add the first one below.
        </div>
      ) : (
        rows.map((r) => <AudienceRow key={r.id} row={r} userOptions={userOptions} />)
      )}
      <div style={{ padding: "12px 14px 14px" }}>
        <AddAudience />
      </div>
    </div>
  );
}
