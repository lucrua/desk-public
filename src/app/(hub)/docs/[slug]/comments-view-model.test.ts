import { describe, it, expect } from "vitest";
import {
  authorChip,
  commentStamp,
  groupThread,
  type CommentDTO,
} from "./comments-view-model";

function c(over: Partial<CommentDTO> = {}): CommentDTO {
  return {
    id: 1,
    authorName: "Dev Admin",
    authorKind: "admin",
    body: "hi",
    createdAt: "2026-06-10T12:00:00.000Z",
    resolvedAt: null,
    ...over,
  };
}

describe("authorChip", () => {
  it("admin → admin kind, name label", () => {
    expect(authorChip(c({ authorKind: "admin", authorName: "Lucas" }))).toEqual({
      label: "Lucas",
      kind: "admin",
    });
  });
  it("member → member kind", () => {
    expect(authorChip(c({ authorKind: "member", authorName: "Bob" })).kind).toBe("member");
  });
  it("link:<label> → link kind with the embedded label", () => {
    expect(authorChip({ authorKind: "link:Microsoft", authorName: "Microsoft" })).toEqual({
      label: "Microsoft",
      kind: "link",
    });
  });
  it("link: with empty label falls back to authorName", () => {
    expect(authorChip({ authorKind: "link:", authorName: "Fallback" }).label).toBe("Fallback");
  });
  it("unknown kind degrades to member styling", () => {
    expect(authorChip({ authorKind: "weird", authorName: "X" }).kind).toBe("member");
  });
  it("does not interpret the label as markup (data passthrough)", () => {
    const chip = authorChip({ authorKind: "link:<b>x</b>", authorName: "n" });
    expect(chip.label).toBe("<b>x</b>"); // raw string; the island renders it as text
  });
});

describe("commentStamp", () => {
  it("formats ISO to YYYY-MM-DD HH:MM UTC", () => {
    expect(commentStamp("2026-06-10T12:34:56.000Z")).toBe("2026-06-10 12:34");
  });
  it("passes through an unparseable value", () => {
    expect(commentStamp("not-a-date")).toBe("not-a-date");
  });
});

describe("groupThread", () => {
  it("splits open vs resolved, preserving order", () => {
    const thread = [
      c({ id: 1, body: "a" }),
      c({ id: 2, body: "b", resolvedAt: "2026-06-10T13:00:00.000Z" }),
      c({ id: 3, body: "c" }),
      c({ id: 4, body: "d", resolvedAt: "2026-06-10T14:00:00.000Z" }),
    ];
    const g = groupThread(thread);
    expect(g.open.map((x) => x.body)).toEqual(["a", "c"]);
    expect(g.resolved.map((x) => x.body)).toEqual(["b", "d"]);
    expect(g.resolvedCount).toBe(2);
  });

  it("treats absent resolvedAt as open (public projection)", () => {
    const thread = [
      { id: 1, authorName: "A", authorKind: "link:A", body: "x", createdAt: "2026-06-10T12:00:00.000Z" },
    ];
    const g = groupThread(thread);
    expect(g.open).toHaveLength(1);
    expect(g.resolvedCount).toBe(0);
  });

  it("empty thread → empty groups", () => {
    const g = groupThread([]);
    expect(g.open).toHaveLength(0);
    expect(g.resolved).toHaveLength(0);
    expect(g.resolvedCount).toBe(0);
  });
});
