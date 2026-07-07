"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  groupRows,
  sortRows,
  filterRows,
  distinctValues,
  displayValue,
  type CatalogProjection,
  type CatalogRow,
  type SortDir,
} from "@/lib/catalog/projection";

const mono = "var(--font-mono)";

const label10 = {
  fontFamily: mono,
  fontSize: 10,
  letterSpacing: "0.08em",
  textTransform: "uppercase" as const,
  color: "var(--faint)",
} as const;

export type SpaceOption = { slug: string; visibility: string };
export type DirOption = { path: string; count: number };

/** A serializable description of the schema (or null for auto mode) the client
 * needs: declared field order + per-enum-field value order for grouping, and the
 * declared views + default view. */
export type SchemaDTO = {
  fields: Array<{ key: string; type: string; values: string[]; required: boolean; label: string | null }>;
  views: Array<
    | { type: "board"; groupBy: string | null; label: string | null }
    | { type: "table"; columns: string[] | null; label: string | null }
    | { type: "list"; label: string | null }
  >;
  defaultView: "board" | "table" | "list";
  notes: string[];
  rawPath: string;
} | null;

type Props = {
  spaces: SpaceOption[];
  dirs: DirOption[];
  space: string | null;
  dir: string;
  projection: CatalogProjection;
  schema: SchemaDTO;
};

type ViewKind = "table" | "board" | "list";

/**
 * The catalog-as-projection island (D6). Renders the docs of a chosen space +
 * directory from their frontmatter. View/group/sort/filter are Desk-side DISPLAY
 * STATE only — never written to files. The space/dir pickers are <Link>s that set
 * the ?space=&dir= search params (the server re-projects). The view controls live
 * here in client state.
 *
 * AUTO mode (no `.desk.collection.yml`): the union of frontmatter fields as a
 * table, group/filter/sort by any field, plus board + list views.
 * SCHEMA mode: the declared field order + views; each doc validated against the
 * schema with DRIFT flagged visibly (never hidden).
 */
