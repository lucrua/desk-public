import { describe, it, expect, beforeEach } from "vitest";
import { resetDb } from "@/test/db";
import {
  listKinds,
  getSchema,
  upsertSchema,
  deleteSchema,
  listItems,
  getItem,
  upsertItem,
  deleteItem,
  extractLinks,
  idMatchesPattern,
  compileIdPattern,
  listActivePatterns,
} from "./catalogs";
import { listEvents } from "./events";

const finding = {
  kind: "finding",
  label: "Findings",
  idPattern: "F-\\d+",
  schema: {
    type: "object",
    required: ["severity"],
    properties: {
      severity: { enum: ["low", "medium", "high"] },
      area: { type: "string" },
    },
    additionalProperties: false,
  },
  actorName: "Alex",
};

const rfc = {
  kind: "rfc",
  label: "RFCs",
  idPattern: "RFC-\\d+",
  schema: { type: "object", properties: { author: { type: "string" } } },
  actorName: "Alex",
};

describe("catalogs service", () => {
  beforeEach(async () => {
    await resetDb();
  });

  describe("idPattern anchoring", () => {
    it("anchors the pattern ^(…)$ so it matches the WHOLE id only", () => {
      expect(idMatchesPattern("F-12", "F-\\d+")).toBe(true);
      expect(idMatchesPattern("F-", "F-\\d+")).toBe(false);
      expect(idMatchesPattern("xF-12", "F-\\d+")).toBe(false);
      expect(idMatchesPattern("F-12x", "F-\\d+")).toBe(false);
    });
    it("rejects an uncompilable pattern", () => {
      const c = compileIdPattern("F-(\\d+");
      expect(c.ok).toBe(false);
    });
  });

  describe("upsertSchema", () => {
    it("creates a kind and emits catalog.schema.created", async () => {
      const r = await upsertSchema(finding);
      expect(r.ok).toBe(true);
      const kinds = await listKinds();
      expect(kinds.map((k) => k.kind)).toEqual(["finding"]);
      expect(kinds[0].itemCount).toBe(0);
      const events = await listEvents({ viewer: "admin" });
      expect(events.some((e) => e.kind === "catalog.schema.created")).toBe(true);
    });

    it("updates an existing kind and emits catalog.schema.updated", async () => {
      await upsertSchema(finding);
      const r = await upsertSchema({ ...finding, label: "Findings v2" });
      expect(r.ok).toBe(true);
      const k = await getSchema("finding");
      expect(k!.label).toBe("Findings v2");
      const events = await listEvents({ viewer: "admin" });
      expect(events.some((e) => e.kind === "catalog.schema.updated")).toBe(true);
    });

    it("rejects an invalid kind slug", async () => {
      const r = await upsertSchema({ ...finding, kind: "Bad Kind" });
      expect(r.ok).toBe(false);
    });

    it("rejects an uncompilable idPattern", async () => {
      const r = await upsertSchema({ ...finding, idPattern: "F-(\\d+" });
      expect(r.ok).toBe(false);
    });

    it("rejects a ReDoS-shaped idPattern (nested quantifier) at write time", async () => {
      const r = await upsertSchema({ ...finding, idPattern: "(a+)+$" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/nested quantifier/);
      // over-long source rejected too
      const long = await upsertSchema({ ...finding, idPattern: "a".repeat(201) });
      expect(long.ok).toBe(false);
    });

    it("rejects an invalid JSON Schema", async () => {
      // `type` must be a string/array of strings — a number is invalid → ajv
      // compile throws.
      const r = await upsertSchema({ ...finding, schema: { type: 123 } });
      expect(r.ok).toBe(false);
    });
  });

  describe("deleteSchema", () => {
    it("deletes an empty kind", async () => {
      await upsertSchema(finding);
      const r = await deleteSchema("finding", "Alex");
      expect(r.ok).toBe(true);
      expect(await getSchema("finding")).toBeNull();
    });
    it("refuses to delete a kind with items (conflict)", async () => {
      await upsertSchema(finding);
      await upsertItem({ kind: "finding", itemId: "F-1", title: "x", data: { severity: "low" }, actorName: "Alex" });
      const r = await deleteSchema("finding", "Alex");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("conflict");
    });
    it("not-found for an unknown kind", async () => {
      const r = await deleteSchema("nope", "Alex");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("not-found");
    });
  });

  describe("upsertItem — id + data validation", () => {
    beforeEach(async () => {
      await upsertSchema(finding);
    });

    it("rejects an itemId that doesn't match the pattern", async () => {
      const r = await upsertItem({ kind: "finding", itemId: "X-9", title: "t", data: { severity: "low" }, actorName: "Alex" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("invalid");
    });

    it("rejects data that fails the schema (missing required)", async () => {
      const r = await upsertItem({ kind: "finding", itemId: "F-1", title: "t", data: { area: "auth" }, actorName: "Alex" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/schema/);
    });

    it("rejects data that fails the schema (enum miss)", async () => {
      const r = await upsertItem({ kind: "finding", itemId: "F-1", title: "t", data: { severity: "critical" }, actorName: "Alex" });
      expect(r.ok).toBe(false);
    });

    it("accepts a valid item and emits catalog.item.created", async () => {
      const r = await upsertItem({ kind: "finding", itemId: "F-1", title: "t", data: { severity: "high" }, actorName: "Alex" });
      expect(r.ok).toBe(true);
      const events = await listEvents({ viewer: "admin" });
      const ev = events.find((e) => e.kind === "catalog.item.created");
      expect(ev).toBeTruthy();
      // Payload carries kind/itemId/title/status only — never body/data.
      expect(ev!.payload).toEqual({ kind: "finding", itemId: "F-1", title: "t", status: "" });
    });

    it("emits catalog.item.updated on re-upsert", async () => {
      await upsertItem({ kind: "finding", itemId: "F-1", title: "t", data: { severity: "high" }, actorName: "Alex" });
      await upsertItem({ kind: "finding", itemId: "F-1", title: "t2", status: "open", data: { severity: "low" }, actorName: "Alex" });
      const item = await getItem("finding", "F-1");
      expect(item!.item.title).toBe("t2");
      expect(item!.item.status).toBe("open");
      const events = await listEvents({ viewer: "admin" });
      expect(events.some((e) => e.kind === "catalog.item.updated")).toBe(true);
    });

    it("not-found for an unknown kind", async () => {
      const r = await upsertItem({ kind: "ghost", itemId: "G-1", title: "t", actorName: "Alex" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("not-found");
    });
  });

  describe("link extraction (pure)", () => {
    const kinds = [
      { kind: "finding", idPattern: "F-\\d+" },
      { kind: "rfc", idPattern: "RFC-\\d+" },
    ];

    it("extracts cross-kind references from the body", () => {
      const edges = extractLinks("finding", "F-1", "see RFC-7 and F-2 for context", {}, kinds);
      const targets = edges.map((e) => `${e.toKind}:${e.toItemId}`).sort();
      expect(targets).toContain("rfc:RFC-7");
      expect(targets).toContain("finding:F-2");
    });

    it("excludes a self-reference", () => {
      const edges = extractLinks("finding", "F-1", "F-1 references itself and F-2", {}, kinds);
      const targets = edges.map((e) => e.toItemId);
      expect(targets).not.toContain("F-1");
      expect(targets).toContain("F-2");
    });

    it("scans data string values too", () => {
      const edges = extractLinks("finding", "F-1", "", { context: "supersedes RFC-3" }, kinds);
      expect(edges.some((e) => e.toItemId === "RFC-3")).toBe(true);
    });

    it("does not match inside a larger token", () => {
      const edges = extractLinks("finding", "F-1", "XF-9 and F-99x are not refs", {}, kinds);
      expect(edges.length).toBe(0);
    });
  });

  describe("upsertItem — atomic link replacement", () => {
    beforeEach(async () => {
      await upsertSchema(finding);
      await upsertSchema(rfc);
    });

    it("derives links on create and reflects them in getItem", async () => {
      await upsertItem({ kind: "rfc", itemId: "RFC-7", title: "rotation", data: {}, actorName: "Alex" });
      await upsertItem({ kind: "finding", itemId: "F-1", title: "session loss", body: "caused by RFC-7", data: { severity: "high" }, actorName: "Alex" });
      const f = await getItem("finding", "F-1");
      expect(f!.outbound.map((e) => e.toItemId)).toContain("RFC-7");
      const r = await getItem("rfc", "RFC-7");
      expect(r!.inbound.map((e) => e.fromItemId)).toContain("F-1");
    });

    it("replaces derived links on update (old link dropped, new added)", async () => {
      await upsertItem({ kind: "rfc", itemId: "RFC-7", title: "a", data: {}, actorName: "Alex" });
      await upsertItem({ kind: "rfc", itemId: "RFC-9", title: "b", data: {}, actorName: "Alex" });
      await upsertItem({ kind: "finding", itemId: "F-1", title: "x", body: "see RFC-7", data: { severity: "low" }, actorName: "Alex" });
      let f = await getItem("finding", "F-1");
      expect(f!.outbound.map((e) => e.toItemId)).toEqual(["RFC-7"]);
      // Re-upsert pointing at RFC-9 instead.
      await upsertItem({ kind: "finding", itemId: "F-1", title: "x", body: "now see RFC-9", data: { severity: "low" }, actorName: "Alex" });
      f = await getItem("finding", "F-1");
      expect(f!.outbound.map((e) => e.toItemId)).toEqual(["RFC-9"]);
    });
  });

  describe("listItems filters", () => {
    beforeEach(async () => {
      await upsertSchema(finding);
      await upsertItem({ kind: "finding", itemId: "F-1", title: "checkout drop", status: "open", data: { severity: "high" }, actorName: "Alex" });
      await upsertItem({ kind: "finding", itemId: "F-2", title: "session loss", status: "resolved", data: { severity: "low" }, actorName: "Alex" });
    });
    it("filters by status", async () => {
      const items = await listItems({ kind: "finding", status: "open" });
      expect(items.map((i) => i.itemId)).toEqual(["F-1"]);
    });
    it("substring-matches q over id and title (case-insensitive)", async () => {
      expect((await listItems({ kind: "finding", q: "session" })).map((i) => i.itemId)).toEqual(["F-2"]);
      expect((await listItems({ kind: "finding", q: "f-1" })).map((i) => i.itemId)).toEqual(["F-1"]);
    });
  });

  describe("deleteItem", () => {
    beforeEach(async () => {
      await upsertSchema(finding);
      await upsertSchema(rfc);
    });
    it("deletes the item, cascades links both directions, emits the event", async () => {
      await upsertItem({ kind: "rfc", itemId: "RFC-7", title: "a", data: {}, actorName: "Alex" });
      await upsertItem({ kind: "finding", itemId: "F-1", title: "x", body: "see RFC-7", data: { severity: "low" }, actorName: "Alex" });
      const del = await deleteItem("finding", "F-1", "Alex");
      expect(del.ok).toBe(true);
      expect(await getItem("finding", "F-1")).toBeNull();
      // RFC-7 should have no inbound now.
      const r = await getItem("rfc", "RFC-7");
      expect(r!.inbound.length).toBe(0);
      const events = await listEvents({ viewer: "admin" });
      expect(events.some((e) => e.kind === "catalog.item.deleted")).toBe(true);
    });
    it("not-found for an unknown item", async () => {
      const r = await deleteItem("finding", "F-404", "Alex");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("not-found");
    });
  });

  describe("listActivePatterns", () => {
    it("returns {kind, idPattern} for every kind, stable order", async () => {
      await upsertSchema(rfc);
      await upsertSchema(finding);
      const pats = await listActivePatterns();
      expect(pats).toEqual([
        { kind: "finding", idPattern: "F-\\d+" },
        { kind: "rfc", idPattern: "RFC-\\d+" },
      ]);
    });
  });
});
