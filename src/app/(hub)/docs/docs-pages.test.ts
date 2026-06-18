import { describe, it, expect, beforeEach } from "vitest";
import { resetDb, seedAudiences, publishDocOk } from "@/test/db";
import { publishDoc, listDocs, listVersions, type PublishInput } from "@/lib/docs";
import {
  shortHash,
  dateStamp,
  buildVersionRail,
  predecessorVersionId,
  parseDiffParam,
  canSeeAudience,
  groupDocsByPath,
} from "./view-model";
import type { VersionListItem } from "@/lib/docs";

describe("view-model: groupDocsByPath", () => {
  const d = (slug: string, path: string) => ({ slug, path });

  it("groups by full path, root first then alphabetical", () => {
    const groups = groupDocsByPath([
      d("a", "os/canon"),
      d("b", ""),
      d("c", "os"),
      d("e", "team"),
    ]);
    expect(groups.map((g) => g.path)).toEqual(["", "os", "os/canon", "team"]);
    expect(groups[0].label).toBe("Root");
    expect(groups[1].label).toBe("os");
  });

  it("keeps docs together within a group and preserves incoming order", () => {
    const groups = groupDocsByPath([d("a", "os"), d("b", "os"), d("c", "")]);
    const os = groups.find((g) => g.path === "os")!;
    expect(os.docs.map((x) => x.slug)).toEqual(["a", "b"]);
  });

  it("a single root-only list yields one group", () => {
    const groups = groupDocsByPath([d("a", ""), d("b", "")]);
    expect(groups).toHaveLength(1);
    expect(groups[0].path).toBe("");
  });

  it("does not mutate the input array", () => {
    const input = [d("a", "z"), d("b", "")];
    const copy = [...input];
    groupDocsByPath(input);
    expect(input).toEqual(copy);
  });
});

// ── pure helpers ──────────────────────────────────────────────────────────────

describe("view-model: shortHash / dateStamp", () => {
  it("shortHash takes the first 7 chars", () => {
    expect(shortHash("8f3a21c0deadbeef")).toBe("8f3a21c");
  });

  it("dateStamp is UTC YYYY-MM-DD", () => {
    expect(dateStamp(new Date("2026-06-09T23:30:00Z"))).toBe("2026-06-09");
  });

  it("dateStamp coerces a date-ish string (runtime aggregate path)", () => {
    // max(published_at) comes back as a string at runtime, not a Date.
    expect(dateStamp("2026-06-09 23:30:00+00")).toBe("2026-06-09");
    expect(dateStamp("2026-06-09T23:30:00.000Z")).toBe("2026-06-09");
  });
});

describe("view-model: canSeeAudience (DB-driven)", () => {
  // canSeeAudience is the service-layer check (re-exported from lib/docs), now
  // DB-driven + async. It accepts "admin" | "member" only — anonymous principals
  // are rejected by the API routes and page layouts before this is reached.
  beforeEach(async () => {
    await resetDb();
    await seedAudiences([{ key: "external:Acme", label: "Acme", memberVisible: false }]);
  });

  it("admin sees every audience", async () => {
    for (const aud of ["team", "alice", "bob", "external:Acme", "weird"]) {
      expect(await canSeeAudience("admin", aud)).toBe(true);
    }
  });
  it("member sees only member-visible audiences (team by default)", async () => {
    expect(await canSeeAudience("member", "team")).toBe(true);
    expect(await canSeeAudience("member", "alice")).toBe(false);
    expect(await canSeeAudience("member", "bob")).toBe(false);
    expect(await canSeeAudience("member", "external:Acme")).toBe(false);
  });
});

describe("view-model: parseDiffParam", () => {
  it("parses a positive integer", () => {
    expect(parseDiffParam("42")).toBe(42);
  });
  it("takes the first of an array", () => {
    expect(parseDiffParam(["7", "9"])).toBe(7);
  });
  it("rejects undefined / non-numeric / non-positive", () => {
    expect(parseDiffParam(undefined)).toBeNull();
    expect(parseDiffParam("abc")).toBeNull();
    expect(parseDiffParam("0")).toBeNull();
    expect(parseDiffParam("-3")).toBeNull();
    expect(parseDiffParam("1.5")).toBeNull();
  });
});

