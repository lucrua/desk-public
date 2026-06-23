/**
 * Pure projection logic for the catalog-as-projection surface (D6).
 *
 * A catalog = the docs in a chosen space under a chosen directory, rendered from
 * each doc's `parsedFrontmatter` (already populated by the indexer). This module
 * turns that doc list (+ an optional `.desk.collection.yml` schema) into the
 * view-model the UI renders:
 *
 *   - AUTO MODE (no schema): the UNION of frontmatter field keys across the docs,
 *     plus per-doc rows; the UI groups/filters/sorts by any field.
 *   - SCHEMA MODE: the declared fields drive column order + validation; each doc
 *     is checked against the schema and any DRIFT (missing required field, value
 *     outside an enum) is surfaced as a visible flag — invalid docs are NOT
 *     hidden.
 *
 * No React, no DB, no fetch — unit-testable in isolation. View prefs (chosen
 * view, group/sort/filter) are Desk-side display state the CLIENT owns; this
 * module only produces the data those controls act on. NOTHING here writes a
 * file — the catalog is read/render-only.
 */

import type { CollectionConfig, CollectionField } from "./collection-config";

/** A doc as projected into a catalog row. `frontmatter` is its parsed YAML. */
export type CatalogDoc = {
  slug: string;
  title: string;
  /** The doc's folder path (for context; relative display is the page's job). */
  path: string;
  frontmatter: Record<string, unknown>;
};

/** One validation problem on a doc, in schema mode. */
export type DriftFlag = {
  field: string;
  kind: "missing-required" | "enum-violation" | "wrong-type";
  message: string;
};

/** A projected catalog row: the doc + a flat string view of each field + drift. */
export type CatalogRow = {
  slug: string;
  title: string;
  path: string;
  /** Raw frontmatter values keyed by field. */
  values: Record<string, unknown>;
  /** Drift flags (empty in auto mode / when valid). */
  drift: DriftFlag[];
};

export type CatalogProjection = {
  mode: "auto" | "schema";
  /** Ordered field keys to show as columns. Schema order in schema mode; the
   * sorted union of frontmatter keys in auto mode. */
  fields: string[];
  rows: CatalogRow[];
  /** Total drift flags across all rows (0 when clean / auto mode). */
  driftCount: number;
};

