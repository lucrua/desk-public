"use client";

import { useState } from "react";
import Link from "next/link";
import { buildDocTree, type TreeRow } from "../../docs/tree-model";

/**
 * The minimal doc shape the space tree renders. Mirrors `SpaceDocItem` from
 * `@/lib/spaces` (slug/title/path/format/unpublished), but declared locally so
 * this client island never imports the DB layer.
 */
export type SpaceTreeDoc = {
  slug: string;
  title: string;
  path: string;
  format: "md" | "html";
  unpublished: boolean;
};

/**
 * Collapsible folder tree for a space's docs (Gen-2 consolidation, Slice 2 —
 * replaces the flat `path/slug` list). Folders nest by the doc `path` field
 * (slash-joined segments, depth ≤6); leaves link to `/docs/[slug]`. A doc with
 * an empty `path` sits at the space root, rendered last.
 *
 * Pure-presentational over `buildDocTree` (the same view-model the old `/docs`
 * tree used): the server passes the flat doc list, this island owns only the
 * per-folder collapse state. Accessible: folder toggles are real <button>s with
 * aria-expanded; the tree is a <ul role="tree"> with role="treeitem" rows.
 */
export default function SpaceDocsTree({ docs }: { docs: SpaceTreeDoc[] }) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const rows = buildDocTree(docs, collapsed);

  const toggle = (path: string) =>
    setCollapsed((c) => ({ ...c, [path]: !c[path] }));

  return (
    <ul
      role="tree"
      aria-label="Docs in this space"
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
        <TreeRowView
          key={rowKey(row)}
          row={row}
          first={i === 0}
          onToggle={toggle}
        />
      ))}
    </ul>
  );
}

function rowKey<T extends { path: string; slug: string }>(row: TreeRow<T>): string {
  return row.kind === "folder" ? `F:${row.path}` : `D:${row.doc.slug}`;
}

const INDENT = 16; // px per depth level

function TreeRowView({
  row,
  first,
  onToggle,
}: {
  row: TreeRow<SpaceTreeDoc>;
  first: boolean;
  onToggle: (path: string) => void;
}) {
  const padLeft = 14 + row.depth * INDENT;
  const borderTop = first ? "none" : "1px solid var(--hairline)";

  if (row.kind === "folder") {
    return (
      <li role="treeitem" aria-expanded={!row.collapsed}>
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

  const d = row.doc;
  return (
    <li role="treeitem">
      <Link
        href={`/docs/${d.slug}`}
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
          ▢
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ fontSize: 13.5, fontWeight: 500 }}>{d.title}</span>
          <span
            style={{
              display: "block",
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: "var(--faint)",
              marginTop: 2,
            }}
          >
            {d.slug} · {d.format}
            {d.unpublished ? " · unpublished" : ""}
          </span>
        </span>
        <span style={{ color: "var(--faint)", fontSize: 13 }}>→</span>
      </Link>
    </li>
  );
}
