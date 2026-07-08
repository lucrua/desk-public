"use client";

import { useState } from "react";
import Link from "next/link";
import {
  buildFileTree,
  type FileEntry,
  type FileTreeRow,
} from "../../../docs/tree-model";

export type { FileEntry };

/**
 * Unified collapsible file explorer for a space's Content tab (UI polish S3 —
 * replaces `SpaceDocsTree` + `SpaceFilesView` on the space page). ONE tree of
 * the flat committed-file list, **folders COLLAPSED by default** so a big space
 * opens tidy. A doc-type leaf (`isDoc` + a projected `docSlug`) links to its
 * rendered page (`/docs/<slug>`); any other leaf links to the raw route
 * (`/api/spaces/<slug>/raw/<path>`).
 *
 * ⚠ ACCESS BOUNDARY: this island renders only what it is HANDED. The page feeds
 * it the full file list (incl. NON-doc raw files) ONLY to the gated audience
 * (`canWebAuthor || isAdmin || myMembership`); a viewer outside that gate is
 * handed a docs-only list, so no raw non-doc file is ever surfaced to a wider
 * audience than before this refactor. The gating decision lives in `page.tsx`.
 *
 * Pure-presentational over `buildFileTree`: the server passes the flat list,
 * this island owns only the per-folder expand state. Accessible: folder toggles
 * are real <button>s with aria-expanded; the tree is a <ul role="tree"> of
 * role="treeitem" rows.
 */
export default function SpaceFileExplorer({
  slug,
  files,
}: {
  slug: string;
  files: FileEntry[];
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const rows = buildFileTree(files, expanded);

  const toggle = (path: string) =>
    setExpanded((e) => ({ ...e, [path]: !e[path] }));

  if (files.length === 0) {
    return (
      <p style={{ fontSize: 13, color: "var(--faint)", margin: 0 }}>
        No files yet. Create a doc or upload a file, or push to this space.
      </p>
    );
  }

  return (
    <ul
      role="tree"
      aria-label="Files in this space"
      style={{
        listStyle: "none",
        margin: 0,
        padding: 0,
        border: "1px solid var(--hairline)",
        borderRadius: 10,
        overflow: "hidden",
        background: "var(--surface)",
      }}
    >
      {rows.map((row, i) => (
        <FileTreeRowView
          key={rowKey(row)}
          row={row}
          slug={slug}
          first={i === 0}
          onToggle={toggle}
        />
      ))}
    </ul>
  );
}

function rowKey(row: FileTreeRow): string {
  return row.kind === "folder" ? `F:${row.path}` : `L:${row.entry.path}`;
}

const INDENT = 16; // px per depth level

function FileTreeRowView({
  row,
  slug,
  first,
  onToggle,
}: {
  row: FileTreeRow;
  slug: string;
  first: boolean;
  onToggle: (path: string) => void;
}) {
  const padLeft = 14 + row.depth * INDENT;
  const borderTop = first ? "none" : "1px solid var(--hairline)";

  if (row.kind === "folder") {
    return (
      <li role="treeitem" aria-selected={false} aria-expanded={!row.collapsed}>
        <button
          type="button"
          onClick={() => onToggle(row.path)}
          aria-label={`${row.collapsed ? "Expand" : "Collapse"} folder ${row.name}`}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            width: "100%",
            border: "none",
            borderTop,
            background: "var(--surface-alt)",
            padding: "9px 14px",
            paddingLeft: padLeft,
            cursor: "pointer",
            textAlign: "left",
            font: "inherit",
            color: "var(--ink)",
          }}
        >
          <span
            aria-hidden="true"
            style={{
              display: "inline-block",
              width: 10,
              fontSize: 10,
              color: "var(--faint)",
              transform: row.collapsed ? "rotate(0deg)" : "rotate(90deg)",
              transition: "transform 80ms",
            }}
          >
            ▶
          </span>
          <span style={{ fontSize: 13.5, fontWeight: 600, fontFamily: "var(--font-mono)" }}>
            {row.name}/
          </span>
          <span
            style={{
              marginLeft: "auto",
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: "var(--faint)",
            }}
          >
            {row.count}
          </span>
        </button>
      </li>
    );
  }

  const f = row.entry;
  const href =
    f.isDoc && f.docSlug
      ? `/docs/${f.docSlug}`
      : `/api/spaces/${slug}/raw/${f.path}`;
  return (
    <li role="treeitem" aria-selected={false}>
      <Link
        href={href}
        prefetch={false}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "10px 14px",
          paddingLeft: padLeft + 18, // align under a folder's label (past the caret)
          borderTop,
          textDecoration: "none",
          color: "var(--ink)",
          background: "var(--surface)",
        }}
      >
        <span aria-hidden="true" style={{ color: "var(--faint)", fontSize: 12 }}>
          {f.isDoc ? "▢" : "⬓"}
        </span>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontFamily: "var(--font-mono)",
            fontSize: 12.5,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {row.name}
        </span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            color: "var(--faint)",
            textTransform: "uppercase",
          }}
        >
          {f.isDoc ? "doc" : "raw"}
        </span>
      </Link>
    </li>
  );
}
