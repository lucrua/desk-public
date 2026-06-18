import { describe, it, expect } from "vitest";
import {
  deriveFolders,
  buildDocTree,
  flattenSearch,
  pathContextLabel,
  pathSuggestions,
  moveCtaLabel,
  shareModeChip,
  railVersionShort,
  type TreeFolderRow,
  type TreeDocRow,
} from "./view-model";

type D = { slug: string; path: string; title: string };
const d = (slug: string, path: string, title = slug): D => ({ slug, path, title });

// The mock's fixture set, minus presentational fields.
const DOCS: D[] = [
  d("welcome", "", "Welcome"),
  d("quarterly-report", "finance", "Quarterly report"),
  d("forecast-2026", "finance", "Forecast 2026"),
  d("onboarding-guide", "ops", "Onboarding guide"),
  d("incident-response", "ops/runbooks", "Incident response"),
  d("backup-restore", "ops/runbooks", "Backup & restore"),
  d("api-overview", "product", "API overview"),
  d("vendor-review", "partners", "Vendor review — Microsoft"),
];

describe("deriveFolders", () => {
  it("derives every implied folder prefix, sorted", () => {
    expect(deriveFolders(DOCS)).toEqual([
      "finance",
      "ops",
      "ops/runbooks",
      "partners",
      "product",
    ]);
  });

  it("root-only docs imply no folders", () => {
    expect(deriveFolders([d("a", ""), d("b", "")])).toEqual([]);
  });
});

describe("buildDocTree", () => {
  it("folders depth-first (child folders before docs), root docs last", () => {
    const rows = buildDocTree(DOCS);
    const shape = rows.map((r) =>
      r.kind === "folder" ? `F:${r.path}@${r.depth}` : `D:${r.doc.slug}@${r.depth}`,
    );
    expect(shape).toEqual([
      "F:finance@0",
      "D:quarterly-report@1",
      "D:forecast-2026@1",
      "F:ops@0",
      "F:ops/runbooks@1", // child folder before ops' own docs
      "D:incident-response@2",
      "D:backup-restore@2",
      "D:onboarding-guide@1",
      "F:partners@0",
      "D:vendor-review@1",
      "F:product@0",
      "D:api-overview@1",
      "D:welcome@0", // root doc last, depth 0
    ]);
  });

  it("folder count is the recursive total (self + descendants)", () => {
    const rows = buildDocTree(DOCS);
    const ops = rows.find((r) => r.kind === "folder" && r.path === "ops") as TreeFolderRow;
    // ops/onboarding-guide + ops/runbooks/{incident,backup} = 3
    expect(ops.count).toBe(3);
    const runbooks = rows.find(
      (r) => r.kind === "folder" && r.path === "ops/runbooks",
    ) as TreeFolderRow;
    expect(runbooks.count).toBe(2);
  });

  it("a collapsed folder emits its header but hides descendants", () => {
    const rows = buildDocTree(DOCS, { ops: true });
    const opsIdx = rows.findIndex((r) => r.kind === "folder" && r.path === "ops");
    expect(opsIdx).toBeGreaterThanOrEqual(0);
    // ops still shows its caret + count
    expect((rows[opsIdx] as TreeFolderRow).collapsed).toBe(true);
    // no ops descendants present
    expect(rows.some((r) => r.kind === "folder" && r.path === "ops/runbooks")).toBe(false);
    expect(rows.some((r) => r.kind === "doc" && r.doc.slug === "onboarding-guide")).toBe(false);
    expect(rows.some((r) => r.kind === "doc" && r.doc.slug === "incident-response")).toBe(false);
    // sibling folders unaffected
    expect(rows.some((r) => r.kind === "folder" && r.path === "finance")).toBe(true);
  });

  it("collapsing a parent hides the child even if the child is open", () => {
    const rows = buildDocTree(DOCS, { ops: true, "ops/runbooks": false });
    expect(rows.some((r) => r.kind === "doc" && r.doc.slug === "incident-response")).toBe(false);
  });

  it("does not mutate the input", () => {
    const copy = JSON.parse(JSON.stringify(DOCS));
    buildDocTree(DOCS, { ops: true });
    expect(DOCS).toEqual(copy);
  });
});

