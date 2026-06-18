/**
 * Pure view-model logic for the catalog surface — no React, no fetch. The
 * status-chip palette, the typed inverse link labels, the schema-driven field
 * ordering, and the SMALL client-side schema preview checker (the mock's
 * "presence + enum" simplification) all live here so they're unit-testable and
 * the client island stays a thin mapper.
 */

export type CatalogKindDTO = {
  kind: string;
  label: string;
  idPattern: string;
  schema: unknown;
  itemCount: number;
};

export type CatalogItemDTO = {
  kind: string;
  itemId: string;
  title: string;
  status: string;
  body: string;
  data: Record<string, unknown>;
  updatedAt: string;
};

export type CatalogLinkDTO = {
  fromKind: string;
  fromItemId: string;
  toKind: string;
  toItemId: string;
  linkType: string;
};

// ── Status palette ───────────────────────────────────────────────────────────

/**
 * Map a free-text status to a {bg, ink} CSS-var pair. Generic buckets
 * (open/review/resolved/decided/…) get distinct hues; unknown statuses fall
 * back to neutral. Returns CSS custom-property references so light/dark are
 * handled by globals.css.
 */
export function statusChip(status: string): { bg: string; ink: string } {
  const good = { bg: "var(--ok-bg)", ink: "var(--ok-ink)" };
  const warn = { bg: "var(--warn-bg)", ink: "var(--warn-ink)" };
  const blue = { bg: "var(--info-bg)", ink: "var(--info-ink)" };
  const bad = { bg: "var(--danger-bg)", ink: "var(--danger-ink)" };
  const neutral = { bg: "var(--hover)", ink: "var(--muted)" };
  const map: Record<string, { bg: string; ink: string }> = {
    open: warn,
    review: blue,
    proposed: blue,
    draft: neutral,
    resolved: good,
    decided: good,
    accepted: good,
    done: good,
    shipped: good,
    superseded: neutral,
    rejected: bad,
    blocked: bad,
  };
  return map[status.toLowerCase()] || neutral;
}

// ── Typed link labels ────────────────────────────────────────────────────────

/**
 * Inverse label for an inbound edge: an outbound `supersedes` reads, from the
 * target's side, as `superseded by`. Unknown types fall back to "<type> by"
 * (e.g. inbound `references` → "referenced by").
 */
export function inverseLinkLabel(linkType: string): string {
  const map: Record<string, string> = {
    references: "referenced by",
    supersedes: "superseded by",
    implements: "implemented by",
    blocks: "blocked by",
    depends_on: "depended on by",
  };
  return map[linkType] || `${linkType} by`;
}

// ── Schema-driven field ordering ─────────────────────────────────────────────

/**
 * The ordered field rows for an item's `data`, driven by the kind's JSON Schema
 * property ORDER. Every declared property gets a row (in schema order); an
 * absent optional renders as an em-dash. Properties present in `data` but not
 * declared in the schema are appended after the declared ones (so nothing is
 * silently hidden). When the schema has no usable `properties`, falls back to
 * the data's own keys.
 */
export function schemaFields(
  schema: unknown,
  data: Record<string, unknown>,
): Array<{ key: string; value: string; present: boolean }> {
  const props =
    schema != null && typeof schema === "object" && !Array.isArray(schema)
      ? ((schema as { properties?: Record<string, unknown> }).properties ?? null)
      : null;

  const declared = props ? Object.keys(props) : [];
  const extra = Object.keys(data).filter((k) => !declared.includes(k));
  const order = declared.length > 0 ? [...declared, ...extra] : Object.keys(data);

  return order.map((key) => {
    const raw = data[key];
    const present = raw != null && raw !== "" && raw !== "—";
    return {
      key,
      value: present ? String(raw) : "—",
      present,
    };
  });
}

// ── Client-side schema preview (SMALL subset checker) ────────────────────────
//
// The browser editor cannot run ajv (kept server-side); per the mock it does a
// SMALL "presence + enum" check against the kind's FIRST item, surfacing parse
// errors / missing required / enum misses distinctly. The authoritative
// validation still happens on the server at write — this is a fast preview only.

export type SchemaCheck = {
  field: string;
  status: "ok" | "missing-required" | "absent-optional" | "enum-miss";
  note: string;
};

export type SchemaPreview =
  | { kind: "parse-error"; message: string }
  | {
      kind: "report";
      valid: boolean;
      checks: SchemaCheck[];
      /** Number of items a breaking change would flag (caller supplies count). */
      migrationCount: number;
    };

/**
 * Run the small preview against a sample item's `data`. `schemaText` is the raw
 * textarea content (so parse errors surface). `itemCount` is the kind's item
 * count (for the "would flag N items" line on a breaking change).
 */
export function previewSchema(
  schemaText: string,
  sampleData: Record<string, unknown> | null,
  itemCount: number,
): SchemaPreview {
  let parsed: unknown;
  try {
    parsed = JSON.parse(schemaText);
  } catch (e) {
    return { kind: "parse-error", message: (e as Error).message };
  }
  const props =
    parsed != null && typeof parsed === "object" && !Array.isArray(parsed)
      ? ((parsed as { properties?: Record<string, unknown> }).properties ?? {})
      : {};
  const required =
    parsed != null && typeof parsed === "object"
      ? ((parsed as { required?: string[] }).required ?? [])
      : [];

  const checks: SchemaCheck[] = [];
  let valid = true;
  for (const field of Object.keys(props)) {
    const def = (props as Record<string, { enum?: unknown[] }>)[field] ?? {};
    const val = sampleData ? sampleData[field] : undefined;
    const present = val != null && val !== "" && val !== "—";
    if (!present && required.includes(field)) {
      valid = false;
      checks.push({ field, status: "missing-required", note: "required, missing on sample" });
    } else if (!present) {
      checks.push({ field, status: "absent-optional", note: "optional, absent" });
    } else if (def.enum && !def.enum.includes(val)) {
      valid = false;
      checks.push({ field, status: "enum-miss", note: `"${String(val)}" ∉ ${JSON.stringify(def.enum)}` });
    } else {
      checks.push({ field, status: "ok", note: def.enum ? "∈ enum" : "ok" });
    }
  }
  return { kind: "report", valid, checks, migrationCount: valid ? 0 : itemCount };
}

/** Compile-check an idPattern in the browser; returns whether it matches `sampleId`. */
export function checkIdPattern(
  patternSource: string,
  sampleId: string | null,
): { valid: boolean; matches: boolean | null; error?: string } {
  let re: RegExp;
  try {
    re = new RegExp(`^(?:${patternSource})$`);
  } catch (e) {
    return { valid: false, matches: null, error: (e as Error).message };
  }
  return { valid: true, matches: sampleId != null ? re.test(sampleId) : null };
}

/** Build the per-row link summary ("2 outbound · 1 inbound" / "no links"). */
export function linkSummary(outbound: number, inbound: number): string {
  const parts: string[] = [];
  if (outbound) parts.push(`${outbound} outbound`);
  if (inbound) parts.push(`${inbound} inbound`);
  return parts.length ? parts.join(" · ") : "no links";
}
