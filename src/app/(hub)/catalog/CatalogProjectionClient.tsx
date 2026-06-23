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

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: "28px 20px 80px" }}>
      <header style={{ marginBottom: 18 }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, fontFamily: mono, margin: "0 0 4px" }}>Catalog</h1>
        <p style={{ margin: 0, fontSize: 13, color: "var(--muted)" }}>
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
          <Picker label="directory">
            {dirs.map((d) => (
              <PickLink
                key={d.path || "__root__"}
                href={`/catalog?space=${encodeURIComponent(space)}&dir=${encodeURIComponent(d.path)}`}
                active={d.path === dir}
              >
                {d.path === "" ? "(root)" : d.path + "/"}{" "}
                <span style={{ color: "var(--faint)", fontFamily: mono, fontSize: 11 }}>{d.count}</span>
              </PickLink>
            ))}
          </Picker>
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

const ctrlBtn = {
  border: "1px solid var(--hairline)",
  background: "var(--surface)",
  color: "var(--muted)",
  borderRadius: 6,
  padding: "4px 8px",
  fontSize: 11,
  cursor: "pointer",
} as const;
