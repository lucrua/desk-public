/**
 * Parser + model for `.desk.collection.yml` — the in-repo schema that turns an
 * auto-projected directory of front-mattered docs into a SCHEMA-MODE catalog
 * (design-document-host.md §6: "catalogs = the projection of repo frontmatter,
 * validated against a schema declared IN the repo, never hardcoded").
 *
 * Desk has no YAML dependency (frontmatter.ts parses a pragmatic subset by hand;
 * we keep the same posture). This module parses the small, well-known SHAPE a
 * collection config uses — fields (with type/enum/required) and views (board/
 * table/list with their options) — and nothing more exotic. A surprising or
 * malformed file degrades gracefully (we surface a parse note and fall back to
 * auto mode) rather than throwing: projection must never crash on a bad config.
 *
 * The shape we support:
 *
 *   fields:
 *     status:
 *       type: enum            # enum | string | number | boolean | date
 *       values: [open, shipped, superseded]   # enum members (also `enum:`)
 *       required: true
 *       label: Status         # optional human label
 *     severity:
 *       type: enum
 *       values: [low, medium, high]
 *   views:
 *     - type: board           # board | table | list
 *       group_by: status      # required for board
 *       label: By status
 *     - type: table
 *       columns: [status, severity, owner]
 *     - { type: list }
 *   default_view: board       # optional; else first view, else table
 *
 * A field declared with `type: enum` but no `values` is treated as a free
 * string. `required` defaults false. Unknown view types are dropped (with a
 * note). Everything is read/render-only — Desk never writes this file.
 */

import { parseYamlSubset, type YamlValue } from "./yaml-subset";

export type CollectionFieldType =
  | "enum"
  | "string"
  | "number"
  | "boolean"
  | "date";

export type CollectionField = {
  /** The frontmatter key this field declares. */
  key: string;
  type: CollectionFieldType;
  /** Allowed values when `type: enum`. Empty/absent ⇒ free string. */
  values: string[];
  required: boolean;
  /** Optional human label; falls back to the key in the UI. */
  label: string | null;
};

export type CollectionView =
  | { type: "board"; groupBy: string | null; label: string | null }
  | { type: "table"; columns: string[] | null; label: string | null }
  | { type: "list"; label: string | null };

export type CollectionConfig = {
  fields: CollectionField[];
  views: CollectionView[];
  /** The view `type` to show first (validated to exist in `views`). */
  defaultView: CollectionView["type"];
  /** Non-fatal parse notes (unknown view types, dropped keys) for the UI. */
  notes: string[];
};

const FIELD_TYPES: ReadonlySet<string> = new Set([
  "enum",
  "string",
  "number",
  "boolean",
  "date",
]);

const VIEW_TYPES: ReadonlySet<string> = new Set(["board", "table", "list"]);

function asString(v: YamlValue): string | null {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

function asStringList(v: YamlValue): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const item of v) {
    const s = asString(item);
    if (s != null) out.push(s);
  }
  return out;
}

function asBool(v: YamlValue): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v.trim().toLowerCase() === "true";
  return false;
}

function isRecord(v: YamlValue): v is Record<string, YamlValue> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

/** Parse one `fields:` entry value into a CollectionField. */
function parseField(key: string, raw: YamlValue): CollectionField {
  if (!isRecord(raw)) {
    // `status: string` shorthand → a typed field with no constraints.
    const t = asString(raw);
    const type = (t && FIELD_TYPES.has(t) ? t : "string") as CollectionFieldType;
    return { key, type, values: [], required: false, label: null };
  }
  const typeRaw = asString(raw.type);
  const type = (typeRaw && FIELD_TYPES.has(typeRaw) ? typeRaw : "string") as CollectionFieldType;
  // `values:` or `enum:` may carry the allowed members.
  const values =
    asStringList(raw.values) ?? asStringList(raw.enum) ?? [];
  return {
    key,
    type,
    values,
    required: asBool(raw.required),
    label: asString(raw.label),
  };
}

/** Parse one `views:` list item into a CollectionView, or null when unusable. */
function parseView(raw: YamlValue, notes: string[]): CollectionView | null {
  if (!isRecord(raw)) {
    notes.push("dropped a view that is not a mapping");
    return null;
  }
  const type = asString(raw.type);
  if (!type || !VIEW_TYPES.has(type)) {
    notes.push(`dropped a view with unknown type "${type ?? "(none)"}"`);
    return null;
  }
  const label = asString(raw.label);
  if (type === "board") {
    return { type: "board", groupBy: asString(raw.group_by ?? raw.groupBy), label };
  }
  if (type === "table") {
    return { type: "table", columns: asStringList(raw.columns), label };
  }
  return { type: "list", label };
}

/**
 * Parse a `.desk.collection.yml` blob into a CollectionConfig. Never throws —
 * an empty/malformed file yields an empty config the caller can treat as "no
 * schema" (auto mode). `notes` carries anything the parser dropped.
 */
export function parseCollectionConfig(text: string): CollectionConfig {
  const notes: string[] = [];
  const root = parseYamlSubset(text);

  const fields: CollectionField[] = [];
  if (isRecord(root) && isRecord(root.fields)) {
    for (const [key, raw] of Object.entries(root.fields)) {
      fields.push(parseField(key, raw));
    }
  }

  const views: CollectionView[] = [];
  if (isRecord(root) && Array.isArray(root.views)) {
    for (const raw of root.views) {
      const v = parseView(raw, notes);
      if (v) views.push(v);
    }
  }
  // A config with fields but no explicit views still gets a sensible table.
  if (views.length === 0 && fields.length > 0) {
    views.push({ type: "table", columns: fields.map((f) => f.key), label: null });
  }

  // default_view: validated to be one of the declared view types.
  const wantDefault = isRecord(root)
    ? asString(root.default_view ?? root.defaultView)
    : null;
  const have = new Set(views.map((v) => v.type));
  const defaultView: CollectionView["type"] =
    wantDefault && have.has(wantDefault as CollectionView["type"])
      ? (wantDefault as CollectionView["type"])
      : (views[0]?.type ?? "table");

  return { fields, views, defaultView, notes };
}

/** The filename Desk looks for in a catalog directory to enter schema mode. */
export const COLLECTION_CONFIG_FILENAME = ".desk.collection.yml";
