"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import AudienceBadge from "@/components/AudienceBadge";
import PathPicker from "@/components/PathPicker";
import FolderShareModal from "./FolderShareModal";
import { isValidPath, normalizePath } from "@/lib/path";
import {
  buildDocTree,
  flattenSearch,
  moveCtaLabel,
  splitSnippet,
  type TreeRow,
  type TreeDocRow,
} from "./tree-model";

/**
 * Serializable doc row the tree renders. Built in the (server) page from the
 * DocListItem + derived display fields, so this island never touches the DB and
 * dates arrive as pre-formatted YYYY-MM-DD strings.
 */
export type DocRowData = {
  slug: string;
  path: string;
  title: string;
  audience: string;
  format: "md" | "html";
  versionCount: number;
  updated: string; // YYYY-MM-DD
  unresolvedComments: number;
  unpublished: boolean;
  snippet?: string;
  /** Cross-mock convenience: where a row click goes (defaults to /docs/<slug>). */
  href: string;
};

const COLLAPSE_KEY = "desk-docs-collapsed";

const formatLabel: Record<"md" | "html", string> = {
  md: "markdown",
  html: "html artifact",
};

/** Search-snippet line — escaped runs + <mark> highlights (mirrors the page's SnippetLine). */
function SnippetLine({ snippet }: { snippet: string }) {
  const runs = splitSnippet(snippet);
  if (runs.length === 0) return null;
  return (
    <div
      style={{
        fontSize: 12,
        lineHeight: 1.5,
        color: "var(--muted)",
        marginTop: 5,
        display: "-webkit-box",
        WebkitLineClamp: 2,
        WebkitBoxOrient: "vertical",
        overflow: "hidden",
      }}
    >
      {runs.map((r, i) =>
        r.match ? (
          <mark
            key={i}
            style={{ background: "var(--accent-ring)", color: "var(--ink)", borderRadius: 3, padding: "0 2px" }}
          >
            {r.text}
          </mark>
        ) : (
          <span key={i}>{r.text}</span>
        ),
      )}
    </div>
  );
}

function DocRow({
  row,
  isAdmin,
  onMove,
}: {
  row: TreeDocRow<DocRowData>;
  isAdmin: boolean;
  onMove: (doc: DocRowData) => void;
}) {
  const doc = row.doc;
  return (
    <div style={{ position: "relative", marginLeft: row.depth * 22 }}>
      <Link
        href={doc.href}
        style={{
          textDecoration: "none",
          border: "1px solid var(--hairline)",
          borderRadius: 10,
          background: "var(--surface)",
          padding: "12px 16px",
          display: "flex",
          alignItems: "center",
          gap: 14,
          color: "var(--ink)",
          opacity: doc.unpublished ? 0.55 : 1,
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
            <span
              style={{
                fontSize: 14,
                fontWeight: 600,
                letterSpacing: "-0.005em",
                textDecoration: doc.unpublished ? "line-through" : "none",
              }}
            >
              {doc.title}
            </span>
            {doc.unpublished && (
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 10,
                  padding: "2px 6px",
                  borderRadius: 4,
                  background: "var(--warn-bg)",
                  color: "var(--warn-ink)",
                  border: "1px solid var(--warn-border)",
                }}
              >
                unpublished
              </span>
            )}
            {doc.unresolvedComments > 0 && (
              <span
                title={`${doc.unresolvedComments} unresolved comment${doc.unresolvedComments === 1 ? "" : "s"}`}
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 10,
                  padding: "2px 6px",
                  borderRadius: 4,
                  background: "var(--warn-bg)",
                  color: "var(--warn-ink)",
                  border: "1px solid var(--warn-border)",
                }}
              >
                {doc.unresolvedComments} unresolved
              </span>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12, color: "var(--muted)" }}>
            {row.showPath && (
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ref-ink, var(--accent))" }}>
                {row.pathContext}
              </span>
            )}
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--faint)" }}>{doc.slug}</span>
            <span>{formatLabel[doc.format]}</span>
          </div>
          {doc.snippet ? <SnippetLine snippet={doc.snippet} /> : null}
        </div>
        <AudienceBadge audience={doc.audience} />
        <div style={{ textAlign: "right", flex: "none", width: 92 }}>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--muted)" }}>{doc.updated}</div>
          <div style={{ fontSize: 11, color: "var(--faint)" }}>
            {doc.versionCount} {doc.versionCount === 1 ? "version" : "versions"}
          </div>
        </div>
        {isAdmin && <span style={{ flex: "none", width: 56 }} />}
      </Link>
      {isAdmin && (
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onMove(doc);
          }}
          style={{
            position: "absolute",
            right: 12,
            top: "50%",
            transform: "translateY(-50%)",
            fontSize: 11.5,
            fontWeight: 500,
            padding: "4px 10px",
            borderRadius: 6,
            border: "1px solid var(--hairline)",
            background: "var(--surface)",
            color: "var(--muted)",
            cursor: "pointer",
            fontFamily: "var(--font-sans)",
          }}
        >
          Move…
        </button>
      )}
    </div>
  );
}