export default function CatalogProjectionClient({
  spaces,
  dirs,
  space,
  dir,
  projection,
  schema,
}: Props) {
  const allowedViews: ViewKind[] = schema
    ? schema.views.map((v) => v.type)
    : ["table", "board", "list"];
  const initialView: ViewKind = schema ? schema.defaultView : "table";
  const [view, setView] = useState<ViewKind>(initialView);

  // group/sort/filter state (display-only)
  const defaultGroupBy = schema
    ? (schema.views.find((v) => v.type === "board") as { groupBy: string | null } | undefined)?.groupBy ?? projection.fields[0] ?? null
    : projection.fields[0] ?? null;
  const [groupBy, setGroupBy] = useState<string | null>(defaultGroupBy);
  const [sortField, setSortField] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [filterField, setFilterField] = useState<string>("");
  const [filterValue, setFilterValue] = useState<string>("");

  // The enum order for a field (schema mode) so board columns follow the declared order.
  const enumOrderFor = (field: string | null): string[] | undefined => {
    if (!schema || !field) return undefined;
    const f = schema.fields.find((x) => x.key === field);
    return f && f.values.length > 0 ? f.values : undefined;
  };

  // The table columns: schema table view columns, else all projected fields.
  const tableColumns = useMemo<string[]>(() => {
    if (schema) {
      const tv = schema.views.find((v) => v.type === "table") as { columns: string[] | null } | undefined;
      if (tv?.columns && tv.columns.length > 0) return tv.columns;
    }
    return projection.fields;
  }, [schema, projection.fields]);

  const visibleRows = useMemo<CatalogRow[]>(() => {
    let rows = projection.rows;
    if (filterField && filterValue) rows = filterRows(rows, filterField, filterValue);
    if (sortField) rows = sortRows(rows, sortField, sortDir);
    return rows;
  }, [projection.rows, filterField, filterValue, sortField, sortDir]);

  // Directory picker: a tree (top-level first, expand for nested) built once
  // from the flat ancestor-prefix list `source.ts` returns. See buildDirTree.
  const dirTree = useMemo(() => buildDirTree(dirs), [dirs]);

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: "28px 20px 80px" }}>
      <header style={{ marginBottom: 18 }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, fontFamily: mono, margin: "0 0 4px" }}>Catalog</h1>
        <p style={{ margin: "0 0 10px", fontSize: 13, color: "var(--muted)" }}>
          A projection of a space directory&rsquo;s frontmatter. Pick a space and
          directory; Desk renders each doc&rsquo;s metadata.{" "}
          {schema ? (
            <span>
              Schema mode — validated against{" "}
              <code style={{ fontFamily: mono, fontSize: 12 }}>{schema.rawPath}</code>.
            </span>
          ) : (
            <span>Auto mode — no <code style={{ fontFamily: mono, fontSize: 12 }}>.desk.collection.yml</code> in this directory.</span>
          )}
        </p>
        <CatalogHelp />
      </header>

      {/* Space + directory pickers (set search params; server re-projects). */}
      <div style={{ display: "flex", gap: 24, flexWrap: "wrap", marginBottom: 18 }}>
        <Picker label="space">
          {spaces.length === 0 ? (
            <span style={{ fontSize: 13, color: "var(--faint)" }}>No spaces visible.</span>
          ) : (
            spaces.map((s) => (
              <PickLink key={s.slug} href={`/catalog?space=${encodeURIComponent(s.slug)}`} active={s.slug === space}>
                {s.slug}
              </PickLink>
            ))
          )}
        </Picker>
        {space && (
          <div>
            <div style={{ ...label10, marginBottom: 6 }}>directory</div>
            <DirectoryTree root={dirTree} space={space} dir={dir} />
          </div>
        )}
      </div>

      {/* Drift banner (schema mode). */}
      {schema && projection.driftCount > 0 && (
        <div
          role="status"
          style={{
            marginBottom: 16,
            padding: "10px 14px",
            borderRadius: 8,
            border: "1px solid var(--danger-ink)",
            background: "var(--danger-bg)",
            color: "var(--danger-ink)",
            fontSize: 13,
          }}
        >
          ⚠ {projection.driftCount} schema-drift {projection.driftCount === 1 ? "issue" : "issues"} across{" "}
          {projection.rows.filter((r) => r.drift.length > 0).length} doc(s) — invalid docs are still shown, flagged below.
        </div>
      )}
      {schema && schema.notes.length > 0 && (
        <p style={{ fontSize: 12, color: "var(--warn-ink)", marginBottom: 12 }}>
          Schema notes: {schema.notes.join("; ")}.
        </p>
      )}

      {!space ? (
        <Empty>Pick a space to project its frontmatter as a catalog.</Empty>
      ) : projection.rows.length === 0 ? (
        <Empty>No published docs in this directory yet.</Empty>
      ) : (
        <>
          {/* View switcher + controls */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 14,
              flexWrap: "wrap",
              marginBottom: 14,
              paddingBottom: 12,
              borderBottom: "1px solid var(--hairline)",
            }}
          >
            <div role="tablist" aria-label="Catalog view" style={{ display: "flex", gap: 4 }}>
              {(["table", "board", "list"] as ViewKind[])
                .filter((v) => allowedViews.includes(v))
                .map((v) => (
                  <button
                    key={v}
                    type="button"
                    role="tab"
                    aria-selected={view === v}
                    onClick={() => setView(v)}
                    style={{
                      border: "1px solid var(--hairline)",
                      background: view === v ? "var(--nav-active)" : "var(--surface)",
                      color: view === v ? "var(--ink)" : "var(--muted)",
                      fontWeight: view === v ? 600 : 400,
                      borderRadius: 6,
                      padding: "5px 12px",
                      fontSize: 12.5,
                      cursor: "pointer",
                      textTransform: "capitalize",
                    }}
                  >
                    {v}
                  </button>
                ))}
            </div>

            {/* group-by (board) */}
            {view === "board" && (
              <Control label="group by">
                <FieldSelect
                  value={groupBy ?? ""}
                  onChange={setGroupBy}
                  fields={projection.fields}
                  allowNone={false}
                />
              </Control>
            )}

            {/* sort (table / list) */}
            {view !== "board" && (
              <Control label="sort">
                <FieldSelect value={sortField ?? ""} onChange={(v) => setSortField(v || null)} fields={projection.fields} allowNone />
                {sortField && (
                  <button
                    type="button"
                    onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
                    aria-label={`Sort ${sortDir === "asc" ? "ascending" : "descending"}`}
                    style={ctrlBtn}
                  >
                    {sortDir === "asc" ? "▲" : "▼"}
                  </button>
                )}
              </Control>
            )}

            {/* filter */}
            <Control label="filter">
              <FieldSelect
                value={filterField}
                onChange={(v) => {
                  setFilterField(v);
                  setFilterValue("");
                }}
                fields={projection.fields}
                allowNone
              />
              {filterField && (
                <select
                  aria-label="Filter value"
                  value={filterValue}
                  onChange={(e) => setFilterValue(e.target.value)}
                  style={selectStyle}
                >
                  <option value="">any</option>
                  {distinctValues(projection.rows, filterField).map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              )}
            </Control>

            <span style={{ marginLeft: "auto", ...label10 }}>
              {visibleRows.length} / {projection.rows.length} docs
            </span>
          </div>

          {view === "table" && <TableView rows={visibleRows} columns={tableColumns} />}
          {view === "list" && <ListView rows={visibleRows} fields={tableColumns} />}
          {view === "board" && (
            <BoardView rows={visibleRows} groupBy={groupBy} groupOrder={enumOrderFor(groupBy)} fields={tableColumns} />
          )}
        </>
      )}
    </div>
  );
}

