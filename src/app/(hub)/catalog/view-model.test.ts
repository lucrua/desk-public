import { describe, it, expect } from "vitest";
import {
  inverseLinkLabel,
  schemaFields,
  previewSchema,
  checkIdPattern,
  linkSummary,
  statusChip,
} from "./view-model";

describe("catalog view-model", () => {
  describe("inverseLinkLabel", () => {
    it("maps known types to their inverse", () => {
      expect(inverseLinkLabel("references")).toBe("referenced by");
      expect(inverseLinkLabel("supersedes")).toBe("superseded by");
      expect(inverseLinkLabel("implements")).toBe("implemented by");
    });
    it("falls back to '<type> by'", () => {
      expect(inverseLinkLabel("mentions")).toBe("mentions by");
    });
  });

  describe("schemaFields", () => {
    const schema = {
      type: "object",
      properties: { severity: {}, area: {}, owner: {} },
    };
    it("orders rows by schema property order, em-dash for absent optionals", () => {
      const rows = schemaFields(schema, { severity: "high", area: "auth" });
      expect(rows.map((r) => r.key)).toEqual(["severity", "area", "owner"]);
      expect(rows[2]).toEqual({ key: "owner", value: "—", present: false });
      expect(rows[0]).toEqual({ key: "severity", value: "high", present: true });
    });
    it("appends data keys not declared in the schema", () => {
      const rows = schemaFields(schema, { severity: "low", extra: "x" });
      expect(rows.map((r) => r.key)).toEqual(["severity", "area", "owner", "extra"]);
    });
    it("falls back to data keys when schema has no properties", () => {
      const rows = schemaFields({}, { a: 1, b: 2 });
      expect(rows.map((r) => r.key)).toEqual(["a", "b"]);
    });
  });

  describe("previewSchema", () => {
    const schema = JSON.stringify({
      type: "object",
      required: ["severity"],
      properties: { severity: { enum: ["low", "high"] }, area: {} },
    });
    it("reports a parse error distinctly", () => {
      const p = previewSchema("{ not json", null, 3);
      expect(p.kind).toBe("parse-error");
    });
    it("flags a missing required field and counts migration items", () => {
      const p = previewSchema(schema, { area: "auth" }, 5);
      expect(p.kind).toBe("report");
      if (p.kind === "report") {
        expect(p.valid).toBe(false);
        expect(p.migrationCount).toBe(5);
        expect(p.checks.find((c) => c.field === "severity")?.status).toBe("missing-required");
      }
    });
    it("flags an enum miss", () => {
      const p = previewSchema(schema, { severity: "critical" }, 2);
      if (p.kind === "report") {
        expect(p.valid).toBe(false);
        expect(p.checks.find((c) => c.field === "severity")?.status).toBe("enum-miss");
      }
    });
    it("passes a valid sample with no migration", () => {
      const p = previewSchema(schema, { severity: "high" }, 4);
      if (p.kind === "report") {
        expect(p.valid).toBe(true);
        expect(p.migrationCount).toBe(0);
        expect(p.checks.find((c) => c.field === "area")?.status).toBe("absent-optional");
      }
    });
  });

  describe("checkIdPattern", () => {
    it("validates + matches a sample id", () => {
      expect(checkIdPattern("F-\\d+", "F-12")).toEqual({ valid: true, matches: true });
      expect(checkIdPattern("F-\\d+", "X-12").matches).toBe(false);
    });
    it("reports an invalid regex", () => {
      const r = checkIdPattern("F-(\\d+", "F-1");
      expect(r.valid).toBe(false);
    });
  });

  describe("linkSummary", () => {
    it("summarizes counts", () => {
      expect(linkSummary(2, 1)).toBe("2 outbound · 1 inbound");
      expect(linkSummary(0, 0)).toBe("no links");
      expect(linkSummary(1, 0)).toBe("1 outbound");
    });
  });

  describe("statusChip", () => {
    it("maps known statuses to distinct hues and unknown to neutral", () => {
      expect(statusChip("open").ink).toBe("var(--warn-ink)");
      expect(statusChip("resolved").ink).toBe("var(--ok-ink)");
      expect(statusChip("review").ink).toBe("var(--info-ink)");
      expect(statusChip("whatever").ink).toBe("var(--muted)");
    });
  });
});
