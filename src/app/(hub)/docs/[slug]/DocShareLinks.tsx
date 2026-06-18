import { listSharesForDoc } from "@/lib/shares";
import type { ShareVersionOption } from "@/components/ShareModal";
import { toDocShareRow, gridTemplate } from "./shares-view-model";
import DocShareLinkRow from "./DocShareLinkRow";
import NewShareLinkButton from "./NewShareLinkButton";

/**
 * Per-doc "Share links" panel.
 *
 * Round-2 design: BOTH roles see the table. Admins get the "New share link"
 * button + per-row revoke / comments toggle; members get a read-only view (same
 * columns incl. mode + views) with a one-line explanation and no create button.
 * The payload carries no token-ish data (only the hash is stored, never
 * selected), so the member read leaks nothing.
 *
 * Server-rendered: lists every share for THIS doc via listSharesForDoc(slug),
 * projects each through the pure view-model (with `versionLabelById` so a pinned
 * link's chip reads "pinned vN"), and hands rows to the DocShareLinkRow island.
 */
export default async function DocShareLinks({
  slug,
  isAdmin,
  versions,
  versionLabelById = {},
  embedded = false,
}: {
  slug: string;
  isAdmin: boolean;
  versions?: ShareVersionOption[];
  /** Version id → "vN" map (from the doc's rail) for the pinned mode chip. */
  versionLabelById?: Record<number, string>;
  /**
   * When true this renders inside the consolidated Sharing panel (no outer
   * section/top-margin — the panel owns the "Sharing" header). Standalone
   * (false) keeps the original spacing for any caller that still mounts it
   * directly.
   */
  embedded?: boolean;
}) {
  const shares = await listSharesForDoc(slug);
  const now = new Date();
  const rows = shares.map((s) => toDocShareRow(s, now, versionLabelById));

  return (
    <section style={embedded ? { margin: 0 } : { marginTop: 36, marginBottom: 8 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 6,
        }}
      >
        <h2
          style={{
            fontSize: 13,
            fontWeight: 600,
            letterSpacing: "-0.01em",
            margin: 0,
          }}
        >
          Share links{" "}
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--faint)", fontWeight: 400 }}>
            ({rows.length})
          </span>
        </h2>
        {isAdmin && <NewShareLinkButton slug={slug} versions={versions} />}
      </div>

      <p style={{ margin: "0 0 12px", fontSize: 12.5, color: "var(--muted)" }}>
        Each link is a revocable capability scoped to this doc.{" "}
        {isAdmin
          ? "Pinned links keep showing the exact version you verified."
          : "Creating and revoking links is admin-only — you can see what’s out there."}
      </p>

      {rows.length === 0 ? (
        <div
          style={{
            border: "1px solid var(--hairline)",
            borderRadius: 10,
            padding: "20px 16px",
            textAlign: "center",
            color: "var(--muted)",
            fontSize: 13,
          }}
        >
          {isAdmin
            ? "No share links yet — create one to share this doc externally."
            : "No links have been created for this doc."}
        </div>
      ) : (
        <div
          style={{
            border: "1px solid var(--hairline)",
            borderRadius: 10,
            overflow: "hidden",
          }}
        >
          {/* column header */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: gridTemplate(isAdmin),
              padding: "8px 14px",
              borderBottom: "1px solid var(--hairline)",
              background: "var(--surface-alt)",
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              color: "var(--faint)",
            }}
          >
            <span>label</span>
            <span>shows</span>
            <span>created</span>
            <span>expires</span>
            <span>last view</span>
            <span style={{ justifySelf: "end" }}>views</span>
            <span>status</span>
            {isAdmin && <span style={{ justifySelf: "end" }}>copy</span>}
            {isAdmin && <span style={{ justifySelf: "end" }} />}
          </div>
          {rows.map((row) => (
            <DocShareLinkRow key={row.id} row={row} isAdmin={isAdmin} />
          ))}
        </div>
      )}
    </section>
  );
}