describe("view-model: buildVersionRail", () => {
  // newest-first input, like listVersions returns.
  const versions: VersionListItem[] = [
    { id: 30, contentHash: "ccc", publishedAt: new Date("2026-06-09T00:00:00Z"), publishedBy: "admin" },
    { id: 20, contentHash: "bbb", publishedAt: new Date("2026-06-02T00:00:00Z"), publishedBy: "admin" },
    { id: 10, contentHash: "aaa", publishedAt: new Date("2026-05-21T00:00:00Z"), publishedBy: "admin" },
  ];

  it("labels newest as 'vN · current' and descends", () => {
    const rail = buildVersionRail(versions);
    expect(rail.map((r) => r.label)).toEqual(["v3 · current", "v2", "v1"]);
  });

  it("only the newest is current", () => {
    const rail = buildVersionRail(versions);
    expect(rail.map((r) => r.isCurrent)).toEqual([true, false, false]);
  });

  it("the oldest (v1) is not diffable; others are", () => {
    const rail = buildVersionRail(versions);
    expect(rail.map((r) => r.diffable)).toEqual([true, true, false]);
  });

  it("single version → v1, current, not diffable", () => {
    const rail = buildVersionRail([versions[0]]);
    expect(rail).toHaveLength(1);
    expect(rail[0].label).toBe("v1 · current");
    expect(rail[0].diffable).toBe(false);
  });

  it("empty list → empty rail", () => {
    expect(buildVersionRail([])).toEqual([]);
  });
});

describe("view-model: predecessorVersionId", () => {
  const versions: VersionListItem[] = [
    { id: 30, contentHash: "c", publishedAt: new Date("2026-06-09T00:00:00Z"), publishedBy: "l" },
    { id: 20, contentHash: "b", publishedAt: new Date("2026-06-02T00:00:00Z"), publishedBy: "l" },
    { id: 10, contentHash: "a", publishedAt: new Date("2026-05-21T00:00:00Z"), publishedBy: "l" },
  ];

  it("current (30) → previous is 20", () => {
    expect(predecessorVersionId(versions, 30)).toBe(20);
  });
  it("middle (20) → previous is 10", () => {
    expect(predecessorVersionId(versions, 20)).toBe(10);
  });
  it("oldest (10) → no predecessor", () => {
    expect(predecessorVersionId(versions, 10)).toBeNull();
  });
  it("unknown id → null", () => {
    expect(predecessorVersionId(versions, 999)).toBeNull();
  });
});

// ── DB-backed: server-side search filter (ilike over title+slug) ────────────────

const base: PublishInput = {
  slug: "notes-overview",
  title: "Notes context",
  sourcePath: "os/notes.md",
  audience: "alice",
  format: "md",
  content: "# Notes\nbody",
  by: "admin",
};

describe("listDocs server-side search (q)", () => {
  beforeEach(async () => {
    await resetDb();
    await publishDocOk(base);
    await publishDocOk({ ...base, slug: "q2-growth-review", title: "Q2 growth review", audience: "team" });
    await publishDocOk({ ...base, slug: "instrumentation-audit", title: "Instrumentation audit", audience: "team" });
  });

  it("no q → all docs", async () => {
    const docs = await listDocs();
    expect(docs).toHaveLength(3);
  });

  it("matches on title, case-insensitively", async () => {
    const docs = await listDocs({ q: "GROWTH" });
    expect(docs.map((d) => d.slug)).toEqual(["q2-growth-review"]);
  });

  it("matches on slug substring", async () => {
    const docs = await listDocs({ q: "notes" });
    expect(docs.map((d) => d.slug)).toEqual(["notes-overview"]);
  });

  it("blank / whitespace q behaves like no filter", async () => {
    const docs = await listDocs({ q: "   " });
    expect(docs).toHaveLength(3);
  });

  it("no match → empty", async () => {
    const docs = await listDocs({ q: "zzz-nope" });
    expect(docs).toHaveLength(0);
  });

  it("q filter composes with includeUnpublished", async () => {
    const { unpublishDoc } = await import("@/lib/docs");
    await unpublishDoc("q2-growth-review");
    // published view: filtered out
    expect(await listDocs({ q: "growth" })).toHaveLength(0);
    // admin view: visible again
    const admin = await listDocs({ q: "growth", includeUnpublished: true });
    expect(admin.map((d) => d.slug)).toEqual(["q2-growth-review"]);
  });
});

describe("getVersionContent guards cross-doc access", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("returns content for an own version, null for a foreign version id", async () => {
    const { getVersionContent } = await import("@/lib/docs");
    const a = await publishDocOk({ ...base, slug: "doc-a", content: "A body" });
    const b = await publishDocOk({ ...base, slug: "doc-b", content: "B body" });

    expect(await getVersionContent("doc-a", a.versionId)).toBe("A body");
    // doc-b's version id requested under doc-a's slug → null (no leak)
    expect(await getVersionContent("doc-a", b.versionId)).toBeNull();
    // unknown slug / version
    expect(await getVersionContent("missing", a.versionId)).toBeNull();
    expect(await getVersionContent("doc-a", 999999)).toBeNull();
  });

  it("listVersions ordering feeds buildVersionRail correctly", async () => {
    await publishDocOk({ ...base, slug: "multi", content: "v1" });
    await publishDocOk({ ...base, slug: "multi", content: "v2" });
    const versions = await listVersions("multi");
    const rail = buildVersionRail(versions);
    expect(rail.map((r) => r.label)).toEqual(["v2 · current", "v1"]);
    expect(rail[0].id).toBe(versions[0].id);
  });
});
