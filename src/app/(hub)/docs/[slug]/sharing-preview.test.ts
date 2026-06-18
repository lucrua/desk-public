import { describe, it, expect } from "vitest";
import { visibilityPreview } from "./sharing-preview";

describe("visibilityPreview (Sharing panel live preview)", () => {
  it("member-visible → 'all members' regardless of membership", () => {
    expect(visibilityPreview({ memberVisible: true, memberNames: [] })).toBe("all members");
    expect(visibilityPreview({ memberVisible: true, memberNames: ["Bob"] })).toBe("all members");
  });

  it("hidden + no members → 'only you'", () => {
    expect(visibilityPreview({ memberVisible: false, memberNames: [] })).toBe("only you");
  });

  it("hidden + one member → 'you + Bob'", () => {
    expect(visibilityPreview({ memberVisible: false, memberNames: ["Bob"] })).toBe("you + Bob");
  });

  it("hidden + several members → 'you + Bob, Sam'", () => {
    expect(visibilityPreview({ memberVisible: false, memberNames: ["Bob", "Sam"] })).toBe(
      "you + Bob, Sam",
    );
  });
});