// ── Views ─────────────────────────────────────────────────────────────────────

function TableView({ rows, columns }: { rows: CatalogRow[]; columns: string[] }) {
  return (
    <div style={{ overflowX: "auto", border: "1px solid var(--hairline)", borderRadius: 10 }}>
      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
        <thead>
          <tr style={{ background: "var(--surface-alt)" }}>
            <Th>doc</Th>
            {columns.map((c) => (
              <Th key={c}>{c}</Th>
            ))}
            <Th>drift</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.slug} style={{ borderTop: "1px solid var(--hairline)" }}>
              <td style={tdStyle}>
                <Link href={`/docs/${r.slug}`} style={{ color: "var(--accent)", textDecoration: "none", fontWeight: 500 }}>
                  {r.title}
                </Link>
                <span style={{ display: "block", fontFamily: mono, fontSize: 11, color: "var(--faint)" }}>{r.slug}</span>
              </td>
              {columns.map((c) => (
                <td key={c} style={tdStyle}>
                  {displayValue(r.values[c]) || <span style={{ color: "var(--faint)" }}>—</span>}
                </td>
              ))}
              <td style={tdStyle}>
                <DriftCell row={r} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ListView({ rows, fields }: { rows: CatalogRow[]; fields: string[] }) {
  return (
    <ul style={{ listStyle: "none", margin: 0, padding: 0, border: "1px solid var(--hairline)", borderRadius: 10, overflow: "hidden" }}>
      {rows.map((r, i) => (
        <li
          key={r.slug}
          style={{ padding: "12px 14px", borderTop: i === 0 ? "none" : "1px solid var(--hairline)", background: "var(--surface)" }}
        >
          <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
            <Link href={`/docs/${r.slug}`} style={{ color: "var(--accent)", textDecoration: "none", fontWeight: 500, fontSize: 14 }}>
              {r.title}
            </Link>
            <span style={{ fontFamily: mono, fontSize: 11, color: "var(--faint)" }}>{r.slug}</span>
            <span style={{ marginLeft: "auto" }}>
              <DriftCell row={r} />
            </span>
          </div>
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 6 }}>
            {fields
              .filter((f) => displayValue(r.values[f]) !== "")
              .map((f) => (
                <span key={f} style={{ fontSize: 12, color: "var(--muted)" }}>
                  <span style={{ ...label10, marginRight: 4 }}>{f}</span>
                  {displayValue(r.values[f])}
                </span>
              ))}
          </div>
        </li>
      ))}
    </ul>
  );
}