/** Render a frontmatter value to a display string (arrays joined, null → ""). */
export function displayValue(v: unknown): string {
  if (v == null) return "";
  if (Array.isArray(v)) return v.map((x) => displayValue(x)).join(", ");
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

/** The sorted union of every frontmatter key found across the docs. */
export function unionFields(docs: CatalogDoc[]): string[] {
  const set = new Set<string>();
  for (const d of docs) {
    for (const k of Object.keys(d.frontmatter ?? {})) set.add(k);
  }
  return [...set].sort();
}

/** Validate one doc's frontmatter against the declared fields → drift flags. */
function driftForDoc(
  frontmatter: Record<string, unknown>,
  fields: CollectionField[],
): DriftFlag[] {
  const flags: DriftFlag[] = [];
  for (const f of fields) {
    const present = f.key in frontmatter && frontmatter[f.key] != null && frontmatter[f.key] !== "";
    if (!present) {
      if (f.required) {
        flags.push({
          field: f.key,
          kind: "missing-required",
          message: `required field "${f.key}" is missing`,
        });
      }
      continue;
    }
    const raw = frontmatter[f.key];
    // Enum check (applies to scalar OR each member of a list value).
    if (f.type === "enum" && f.values.length > 0) {
      const members = Array.isArray(raw) ? raw : [raw];
      for (const m of members) {
        const s = displayValue(m);
        if (!f.values.includes(s)) {
          flags.push({
            field: f.key,
            kind: "enum-violation",
            message: `"${s}" is not one of ${f.values.join(", ")}`,
          });
        }
      }
    }
    // Light type checks (number/boolean) — string/date are permissive.
    if (f.type === "number" && !Array.isArray(raw) && typeof raw !== "number") {
      if (!/^-?\d*\.?\d+$/.test(displayValue(raw))) {
        flags.push({
          field: f.key,
          kind: "wrong-type",
          message: `"${displayValue(raw)}" is not a number`,
        });
      }
    }
    if (f.type === "boolean" && typeof raw !== "boolean") {
      const s = displayValue(raw).toLowerCase();
      if (s !== "true" && s !== "false") {
        flags.push({
          field: f.key,
          kind: "wrong-type",
          message: `"${displayValue(raw)}" is not a boolean`,
        });
      }
    }
  }
  return flags;
}

/**
 * Project a doc list (+ optional schema) into the catalog view-model. When
 * `config` is null/empty → AUTO mode (union of frontmatter fields, no drift).
 * When `config` declares fields → SCHEMA mode (schema field order, drift flags).
 */
export function projectCatalog(
  docs: CatalogDoc[],
  config: CollectionConfig | null,
): CatalogProjection {
  const schemaMode = !!config && config.fields.length > 0;

  const fields = schemaMode
    ? config!.fields.map((f) => f.key)
    : unionFields(docs);

  // In schema mode also surface any extra frontmatter keys not in the schema,
  // appended after the declared ones (so nothing is silently hidden).
  let allFields = fields;
  if (schemaMode) {
    const extra = unionFields(docs).filter((k) => !fields.includes(k));
    allFields = [...fields, ...extra];
  }

  let driftCount = 0;
  const rows: CatalogRow[] = docs.map((d) => {
    const fm = d.frontmatter ?? {};
    const drift = schemaMode ? driftForDoc(fm, config!.fields) : [];
    driftCount += drift.length;
    return { slug: d.slug, title: d.title, path: d.path, values: fm, drift };
  });

  return { mode: schemaMode ? "schema" : "auto", fields: allFields, rows, driftCount };
}

// ── Grouping / sorting / filtering (the controls the UI drives) ───────────────

export type SortDir = "asc" | "desc";

/** Group rows by a field's display value. A missing value lands in "—". Returns
 * ordered groups; the group key order follows `groupOrder` when provided (e.g. a
 * schema enum's declared order), else sorted with "—" last. */
export function groupRows(
  rows: CatalogRow[],
  field: string,
  groupOrder?: string[],
): Array<{ key: string; rows: CatalogRow[] }> {
  const NONE = "—";
  const byKey = new Map<string, CatalogRow[]>();
  for (const r of rows) {
    const key = displayValue(r.values[field]) || NONE;
    const arr = byKey.get(key);
    if (arr) arr.push(r);
    else byKey.set(key, [r]);
  }
  let keys = [...byKey.keys()];
  if (groupOrder && groupOrder.length > 0) {
    const rank = new Map(groupOrder.map((k, i) => [k, i] as const));
    keys.sort((a, b) => {
      const ra = rank.has(a) ? rank.get(a)! : Number.MAX_SAFE_INTEGER - 1;
      const rb = rank.has(b) ? rank.get(b)! : Number.MAX_SAFE_INTEGER - 1;
      if (a === NONE) return 1;
      if (b === NONE) return -1;
      if (ra !== rb) return ra - rb;
      return a < b ? -1 : a > b ? 1 : 0;
    });
  } else {
    keys = keys.sort((a, b) => {
      if (a === NONE) return 1;
      if (b === NONE) return -1;
      return a < b ? -1 : a > b ? 1 : 0;
    });
  }
  return keys.map((key) => ({ key, rows: byKey.get(key)! }));
}

/** Sort rows by a field's display value (string-compare; numeric when both
 * sides parse as numbers). Returns a new array. */
export function sortRows(rows: CatalogRow[], field: string, dir: SortDir = "asc"): CatalogRow[] {
  const sign = dir === "desc" ? -1 : 1;
  return [...rows].sort((a, b) => {
    const av = displayValue(a.values[field]);
    const bv = displayValue(b.values[field]);
    const an = Number(av);
    const bn = Number(bv);
    if (av !== "" && bv !== "" && !Number.isNaN(an) && !Number.isNaN(bn)) {
      return (an - bn) * sign;
    }
    if (av === bv) return 0;
    // Empty values sort last regardless of direction.
    if (av === "") return 1;
    if (bv === "") return -1;
    return (av < bv ? -1 : 1) * sign;
  });
}

/** Filter rows to those whose `field` display value equals `value`. An empty
 * `value` (or "—") matches rows missing that field. */
export function filterRows(rows: CatalogRow[], field: string, value: string): CatalogRow[] {
  return rows.filter((r) => {
    const v = displayValue(r.values[field]);
    if (value === "—" || value === "") return v === "";
    return v === value;
  });
}

/** Distinct display values for a field (for a filter dropdown), sorted, with a
 * trailing "—" when some rows are missing the field. */
export function distinctValues(rows: CatalogRow[], field: string): string[] {
  const set = new Set<string>();
  let hasEmpty = false;
  for (const r of rows) {
    const v = displayValue(r.values[field]);
    if (v === "") hasEmpty = true;
    else set.add(v);
  }
  const out = [...set].sort();
  if (hasEmpty) out.push("—");
  return out;
}
