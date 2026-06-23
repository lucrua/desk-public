import { describe, it, expect } from "vitest";
import { parseCollectionConfig } from "./collection-config";
import {
  projectCatalog,
  unionFields,
  displayValue,
  groupRows,
  sortRows,
  filterRows,
  distinctValues,
  type CatalogDoc,
} from "./projection";

const doc = (
  slug: string,
  frontmatter: Record<string, unknown>,
  title = slug,
  path = "findings",
): CatalogDoc => ({ slug, title, path, frontmatter });

const DOCS: CatalogDoc[] = [
  doc("f-001", { status: "open", severity: "high", owner: "lucas" }),
  doc("f-002", { status: "shipped", severity: "low" }),
  doc("f-003", { status: "open", severity: "medium", owner: "pedro" }),
];

describe("displayValue", () => {
  it("renders scalars, arrays, booleans, null", () => {
    expect(displayValue("x")).toBe("x");
    expect(displayValue(42)).toBe("42");
    expect(displayValue(true)).toBe("true");
    expect(displayValue(null)).toBe("");
    expect(displayValue(["a", "b"])).toBe("a, b");
  });
});

describe("unionFields", () => {
  it("returns the sorted union of all frontmatter keys", () => {
    expect(unionFields(DOCS)).toEqual(["owner", "severity", "status"]);
  });
});

describe("projectCatalog — auto mode", () => {
  it("renders the union of frontmatter fields, no drift", () => {
    const p = projectCatalog(DOCS, null);
    expect(p.mode).toBe("auto");
    expect(p.fields).toEqual(["owner", "severity", "status"]);
    expect(p.rows).toHaveLength(3);
    expect(p.driftCount).toBe(0);
    expect(p.rows[0].values.status).toBe("open");
  });

  it("handles a doc with no frontmatter", () => {
    const p = projectCatalog([doc("empty", {})], null);
    expect(p.fields).toEqual([]);
    expect(p.rows[0].values).toEqual({});
    expect(p.rows[0].drift).toEqual([]);
  });

  it("an empty directory yields an empty projection", () => {
    const p = projectCatalog([], null);
    expect(p.rows).toEqual([]);
    expect(p.fields).toEqual([]);
  });
});

const SCHEMA = parseCollectionConfig(`
fields:
  status:
    type: enum
    values: [open, shipped, superseded]
    required: true
  severity:
    type: enum
    values: [low, medium, high]
views:
  - type: board
    group_by: status
  - type: table
    columns: [status, severity]
`);

describe("projectCatalog — schema mode", () => {
  it("uses schema field order and flags no drift on a clean set", () => {
    const clean: CatalogDoc[] = [
      doc("a", { status: "open", severity: "high" }),
      doc("b", { status: "shipped", severity: "low" }),
    ];
    const p = projectCatalog(clean, SCHEMA);
    expect(p.mode).toBe("schema");
    expect(p.fields.slice(0, 2)).toEqual(["status", "severity"]);
    expect(p.driftCount).toBe(0);
  });

  it("flags a missing required field as drift", () => {
    const p = projectCatalog([doc("a", { severity: "low" })], SCHEMA);
    expect(p.driftCount).toBe(1);
    expect(p.rows[0].drift[0].kind).toBe("missing-required");
    expect(p.rows[0].drift[0].field).toBe("status");
  });

  it("flags a value outside an enum as drift, without hiding the doc", () => {
    const p = projectCatalog([doc("a", { status: "open", severity: "critical" })], SCHEMA);
    expect(p.rows).toHaveLength(1); // not hidden
    expect(p.driftCount).toBe(1);
    expect(p.rows[0].drift[0].kind).toBe("enum-violation");
    expect(p.rows[0].drift[0].field).toBe("severity");
  });

  it("appends extra frontmatter keys not declared in the schema", () => {
    const p = projectCatalog([doc("a", { status: "open", extra: "x" })], SCHEMA);
    expect(p.fields).toContain("extra");
    // declared fields come first
    expect(p.fields.indexOf("status")).toBeLessThan(p.fields.indexOf("extra"));
  });
});

describe("group / sort / filter", () => {
  it("groups rows by a field, schema enum order when provided", () => {
    const p = projectCatalog(DOCS, null);
    const groups = groupRows(p.rows, "status", ["open", "shipped", "superseded"]);
    expect(groups.map((g) => g.key)).toEqual(["open", "shipped"]);
    expect(groups[0].rows).toHaveLength(2);
  });

  it("groups missing values into '—' last", () => {
    const p = projectCatalog([doc("a", { status: "open" }), doc("b", {})], null);
    const groups = groupRows(p.rows, "status");
    expect(groups[groups.length - 1].key).toBe("—");
  });

  it("sorts rows by a field ascending/descending", () => {
    const p = projectCatalog(DOCS, null);
    const asc = sortRows(p.rows, "status", "asc").map((r) => r.slug);
    expect(asc[0]).toBe("f-001"); // open < shipped
    const desc = sortRows(p.rows, "status", "desc").map((r) => r.slug);
    expect(desc[0]).toBe("f-002"); // shipped first
  });

  it("filters rows by a field value", () => {
    const p = projectCatalog(DOCS, null);
    const open = filterRows(p.rows, "status", "open");
    expect(open.map((r) => r.slug)).toEqual(["f-001", "f-003"]);
  });

  it("lists distinct values for a field, '—' last when some are missing", () => {
    const p = projectCatalog([doc("a", { owner: "lucas" }), doc("b", {})], null);
    expect(distinctValues(p.rows, "owner")).toEqual(["lucas", "—"]);
  });
});