describe("flattenSearch", () => {
  it("returns flat depth-0 doc rows with path context for substring matches", () => {
    const rows = flattenSearch(DOCS, "forecast");
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("doc");
    expect(rows[0].depth).toBe(0);
    expect(rows[0].showPath).toBe(true);
    expect(rows[0].pathContext).toBe("finance/");
    expect(rows[0].doc.slug).toBe("forecast-2026");
  });

  it("matches on the folder path, not just title/slug", () => {
    const rows = flattenSearch(DOCS, "runbooks");
    expect(rows.map((r) => r.doc.slug).sort()).toEqual(["backup-restore", "incident-response"]);
  });

  it("root docs get a (root) context prefix", () => {
    const rows = flattenSearch(DOCS, "welcome");
    expect(rows[0].pathContext).toBe("(root)");
  });

  it("prefiltered mode keeps every doc (FTS body hits) and only adds context", () => {
    // The substring 'zzz' matches nothing, but prefiltered trusts the caller.
    const rows = flattenSearch([d("body-hit", "finance", "Plain Title")], "zzz", {
      prefiltered: true,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].pathContext).toBe("finance/");
  });
});

describe("pathContextLabel", () => {
  it("root → (root), folder → folder/", () => {
    expect(pathContextLabel("")).toBe("(root)");
    expect(pathContextLabel("ops/runbooks")).toBe("ops/runbooks/");
  });
});

describe("pathSuggestions", () => {
  const folders = deriveFolders(DOCS);

  it("empty input: (root) selected + all folders, no new-folder row", () => {
    const s = pathSuggestions("", folders);
    expect(s[0]).toMatchObject({ value: "", label: "(root)", selected: true, note: "selected" });
    expect(s.some((x) => x.isNew)).toBe(false);
    expect(s.filter((x) => !x.isNew && x.value !== "").map((x) => x.value)).toEqual(folders);
  });

  it("typing an existing folder marks it selected, no new-folder row", () => {
    const s = pathSuggestions("finance", folders);
    const fin = s.find((x) => x.value === "finance")!;
    expect(fin.selected).toBe(true);
    expect(fin.note).toBe("selected");
    expect(s.some((x) => x.isNew)).toBe(false);
  });

  it("typing a new valid path appends a new-folder row", () => {
    const s = pathSuggestions("finance/archive", folders);
    const last = s[s.length - 1];
    expect(last.isNew).toBe(true);
    expect(last.value).toBe("finance/archive");
    expect(last.label).toBe("finance/archive/");
    expect(last.note).toBe("new folder — created on move");
  });

  it("substring filters existing folders (e.g. 'ops' → ops, ops/runbooks)", () => {
    const s = pathSuggestions("ops", folders);
    const existing = s.filter((x) => !x.isNew && x.value !== "").map((x) => x.value);
    expect(existing).toEqual(["ops", "ops/runbooks"]);
    // 'ops' is an existing folder, so it's selected — no new-folder row.
    expect(s.some((x) => x.isNew)).toBe(false);
  });

  it("an invalid typed path yields no new-folder row (only (root))", () => {
    const s = pathSuggestions("Bad Folder!", folders);
    expect(s.some((x) => x.isNew)).toBe(false);
    expect(s[0].value).toBe("");
  });

  it("normalizes surrounding slashes before matching", () => {
    const s = pathSuggestions("/finance/", folders);
    expect(s.find((x) => x.value === "finance")!.selected).toBe(true);
  });
});

describe("moveCtaLabel", () => {
  const folders = deriveFolders(DOCS);
  it("existing path → Move", () => {
    expect(moveCtaLabel("finance", folders)).toBe("Move");
    expect(moveCtaLabel("", folders)).toBe("Move");
  });
  it("new path → Create folder & move", () => {
    expect(moveCtaLabel("finance/archive", folders)).toBe("Create folder & move");
  });
  it("invalid path → Move (the new-folder affordance never fires on invalid)", () => {
    expect(moveCtaLabel("Bad!", folders)).toBe("Move");
  });
});

describe("railVersionShort", () => {
  it("extracts the bare vN from a rail label", () => {
    expect(railVersionShort("v7 · current")).toBe("v7");
    expect(railVersionShort("v3")).toBe("v3");
  });
});

describe("shareModeChip", () => {
  const labels = { 10: "v1", 20: "v2", 30: "v3" };
  it("null pin → live chip", () => {
    const c = shareModeChip(null, labels);
    expect(c.kind).toBe("live");
    if (c.kind === "live") expect(c.title).toMatch(/latest/i);
  });
  it("pinned id → 'pinned vN' purple chip", () => {
    const c = shareModeChip(30, labels);
    expect(c.kind).toBe("pinned");
    if (c.kind === "pinned") {
      expect(c.label).toBe("pinned v3");
      expect(c.title).toMatch(/snapshot/i);
    }
  });
  it("pin to an unknown id falls back to bare 'pinned'", () => {
    const c = shareModeChip(999, labels);
    if (c.kind === "pinned") expect(c.label).toBe("pinned");
  });
});