function BoardView({
  rows,
  groupBy,
  groupOrder,
  fields,
}: {
  rows: CatalogRow[];
  groupBy: string | null;
  groupOrder: string[] | undefined;
  fields: string[];
}) {
  if (!groupBy) return <Empty>Choose a field to group the board by.</Empty>;
  const groups = groupRows(rows, groupBy, groupOrder);
  return (
    <div style={{ display: "flex", gap: 12, overflowX: "auto", paddingBottom: 6 }}>
      {groups.map((g) => (
        <div
          key={g.key}
          style={{ minWidth: 240, flex: "0 0 240px", border: "1px solid var(--hairline)", borderRadius: 10, background: "var(--surface-alt)" }}
        >
          <div style={{ padding: "9px 12px", borderBottom: "1px solid var(--hairline)", display: "flex", gap: 8, alignItems: "center" }}>
            <span style={{ fontWeight: 600, fontSize: 13 }}>{g.key}</span>
            <span style={{ marginLeft: "auto", fontFamily: mono, fontSize: 11, color: "var(--faint)" }}>{g.rows.length}</span>
          </div>
          <div style={{ padding: 8, display: "flex", flexDirection: "column", gap: 8 }}>
            {g.rows.map((r) => (
              <div key={r.slug} style={{ border: "1px solid var(--hairline)", borderRadius: 8, background: "var(--surface)", padding: "9px 10px" }}>
                <Link href={`/docs/${r.slug}`} style={{ color: "var(--accent)", textDecoration: "none", fontWeight: 500, fontSize: 13 }}>
                  {r.title}
                </Link>
                <div style={{ marginTop: 4 }}>
                  <DriftCell row={r} />
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
                  {fields
                    .filter((f) => f !== groupBy && displayValue(r.values[f]) !== "")
                    .slice(0, 4)
                    .map((f) => (
                      <span key={f} style={{ fontSize: 11, color: "var(--muted)" }}>
                        <span style={{ color: "var(--faint)" }}>{f}:</span> {displayValue(r.values[f])}
                      </span>
                    ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function DriftCell({ row }: { row: CatalogRow }) {
  if (row.drift.length === 0)
    return <span style={{ fontSize: 11, color: "var(--ok-ink)" }} aria-label="valid">✓</span>;
  return (
    <span
      title={row.drift.map((d) => d.message).join("\n")}
      style={{
        display: "inline-block",
        fontSize: 11,
        fontWeight: 600,
        color: "var(--danger-ink)",
        background: "var(--danger-bg)",
        borderRadius: 6,
        padding: "1px 6px",
      }}
    >
      ⚠ {row.drift.length} drift
    </span>
  );
}

// ── Small presentational bits ───────────────────────────────────────────────────

function Picker({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ ...label10, marginBottom: 6 }}>{label}</div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{children}</div>
    </div>
  );
}

function PickLink({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={active ? "true" : undefined}
      style={{
        fontSize: 12.5,
        fontFamily: mono,
        padding: "4px 10px",
        borderRadius: 999,
        textDecoration: "none",
        border: "1px solid var(--hairline)",
        background: active ? "var(--nav-active)" : "var(--surface)",
        color: active ? "var(--ink)" : "var(--muted)",
        fontWeight: active ? 600 : 400,
      }}
    >
      {children}
    </Link>
  );
}

/**
 * Collapsible "what is this" explainer (D5). Answers the two things that
 * confuse a first-time viewer: where columns come from (a doc's frontmatter
 * key — this is what a stray "Audience" column means) and that the directory
 * picker and the field filter are two different controls. Defaults open so
 * the explanation is visible on first load; collapses to a single line once
 * learned.
 */
function CatalogHelp() {
  const [open, setOpen] = useState(true);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls="catalog-help-panel"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          background: "none",
          border: "none",
          padding: 0,
          fontSize: 12,
          fontFamily: mono,
          color: "var(--muted)",
          cursor: "pointer",
        }}
      >
        <span aria-hidden="true">{open ? "▾" : "▸"}</span>
        What is this?
      </button>
      {open && (
        <div
          id="catalog-help-panel"
          style={{
            marginTop: 8,
            padding: "12px 14px",
            border: "1px solid var(--hairline)",
            borderRadius: 8,
            background: "var(--surface-alt)",
            maxWidth: 720,
            fontSize: 12.5,
            lineHeight: 1.55,
            color: "var(--muted)",
          }}
        >
          <p style={{ margin: "0 0 8px" }}>
            A catalog is a <strong>live, read-only render</strong> of a
            directory&rsquo;s doc frontmatter — not a separate database.
            Nothing here is stored by the catalog itself; to change a value,
            edit the file&rsquo;s frontmatter and <code style={inlineCode}>git push</code>{" "}
            — the catalog re-projects automatically.
          </p>
          <p style={{ margin: "0 0 8px" }}>
            <strong>Each column is a field from your docs&rsquo; YAML
            frontmatter.</strong> If you see a column you don&rsquo;t
            recognize — e.g. &ldquo;Audience&rdquo; — it just means a doc in
            this directory has that key in its frontmatter. There&rsquo;s
            nothing to configure; that&rsquo;s the data.
          </p>
          <p style={{ margin: "0 0 8px" }}>
            Two separate controls: the <strong>directory picker</strong>{" "}
            (below) chooses <em>which docs are shown</em>, by folder. The{" "}
            <strong>filter</strong> control (in the toolbar, once a space is
            picked) narrows those docs by <em>one frontmatter field&rsquo;s
            value</em>. They don&rsquo;t do the same thing.
          </p>
          <p style={{ margin: 0 }}>
            Want a pinned column order, typed/enum fields, and drift flags for
            bad data? Drop a <code style={inlineCode}>.desk.collection.yml</code>{" "}
            in the directory — that turns on schema mode.
          </p>
        </div>
      )}
    </div>
  );
}

// ── Directory picker: collapsed tree (top-level dirs first) ────────────────
//
// `directoriesInSpace` (source.ts) returns EVERY ancestor prefix of every doc
// path (a doc at reports/2026/07/x yields reports, reports/2026,
// reports/2026/07) so any directory stays independently selectable. Rendering
// that flat list as pills sprays a deep space across the page. Presentation
// fix only: fold the flat list into a tree client-side and show top-level
// directories first, expanding to reveal nested ones on demand.

type DirNode = { path: string; label: string; count: number; children: DirNode[] };

function buildDirTree(dirs: DirOption[]): DirNode {
  const byPath = new Map<string, DirNode>();
  const root: DirNode = { path: "", label: "(root)", count: 0, children: [] };
  byPath.set("", root);
  // Ancestors always sort before descendants lexicographically ("reports" <
  // "reports/2026"), and source.ts guarantees every ancestor is present, so a
  // single sorted pass can attach each node to its already-known parent.
  const nonRoot = dirs.filter((d) => d.path !== "").sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const d of nonRoot) {
    const slash = d.path.lastIndexOf("/");
    const parentPath = slash < 0 ? "" : d.path.slice(0, slash);
    const node: DirNode = { path: d.path, label: d.path.slice(slash + 1), count: d.count, children: [] };
    byPath.set(d.path, node);
    (byPath.get(parentPath) ?? root).children.push(node);
  }
  const rootOption = dirs.find((d) => d.path === "");
  root.count = rootOption?.count ?? 0;
  return root;
}

/** Every proper ancestor path of `path` (excludes `path` itself and the root ""). */
function ancestorPaths(path: string): string[] {
  if (!path) return [];
  const parts = path.split("/");
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
}

function DirectoryTree({ root, space, dir }: { root: DirNode; space: string; dir: string }) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(ancestorPaths(dir)));
  // Track the `dir` this state was last reconciled against, so a prop change
  // (nav, back/forward, a shared link) can pull the new active directory's
  // ancestors into `expanded` — adjusting state during render (React's
  // documented pattern for "adjusting state when a prop changes") rather than
  // in an effect, which would cost an extra cascading render.
  const [reconciledDir, setReconciledDir] = useState(dir);
  if (dir !== reconciledDir) {
    setReconciledDir(dir);
    const needed = ancestorPaths(dir);
    if (needed.some((a) => !expanded.has(a))) {
      setExpanded((prev) => {
        const next = new Set(prev);
        for (const a of needed) next.add(a);
        return next;
      });
    }
  }

  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const renderNode = (node: DirNode, depth: number, isRoot: boolean): React.ReactNode => {
    const hasChildren = node.children.length > 0;
    const isOpen = isRoot || expanded.has(node.path);
    return (
      <div key={node.path || "__root__"}>
        <div style={{ display: "flex", alignItems: "center", gap: 4, paddingLeft: depth * 16 }}>
          {!isRoot && hasChildren ? (
            <button
              type="button"
              onClick={() => toggle(node.path)}
              aria-expanded={isOpen}
              aria-label={`${isOpen ? "Collapse" : "Expand"} ${node.label}`}
              style={chevronBtn}
            >
              {isOpen ? "▾" : "▸"}
            </button>
          ) : !isRoot ? (
            <span style={{ display: "inline-block", width: 16 }} aria-hidden="true" />
          ) : null}
          <PickLink href={`/catalog?space=${encodeURIComponent(space)}&dir=${encodeURIComponent(node.path)}`} active={dir === node.path}>
            {node.label}
            {node.path !== "" ? "/" : ""}{" "}
            <span style={{ color: "var(--faint)", fontFamily: mono, fontSize: 11 }}>{node.count}</span>
          </PickLink>
        </div>
        {hasChildren && isOpen && node.children.map((child) => renderNode(child, depth + 1, false))}
      </div>
    );
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 3,
        minWidth: 220,
        maxHeight: 260,
        overflowY: "auto",
        padding: "6px 8px",
        border: "1px solid var(--hairline)",
        borderRadius: 8,
      }}
    >
      {renderNode(root, 0, true)}
    </div>
  );
}

function Control({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span style={label10}>{label}</span>
      {children}
    </div>
  );
}

function FieldSelect({
  value,
  onChange,
  fields,
  allowNone,
}: {
  value: string;
  onChange: (v: string) => void;
  fields: string[];
  allowNone: boolean;
}) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} style={selectStyle} aria-label="Field">
      {allowNone && <option value="">none</option>}
      {fields.map((f) => (
        <option key={f} value={f}>
          {f}
        </option>
      ))}
    </select>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th style={{ textAlign: "left", padding: "9px 12px", ...label10, whiteSpace: "nowrap" }}>{children}</th>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        border: "1px dashed var(--hairline)",
        borderRadius: 10,
        padding: "28px 18px",
        textAlign: "center",
        color: "var(--faint)",
        fontSize: 13,
      }}
    >
      {children}
    </div>
  );
}

const tdStyle = { padding: "9px 12px", verticalAlign: "top" as const } as const;

const selectStyle = {
  fontSize: 12.5,
  fontFamily: mono,
  padding: "4px 8px",
  borderRadius: 6,
  border: "1px solid var(--hairline)",
  background: "var(--surface)",
  color: "var(--ink)",
} as const;

const inlineCode = {
  fontFamily: mono,
  fontSize: 11.5,
  background: "var(--surface)",
  border: "1px solid var(--hairline)",
  borderRadius: 4,
  padding: "1px 4px",
} as const;

const chevronBtn = {
  border: "none",
  background: "none",
  color: "var(--muted)",
  cursor: "pointer",
  fontSize: 11,
  lineHeight: 1,
  padding: 0,
  width: 16,
  height: 16,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
} as const;

const ctrlBtn = {
  border: "1px solid var(--hairline)",
  background: "var(--surface)",
  color: "var(--muted)",
  borderRadius: 6,
  padding: "4px 8px",
  fontSize: 11,
  cursor: "pointer",
} as const;
