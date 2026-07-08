"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

export type MemberRow = {
  userId: number;
  role: "owner" | "writer" | "reader";
  label: string;
  sub: string | null;
  isOwner: boolean;
};

export type UserChoice = {
  id: number;
  label: string;
  email: string | null;
};

const roleBadge = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  padding: "1px 7px",
  borderRadius: 999,
  border: "1px solid var(--hairline)",
  color: "var(--muted)",
  background: "var(--surface-alt)",
} as const;

const selectStyle = {
  fontSize: 12,
  fontFamily: "var(--font-sans)",
  padding: "5px 8px",
  borderRadius: 6,
  border: "1px solid var(--hairline-strong)",
  background: "var(--surface-alt)",
  color: "var(--ink)",
} as const;

/**
 * Members panel. Read-only list for everyone who can see the space; for an admin
 * or the owner (`canManage`), an add-member control (pick a user + role) and per-
 * row role change / remove. The space owner row is never editable here
 * (ownership transfer is out of scope). All mutations POST
 * /api/spaces/[owner]/[slug]/members.
 */
export default function MembersPanel({
  owner,
  slug,
  members,
  userChoices,
  canManage,
}: {
  owner: string;
  slug: string;
  members: MemberRow[];
  userChoices: UserChoice[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [addUserId, setAddUserId] = useState<string>("");
  const [addRole, setAddRole] = useState<"writer" | "reader">("reader");

  // Users not already members (eligible to add).
  const memberIds = new Set(members.map((m) => m.userId));
  const addable = userChoices.filter((u) => !memberIds.has(u.id));

  async function post(userId: number, role: "writer" | "reader" | null) {
    setError(null);
    try {
      const res = await fetch(`/api/spaces/${owner}/${slug}/members`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId, role }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? `Update failed (${res.status})`);
        return;
      }
      startTransition(() => router.refresh());
    } catch {
      setError("Network error — membership unchanged.");
    }
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (addUserId === "") {
      setError("Pick a user to add.");
      return;
    }
    await post(Number(addUserId), addRole);
    setAddUserId("");
    setAddRole("reader");
  }

  return (
    <div>
      <div style={{ border: "1px solid var(--hairline)", borderRadius: 10, overflow: "hidden" }}>
        {members.map((m, i) => (
          <div
            key={m.userId}
            data-testid={`member-row-${m.userId}`}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "11px 14px",
              borderTop: i === 0 ? "none" : "1px solid var(--hairline)",
              background: "var(--surface)",
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13.5, fontWeight: 500 }}>
                {m.label}
                {m.isOwner && <span style={{ ...roleBadge, marginLeft: 8 }}>owner</span>}
              </div>
              {m.sub && (
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--faint)", marginTop: 2 }}>
                  {m.sub}
                </div>
              )}
            </div>

            {/* Owner row is fixed; others editable only when canManage. */}
            {m.isOwner ? (
              <span style={roleBadge}>owner</span>
            ) : canManage ? (
              <>
                <select
                  aria-label={`Role for ${m.label}`}
                  value={m.role}
                  onChange={(e) => void post(m.userId, e.target.value as "writer" | "reader")}
                  disabled={pending}
                  style={selectStyle}
                >
                  <option value="reader">reader</option>
                  <option value="writer">writer</option>
                </select>
                <button
                  type="button"
                  onClick={() => void post(m.userId, null)}
                  disabled={pending}
                  style={{
                    fontSize: 12,
                    padding: "5px 10px",
                    borderRadius: 6,
                    border: "1px solid var(--hairline-strong)",
                    background: "var(--surface-alt)",
                    color: "var(--danger-ink)",
                    cursor: pending ? "default" : "pointer",
                  }}
                >
                  remove
                </button>
              </>
            ) : (
              <span style={roleBadge}>{m.role}</span>
            )}
          </div>
        ))}
      </div>

      {canManage && (
        <form
          onSubmit={add}
          style={{
            marginTop: 12,
            display: "flex",
            gap: 8,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <select
            aria-label="User to add"
            value={addUserId}
            onChange={(e) => setAddUserId(e.target.value)}
            disabled={pending || addable.length === 0}
            style={{ ...selectStyle, minWidth: 200 }}
          >
            <option value="">
              {addable.length === 0 ? "no users to add" : "add a member…"}
            </option>
            {addable.map((u) => (
              <option key={u.id} value={u.id}>
                {u.label}
                {u.email ? ` (${u.email})` : ""}
              </option>
            ))}
          </select>
          <select
            aria-label="Role for the new member"
            value={addRole}
            onChange={(e) => setAddRole(e.target.value as "writer" | "reader")}
            disabled={pending}
            style={selectStyle}
          >
            <option value="reader">reader</option>
            <option value="writer">writer</option>
          </select>
          <button
            type="submit"
            disabled={pending || addUserId === ""}
            style={{
              fontSize: 12.5,
              fontWeight: 500,
              padding: "6px 14px",
              borderRadius: 6,
              border: "1px solid var(--accent)",
              background: "var(--accent)",
              color: "#fff",
              cursor: pending || addUserId === "" ? "default" : "pointer",
            }}
          >
            add
          </button>
        </form>
      )}

      {error && <p style={{ margin: "10px 0 0", fontSize: 11.5, color: "var(--danger-ink)" }}>{error}</p>}
    </div>
  );
}
