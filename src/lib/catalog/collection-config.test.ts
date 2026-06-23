import { describe, it, expect } from "vitest";
import { parseYamlSubset } from "./yaml-subset";
import { parseCollectionConfig } from "./collection-config";

describe("parseYamlSubset", () => {
  it("parses scalars, types, and quotes", () => {
    const v = parseYamlSubset(`
a: hello
b: 42
c: 3.14
d: true
e: null
f: "quoted: value"
`) as Record<string, unknown>;
    expect(v.a).toBe("hello");
    expect(v.b).toBe(42);
    expect(v.c).toBeCloseTo(3.14);
    expect(v.d).toBe(true);
    expect(v.e).toBeNull();
    expect(v.f).toBe("quoted: value");
  });

  it("parses inline + block lists", () => {
    const v = parseYamlSubset(`
inline: [a, b, c]
block:
  - x
  - y
`) as Record<string, unknown>;
    expect(v.inline).toEqual(["a", "b", "c"]);
    expect(v.block).toEqual(["x", "y"]);
  });

  it("parses nested mappings (maps of maps)", () => {
    const v = parseYamlSubset(`
fields:
  status:
    type: enum
    values: [open, shipped]
    required: true
  owner:
    type: string
`) as Record<string, Record<string, Record<string, unknown>>>;
    expect(v.fields.status.type).toBe("enum");
    expect(v.fields.status.values).toEqual(["open", "shipped"]);
    expect(v.fields.status.required).toBe(true);
    expect(v.fields.owner.type).toBe("string");
  });

  it("parses a block list of mappings (- key: value)", () => {
    const v = parseYamlSubset(`
views:
  - type: board
    group_by: status
  - type: table
    columns: [status, owner]
`) as { views: Array<Record<string, unknown>> };
    expect(v.views).toHaveLength(2);
    expect(v.views[0]).toEqual({ type: "board", group_by: "status" });
    expect(v.views[1]).toEqual({ type: "table", columns: ["status", "owner"] });
  });

  it("parses an inline flow-map list item", () => {
    const v = parseYamlSubset(`
views:
  - { type: list }
`) as { views: Array<Record<string, unknown>> };
    expect(v.views[0]).toEqual({ type: "list" });
  });

  it("ignores comments and blanks, never throws on garbage", () => {
    expect(parseYamlSubset("")).toEqual({});
    expect(parseYamlSubset("# just a comment\n\n")).toEqual({});
    expect(() => parseYamlSubset(": : : nonsense ][}{")).not.toThrow();
  });
});

describe("parseCollectionConfig", () => {
  const SAMPLE = `
fields:
  status:
    type: enum
    values: [open, in-progress, shipped, superseded]
    required: true
    label: Status
  severity:
    type: enum
    values: [low, medium, high]
  owner:
    type: string
views:
  - type: board
    group_by: status
    label: By status
  - type: table
    columns: [status, severity, owner]
  - { type: list }
default_view: board
`;

  it("parses fields with types, enums, required, label", () => {
    const c = parseCollectionConfig(SAMPLE);
    const status = c.fields.find((f) => f.key === "status")!;
    expect(status.type).toBe("enum");
    expect(status.values).toEqual(["open", "in-progress", "shipped", "superseded"]);
    expect(status.required).toBe(true);
    expect(status.label).toBe("Status");

    const severity = c.fields.find((f) => f.key === "severity")!;
    expect(severity.required).toBe(false);
    expect(severity.values).toEqual(["low", "medium", "high"]);

    const owner = c.fields.find((f) => f.key === "owner")!;
    expect(owner.type).toBe("string");
    expect(owner.values).toEqual([]);
  });

  it("parses board / table / list views with their options", () => {
    const c = parseCollectionConfig(SAMPLE);
    expect(c.views.map((v) => v.type)).toEqual(["board", "table", "list"]);
    const board = c.views[0];
    if (board.type !== "board") throw new Error("expected board");
    expect(board.groupBy).toBe("status");
    const table = c.views[1];
    if (table.type !== "table") throw new Error("expected table");
    expect(table.columns).toEqual(["status", "severity", "owner"]);
  });

  it("honors default_view when it names a declared view", () => {
    expect(parseCollectionConfig(SAMPLE).defaultView).toBe("board");
  });

  it("falls back to the first view when default_view is unknown/absent", () => {
    const c = parseCollectionConfig(`
fields:
  a:
    type: string
views:
  - type: table
    columns: [a]
default_view: nonsense
`);
    expect(c.defaultView).toBe("table");
  });

  it("drops a view with an unknown type and records a note", () => {
    const c = parseCollectionConfig(`
views:
  - type: gantt
  - type: list
`);
    expect(c.views.map((v) => v.type)).toEqual(["list"]);
    expect(c.notes.some((n) => n.includes("gantt"))).toBe(true);
  });

  it("synthesizes a table view when fields exist but no views declared", () => {
    const c = parseCollectionConfig(`
fields:
  status:
    type: string
  owner:
    type: string
`);
    expect(c.views).toHaveLength(1);
    const v = c.views[0];
    if (v.type !== "table") throw new Error("expected table");
    expect(v.columns).toEqual(["status", "owner"]);
  });

  it("treats an empty/blank config as no schema (empty fields + views)", () => {
    const c = parseCollectionConfig("");
    expect(c.fields).toEqual([]);
    expect(c.views).toEqual([]);
  });
});