export default function DocsTree({
  docs,
  query,
  isAdmin,
  allFolders,
}: {
  docs: DocRowData[];
  query: string;
  isAdmin: boolean;
  /** Folders derived from ALL docs (admin) — the Move picker can target any of them. */
  allFolders: string[];
}) {
  const router = useRouter();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [hydrated, setHydrated] = useState(false);

  // Restore collapse state from localStorage after mount (avoids SSR mismatch).
  useEffect(() => {
    try {
      const raw = localStorage.getItem(COLLAPSE_KEY);
      if (raw) setCollapsed(JSON.parse(raw) as Record<string, boolean>);
    } catch {
      // ignore malformed/blocked storage
    }
    setHydrated(true);
  }, []);

  function toggle(path: string) {
    setCollapsed((prev) => {
      const next = { ...prev, [path]: !prev[path] };
      try {
        localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next));
      } catch {
        // ignore
      }
      return next;
    });
  }

  const searching = query.trim().length > 0;
  // In search mode the server already FTS-filtered the list — keep every row and
  // just add the matched-path context (prefiltered). In tree mode, collapse only
  // takes effect once hydrated so SSR renders the fully-open tree.
  const rows: TreeRow<DocRowData>[] = searching
    ? flattenSearch(docs, query, { prefiltered: true })
    : buildDocTree(docs, hydrated ? collapsed : {});

  // ── Folder-share dialog (admin) ─────────────────────────────────────────────
  const [shareFolder, setShareFolder] = useState<string | null>(null);

  // ── Move dialog ─────────────────────────────────────────────────────────────
  const [moveDoc, setMoveDoc] = useState<DocRowData | null>(null);
  const [movePath, setMovePath] = useState("");
  const [moving, setMoving] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);

  function openMove(doc: DocRowData) {
    setMoveDoc(doc);
    setMovePath(doc.path);
    setMoveError(null);
  }
  function closeMove() {
    setMoveDoc(null);
    setMoving(false);
    setMoveError(null);
  }

  async function confirmMove() {
    if (!moveDoc) return;
    const trimmed = movePath.trim();
    if (trimmed !== "" && !isValidPath(trimmed)) {
      setMoveError("Invalid folder — lowercase letters, digits, dashes; “/” for sub-folders (max 6 deep).");
      return;
    }
    const dest = normalizePath(trimmed) ?? "";
    setMoving(true);
    setMoveError(null);
    try {
      const res = await fetch(`/api/docs/${moveDoc.slug}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: dest }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setMoveError(data?.error ?? `Move failed (${res.status})`);
        setMoving(false);
        return;
      }
      closeMove();
      router.refresh();
    } catch {
      setMoveError("Network error — doc not moved.");
      setMoving(false);
    }
  }

  const cta = moveCtaLabel(movePath, allFolders);

  return (
    <>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {rows.map((row) =>
          row.kind === "folder" ? (
            <div
              key={`f:${row.path}`}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginLeft: row.depth * 22,
              }}
            >
              <button
                type="button"
                onClick={() => toggle(row.path)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  textAlign: "left",
                  border: "none",
                  background: "none",
                  padding: "7px 10px 4px",
                  cursor: "pointer",
                  fontFamily: "var(--font-sans)",
                  borderRadius: 7,
                  color: "var(--ink)",
                  flex: 1,
                  minWidth: 0,
                }}
              >
                <span
                  aria-hidden
                  style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--faint)", width: 10, display: "inline-block" }}
                >
                  {row.collapsed ? "▸" : "▾"}
                </span>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 600, color: "var(--muted)" }}>
                  {row.name}/
                </span>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--faint)" }}>
                  {row.count} {row.count === 1 ? "doc" : "docs"}
                </span>
              </button>
              {isAdmin && (
                <button
                  type="button"
                  onClick={() => setShareFolder(row.path)}
                  title={`Share the ${row.path}/ folder as one link`}
                  style={{
                    flex: "none",
                    fontSize: 11,
                    fontWeight: 500,
                    padding: "3px 10px",
                    borderRadius: 6,
                    border: "1px solid var(--hairline)",
                    background: "var(--surface)",
                    color: "var(--muted)",
                    cursor: "pointer",
                    fontFamily: "var(--font-sans)",
                  }}
                >
                  Share folder…
                </button>
              )}
            </div>
          ) : (
            <DocRow key={`d:${row.doc.slug}`} row={row} isAdmin={isAdmin} onMove={openMove} />
          ),
        )}
      </div>

      {shareFolder !== null && (
        <FolderShareModal
          pathPrefix={shareFolder}
          onClose={() => {
            setShareFolder(null);
            router.refresh();
          }}
        />
      )}

      {moveDoc && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Move ${moveDoc.title}`}
          onClick={closeMove}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.42)",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "center",
            zIndex: 60,
            padding: "90px 20px 20px",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "100%",
              maxWidth: 460,
              background: "var(--surface)",
              border: "1px solid var(--hairline)",
              borderRadius: 14,
              padding: "22px 24px",
              color: "var(--ink)",
            }}
          >
            <h2 style={{ fontSize: 16, fontWeight: 600, margin: "0 0 4px" }}>Move “{moveDoc.title}”</h2>
            <p style={{ fontSize: 12.5, color: "var(--muted)", margin: "0 0 16px" }}>
              Currently in{" "}
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--ref-ink, var(--accent))" }}>
                {moveDoc.path ? moveDoc.path + "/" : "(root)"}
              </span>
              . Folders are implicit — moving the last doc out of a folder removes the folder.
            </p>

            <label
              style={{
                display: "block",
                fontFamily: "var(--font-mono)",
                fontSize: 10,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                color: "var(--faint)",
                marginBottom: 6,
              }}
            >
              destination folder
            </label>
            <PathPicker
              value={movePath}
              onChange={setMovePath}
              existingFolders={allFolders}
              onEnter={confirmMove}
              onEscape={closeMove}
              autoFocus
              invalid={movePath.trim() !== "" && !isValidPath(movePath.trim())}
            />

            {moveError && <p style={{ margin: "10px 0 0", fontSize: 12, color: "var(--danger-ink)" }}>{moveError}</p>}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
              <button
                type="button"
                onClick={closeMove}
                style={{
                  fontSize: 13,
                  fontWeight: 500,
                  padding: "7px 14px",
                  borderRadius: 8,
                  border: "1px solid var(--hairline)",
                  background: "var(--surface)",
                  color: "var(--muted)",
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmMove}
                disabled={moving}
                style={{
                  fontSize: 13,
                  fontWeight: 500,
                  padding: "7px 14px",
                  borderRadius: 8,
                  border: "none",
                  background: "var(--accent)",
                  color: "#fff",
                  cursor: moving ? "default" : "pointer",
                  opacity: moving ? 0.7 : 1,
                }}
              >
                {moving ? "Moving…" : cta}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
