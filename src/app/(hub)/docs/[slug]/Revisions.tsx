"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { DiffLine } from "@/lib/diff";
import {
  groupRevisions,
  proposedChangesLabel,
  revisionStamp,
  revisionAuthorChip,
  shareBadgeLabel,
  statusLabel,
  acceptUnavailableReason,
  type RevisionDTO,
} from "./revisions-view-model";

/**
 * Operator-register proposed-revisions section for /docs/[slug].
 *
 * The page server-renders the revision list + the unified diffs (vs base, and
 * vs current when the base is stale) so the diff math lives server-side and the
 * island stays presentational. This island owns the open/decided disclosure,
 * the per-revision diff expansion, and the admin accept/reject actions.
 *
 * SECURITY: diff lines + note + authorName are rendered as plain JSX text (React
 * escapes). The diff `text` comes from doc content but is shown as escaped text
 * nodes (never an HTML sink), exactly like the version-rail diff view.
 */

export type RevisionViewData = {
  rev: RevisionDTO;
  /** Unified diff base → proposed. */
  diff: DiffLine[];
  /** True when the doc moved past the revision's base version. */
  staleBase: boolean;
  /** Diff current → proposed, present only when staleBase. */
  diffVsCurrent: DiffLine[] | null;
};

export default function Revisions({
  slug,
  isAdmin,
  data,
  isMirrored = false,
}: {
  slug: string;
  isAdmin: boolean;
  data: RevisionViewData[];
  /** The doc's space is `source_mode=mirrored` — GitHub is canon there, so an
   * Accept would be refused server-side. Surfaces a note instead of Accept. */
  isMirrored?: boolean;
}) {
  const router = useRouter();
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [showDecided, setShowDecided] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const byId = new Map(data.map((d) => [d.rev.id, d]));
  const { open, decided, openCount, decidedCount } = groupRevisions(data.map((d) => d.rev));
  const pill = proposedChangesLabel(openCount);

  async function decide(id: number, accept: boolean) {
    const verb = accept ? "Accept" : "Reject";
    if (!window.confirm(`${verb} this proposed revision?`)) return;
    setError(null);
    setBusyId(id);
    try {
      const path = accept ? "accept" : "reject";
      const res = await fetch(`/api/revisions/${id}/${path}`, { method: "POST" });
      if (!res.ok) {
        const d = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(d?.error ?? `Could not ${verb.toLowerCase()} (${res.status})`);
        setBusyId(null);
        return;
      }
      // Accept publishes a new version (rail grows); refresh the server tree.
      router.refresh();
    } catch {
      setError(`Network error — not ${accept ? "accepted" : "rejected"}.`);
      setBusyId(null);
    }
  }

  return (
    <section
      id="revisions"
      style={{ marginTop: 40, borderTop: "1px solid var(--hairline)", paddingTop: 28 }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <h2
          style={{
            fontSize: 13,
            fontWeight: 600,
            fontFamily: "var(--font-mono)",
            letterSpacing: "0.04em",
            textTransform: "uppercase",
            color: "var(--muted)",
            margin: 0,
          }}
        >
          Proposed changes
        </h2>
        {pill && (
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              padding: "3px 9px",
              borderRadius: 99,
              background: "var(--accent-ring)",
              color: "var(--accent)",
            }}
          >
            {pill}
          </span>
        )}
      </div>

      {error && (
        <div style={{ marginBottom: 12, fontSize: 12.5, color: "var(--danger-ink)" }}>{error}</div>
      )}

      {open.length === 0 && (
        <p style={{ fontSize: 13, color: "var(--faint)", margin: "0 0 8px" }}>
          No open proposals.
        </p>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {open.map((rev) => {
          const d = byId.get(rev.id)!;
          return (
            <RevisionCard
              key={rev.id}
              data={d}
              isAdmin={isAdmin}
              isMirrored={isMirrored}
              expanded={expandedId === rev.id}
              onToggle={() => setExpandedId((x) => (x === rev.id ? null : rev.id))}
              onDecide={decide}
              busy={busyId === rev.id}
            />
          );
        })}
      </div>

      {decidedCount > 0 && (
        <div style={{ marginTop: 16 }}>
          <button
            type="button"
            onClick={() => setShowDecided((v) => !v)}
            style={{
              border: "none",
              background: "transparent",
              padding: 0,
              cursor: "pointer",
              fontSize: 12,
              color: "var(--muted)",
              fontFamily: "var(--font-mono)",
            }}
          >
            {showDecided ? "▾" : "▸"} {decidedCount} decided
          </button>
          {showDecided && (
            <div
              style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 12, opacity: 0.65 }}
            >
              {decided.map((rev) => (
                <RevisionCard
                  key={rev.id}
                  data={byId.get(rev.id)!}
                  isAdmin={isAdmin}
                  isMirrored={isMirrored}
                  expanded={expandedId === rev.id}
                  onToggle={() => setExpandedId((x) => (x === rev.id ? null : rev.id))}
                  onDecide={decide}
                  busy={false}
                  decided
                />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function RevisionCard({
  data,
  isAdmin,
  isMirrored,
  expanded,
  onToggle,
  onDecide,
  busy,
  decided = false,
}: {
  data: RevisionViewData;
  isAdmin: boolean;
  isMirrored: boolean;
  expanded: boolean;
  onToggle: () => void;
  onDecide: (id: number, accept: boolean) => void;
  busy: boolean;
  decided?: boolean;
}) {
  const { rev, diff, staleBase, diffVsCurrent } = data;
  const chip = revisionAuthorChip(rev);
  const shareBadge = shareBadgeLabel(rev.proposerLabel);
  const acceptUnavailable = acceptUnavailableReason(isMirrored);
  return (
    <div
      style={{
        border: "1px solid var(--hairline)",
        borderRadius: 10,
        padding: "12px 14px",
        background: "var(--surface)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10.5,
            padding: "3px 8px",
            borderRadius: 99,
            background: "var(--badge-team-bg)",
            color: "var(--badge-team-ink)",
            whiteSpace: "nowrap",
          }}
        >
          {chip.label}
        </span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--faint)" }}>
          {revisionStamp(rev.createdAt)}
        </span>
        {/* Share-suggestion provenance — the owner sees a suggestion arrived via
            a capability link (label is plain text; React escapes). */}
        {shareBadge && (
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              padding: "2px 7px",
              borderRadius: 99,
              background: "var(--badge-external-bg)",
              color: "var(--badge-external-ink)",
              whiteSpace: "nowrap",
            }}
            title="This suggestion arrived through a share link"
          >
            via share {shareBadge}
          </span>
        )}
        {decided && (
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--faint)" }}>
            {statusLabel(rev.status)}
          </span>
        )}
        {!decided && staleBase && (
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              padding: "2px 7px",
              borderRadius: 99,
              background: "var(--warn-bg)",
              color: "var(--warn-ink)",
              border: "1px solid var(--warn-border)",
            }}
            title="The doc moved past this revision's base version"
          >
            base stale
          </span>
        )}
        <button
          type="button"
          onClick={onToggle}
          style={{
            marginLeft: "auto",
            border: "none",
            background: "transparent",
            padding: 0,
            cursor: "pointer",
            fontSize: 11.5,
            fontFamily: "var(--font-mono)",
            color: "var(--accent)",
          }}
        >
          {expanded ? "Hide diff" : "View diff"}
        </button>
      </div>

      {/* Note is plain text (React escapes). */}
      {rev.note && (
        <div style={{ fontSize: 13, color: "var(--ink)", marginTop: 8 }}>{rev.note}</div>
      )}

      {expanded && (
        <div style={{ marginTop: 12 }}>
          {staleBase && (
            <div
              style={{
                border: "1px solid var(--warn-border)",
                background: "var(--warn-bg)",
                borderRadius: 8,
                padding: "8px 12px",
                marginBottom: 10,
                fontSize: 12,
                color: "var(--warn-ink)",
              }}
            >
              The doc has been published again since this proposal. Accepting will
              overwrite the current version with the proposed content — the diff
              against the current version is shown below the base diff.
            </div>
          )}
          <DiffBlock title="diff vs base" lines={diff} />
          {staleBase && diffVsCurrent && (
            <div style={{ marginTop: 12 }}>
              <DiffBlock title="diff vs current" lines={diffVsCurrent} />
            </div>
          )}
        </div>
      )}

      {isAdmin && !decided && (
        <div style={{ marginTop: 12 }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            {acceptUnavailable ? (
              <span
                title={acceptUnavailable}
                style={{
                  fontSize: 12,
                  fontWeight: 500,
                  padding: "5px 13px",
                  borderRadius: 7,
                  border: "1px solid var(--hairline)",
                  background: "var(--surface-alt)",
                  color: "var(--faint)",
                }}
              >
                Accept unavailable
              </span>
            ) : (
              <button
                type="button"
                onClick={() => onDecide(rev.id, true)}
                disabled={busy}
                style={{
                  fontSize: 12,
                  fontWeight: 500,
                  padding: "5px 13px",
                  borderRadius: 7,
                  border: "1px solid var(--accent)",
                  background: "var(--accent)",
                  color: "var(--bg)",
                  cursor: busy ? "default" : "pointer",
                  opacity: busy ? 0.6 : 1,
                  fontFamily: "var(--font-sans)",
                }}
              >
                {busy ? "Working…" : "Accept"}
              </button>
            )}
            <button
              type="button"
              onClick={() => onDecide(rev.id, false)}
              disabled={busy}
              style={{
                fontSize: 12,
                fontWeight: 500,
                padding: "5px 13px",
                borderRadius: 7,
                border: "1px solid var(--hairline)",
                background: "var(--surface)",
                color: "var(--danger-ink)",
                cursor: busy ? "default" : "pointer",
                opacity: busy ? 0.6 : 1,
                fontFamily: "var(--font-sans)",
              }}
            >
              Reject
            </button>
          </div>
          {acceptUnavailable && (
            <p style={{ margin: "8px 0 0", fontSize: 11.5, color: "var(--faint)" }}>
              {acceptUnavailable}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

const diffColors = {
  ctx: { bg: "transparent", fg: "var(--muted)" },
  add: { bg: "var(--diff-add-bg)", fg: "var(--diff-add-fg)" },
  del: { bg: "var(--diff-del-bg)", fg: "var(--diff-del-fg)" },
} as const;

function DiffBlock({ title, lines }: { title: string; lines: DiffLine[] }) {
  return (
    <div style={{ border: "1px solid var(--hairline)", borderRadius: 10, overflow: "hidden" }}>
      <div
        style={{
          padding: "8px 14px",
          borderBottom: "1px solid var(--hairline)",
          background: "var(--surface-alt)",
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          color: "var(--muted)",
        }}
      >
        {title}
      </div>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: 1.7, padding: "10px 0" }}>
        {lines.map((line, i) => {
          const c = diffColors[line.type];
          const sign = line.type === "add" ? "+" : line.type === "del" ? "-" : " ";
          return (
            <div
              key={i}
              style={{ padding: "1px 16px", background: c.bg, color: c.fg, whiteSpace: "pre-wrap" }}
            >
              {sign} {line.text}
            </div>
          );
        })}
      </div>
    </div>
  );
}
